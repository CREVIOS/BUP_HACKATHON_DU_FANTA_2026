#!/usr/bin/env python3
"""Check HTTPS routing, ingress opt-out, and release-image validation offline."""

import json
import os
from pathlib import Path
import subprocess

import yaml


ROOT = Path(__file__).resolve().parents[1]
HELM = os.environ.get("HELM", "helm")
SHA = "0123456789abcdef0123456789abcdef01234567"
APP = "deploy/charts/fuelops"
CERTIFICATES = [
    "arn:aws:acm:ap-southeast-1:123456789012:certificate/11111111-1111-1111-1111-111111111111",
    "arn:aws:acm:ap-southeast-1:123456789012:certificate/22222222-2222-2222-2222-222222222222",
]


def helm(*args, expected_error=None):
    result = subprocess.run(
        [HELM, *args], cwd=ROOT, capture_output=True, text=True, check=False
    )
    if expected_error is not None:
        if result.returncode == 0 or expected_error not in result.stderr:
            raise AssertionError(
                f"Expected schema rejection containing {expected_error!r}:\n"
                f"{result.stdout}{result.stderr}"
            )
    elif result.returncode != 0:
        raise RuntimeError(f"helm {' '.join(args)}:\n{result.stdout}{result.stderr}")
    return result.stdout


def documents(output):
    return [doc for doc in yaml.load_all(output, Loader=yaml.BaseLoader) if doc]


def check_https(platform, app, certificates, argocd_hostname=None):
    def require(condition, message):
        if not condition:
            raise AssertionError(message)

    classes = [doc for doc in platform if doc["kind"] == "IngressClassParams"]
    require(len(classes) == 1 and classes[0]["apiVersion"] == "eks.amazonaws.com/v1",
            "Use exactly one EKS Auto Mode ALB configuration")
    require(classes[0]["spec"]["certificateARNs"] == certificates and
            classes[0]["spec"]["sslPolicy"] == "ELBSecurityPolicy-TLS13-1-2-2021-06",
            "The shared ALB must retain both SNI certificates and its TLS policy")
    ingress_classes = [doc for doc in platform if doc["kind"] == "IngressClass"]
    require(len(ingress_classes) == 1 and ingress_classes[0]["metadata"]["name"] == "alb" and
            ingress_classes[0]["spec"]["controller"] == "eks.amazonaws.com/alb" and
            ingress_classes[0]["spec"]["parameters"]["name"] == classes[0]["metadata"]["name"],
            "Both ingresses must resolve to the same Auto Mode class and certificates")
    require(not any(doc["kind"] in ("HTTPRoute", "Gateway") for doc in platform + app),
            "Unexpected alternative public route")
    platform_ingresses = [doc for doc in platform if doc["kind"] == "Ingress"]
    require(len(platform_ingresses) == (1 if argocd_hostname else 0),
            "Only explicitly enabled Argo CD may have a platform ingress")
    app_ingresses = [doc for doc in app if doc["kind"] == "Ingress"]
    require(len(app_ingresses) == 1, "The application must publish exactly one ingress")
    for ingress in platform_ingresses + app_ingresses:
        annotations = ingress["metadata"]["annotations"]
        require(ingress["spec"]["ingressClassName"] == "alb" and
                json.loads(annotations["alb.ingress.kubernetes.io/listen-ports"]) == [{"HTTP": 80}, {"HTTPS": 443}] and
                annotations["alb.ingress.kubernetes.io/ssl-redirect"] == "443",
                "Every public ingress must expose HTTPS and redirect HTTP")
        require(len(ingress["spec"]["rules"]) == 1 and ingress["spec"]["rules"][0].get("host"),
                "Hostless rules must not bypass the configured public hostname")
    fuelops_rule = app_ingresses[0]["spec"]["rules"][0]
    require(fuelops_rule["host"] == "fuelops.hemal.me", "FuelOps must use its configured hostname")
    require({path["path"]: path["backend"]["service"] for path in fuelops_rule["http"]["paths"]} == {
        "/api": {"name": "api", "port": {"number": "8080"}},
        "/": {"name": "web", "port": {"number": "80"}},
    }, "Preserve API and frontend host routing")
    if argocd_hostname:
        ingress = platform_ingresses[0]
        annotations = ingress["metadata"]["annotations"]
        rule = ingress["spec"]["rules"][0]
        require(ingress["metadata"]["namespace"] == "argocd" and rule["host"] == argocd_hostname,
                "Argo CD ingress must select its namespace and hostname")
        require(annotations["alb.ingress.kubernetes.io/backend-protocol"] == "HTTPS" and
                annotations["alb.ingress.kubernetes.io/healthcheck-protocol"] == "HTTPS" and
                annotations["alb.ingress.kubernetes.io/healthcheck-path"] == "/healthz",
                "Argo CD forwarding and health checks must use HTTPS")
        require(rule["http"]["paths"] == [{"path": "/", "pathType": "Prefix", "backend": {
            "service": {"name": "argocd-server", "port": {"number": "443"}},
        }}], "Argo CD ingress must use the TLS Service port")


def main():
    valid_tags = ["--set-string", f"image.tag={SHA},web.tag={SHA}"]
    certs = ["--set-json", f"alb.certificateARNs={json.dumps(CERTIFICATES)}"]
    helm("lint", "deploy/platform", *certs)
    platform = documents(helm("template", "platform", "deploy/platform", "--namespace", "kube-system", *certs))
    helm("lint", APP, *valid_tags)
    app = documents(helm("template", "fuelops", APP, "--namespace", "fuelops", *valid_tags))
    check_https(platform, app, CERTIFICATES)
    public_platform = documents(helm("template", "platform", "deploy/platform", "--namespace", "kube-system",
                                     *certs, "--set", "argocd.ingress.enabled=true"))
    check_https(public_platform, app, CERTIFICATES, "argocd.hemal.me")
    helm("template", "platform", "deploy/platform", expected_error="/alb/certificateARNs")
    for invalid in (["not-an-arn"], [CERTIFICATES[0], CERTIFICATES[0]]):
        helm("template", "platform", "deploy/platform", "--set-json", f"alb.certificateARNs={json.dumps(invalid)}",
             expected_error="/alb/certificateARNs")
    for hostname in ("", "*.hemal.me", "https://fuelops.hemal.me", "fuelops.hemal.me/path"):
        helm("template", "fuelops", APP, *valid_tags, "--set-string", f"ingress.hostname={hostname}",
             expected_error="/ingress/hostname")
        helm("template", "platform", "deploy/platform", *certs,
             "--set-string", f"argocd.ingress.hostname={hostname}", expected_error="/argocd/ingress/hostname")

    # Exercise each image independently so updating only one tag cannot unblock sync.
    for image in ("image", "web"):
        for invalid_tag in ("bootstrap", "latest", "dev", "abcdef0", "", "a" * 39):
            helm(
                "template", "fuelops", APP, *valid_tags,
                "--set-string", f"{image}.tag={invalid_tag}",
                expected_error=f"/{image}/tag",
            )
        helm(
            "template", "fuelops", APP, *valid_tags,
            "--set-string", f"{image}.repository=", expected_error=f"/{image}/repository",
        )

    print("Bootstrap chart checks passed: SNI certificates, HTTPS host routing/redirects, public/private Argo CD, invalid certificates/hostnames/images rejected.")


if __name__ == "__main__":
    main()
