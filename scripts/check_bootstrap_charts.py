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


def check_api_auth(app):
    api_found = False
    for workload in app:
        if workload["kind"] not in ("Rollout", "Deployment", "StatefulSet", "DaemonSet", "Job"):
            continue
        pod = workload["spec"]["template"]["spec"]
        for container in pod.get("containers", []) + pod.get("initContainers", []):
            env_list = container.get("env", [])
            env = {item["name"]: item for item in env_list}
            if any(item.get("secretRef", {}).get("name") == "fuelops-auth" for item in container.get("envFrom", [])):
                raise AssertionError("Bearer tokens must use explicit required keys, never bulk envFrom")
            if workload["kind"] == "Rollout" and workload["metadata"]["name"] == "api" and container["name"] == "api":
                api_found = True
                if len(env) != len(env_list) or env.get("REQUIRE_AUTH") != {"name": "REQUIRE_AUTH", "value": "true"}:
                    raise AssertionError("API authentication must be required without duplicate environment overrides")
                for key in ("OPERATOR_TOKEN", "ADMIN_TOKEN"):
                    if env.get(key) != {"name": key, "valueFrom": {"secretKeyRef": {
                        "name": "fuelops-auth", "key": key, "optional": "false",
                    }}}:
                        raise AssertionError(f"API must require fuelops-auth/{key}")
            elif any(key in env for key in ("OPERATOR_TOKEN", "ADMIN_TOKEN", "REQUIRE_AUTH")) or any(
                item.get("valueFrom", {}).get("secretKeyRef", {}).get("name") == "fuelops-auth" for item in env_list
            ):
                raise AssertionError("Only the API may receive bearer tokens")
    if not api_found:
        raise AssertionError("API workload missing from authentication check")


def check_https(platform, app, certificates, argocd_hostname=None, grafana_enabled=False):
    check_api_auth(app)
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
    expected_ingresses = ({"argocd"} if argocd_hostname else set()) | ({"grafana"} if grafana_enabled else set())
    require(len(platform_ingresses) == len(expected_ingresses) and
            {doc["metadata"]["name"] for doc in platform_ingresses} == expected_ingresses,
            "Only explicitly enabled operator UIs may have platform ingresses")
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
        "/api": {"name": "api", "port": {"number": "8000"}},
        "/": {"name": "web", "port": {"number": "80"}},
    }, "Preserve API and frontend host routing")
    web = next(doc for doc in app if doc["kind"] == "Deployment" and doc["metadata"]["name"] == "web")
    web_env = {item["name"]: item.get("value") for item in web["spec"]["template"]["spec"]["containers"][0]["env"]}
    require(web_env.get("API_PROXY_TARGET") == "http://api:8000",
            "Server-side frontend routes must reach the Kubernetes API Service port")
    for name in ("api", "api-canary", "api-stable"):
        service = next(doc for doc in app if doc["kind"] == "Service" and doc["metadata"]["name"] == name)
        require(service["spec"]["ports"] == [{"name": "http", "port": "8000", "targetPort": "http"}],
                f"{name} must route port 8000 to the API's named HTTP port")
    api = next(doc for doc in app if doc["kind"] == "Rollout" and doc["metadata"]["name"] == "api")
    api_container = api["spec"]["template"]["spec"]["containers"][0]
    api_env = {item["name"]: item.get("value") for item in api_container["env"]}
    require(api_container["ports"] == [{"name": "http", "containerPort": "8000"}] and
            api_env.get("HTTP_ADDR") == ":8000",
            "The API must listen on the port selected by its Services")
    if argocd_hostname:
        ingress = next(doc for doc in platform_ingresses if doc["metadata"]["name"] == "argocd")
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
    if grafana_enabled:
        ingress = next(doc for doc in platform_ingresses if doc["metadata"]["name"] == "grafana")
        annotations = ingress["metadata"]["annotations"]
        rule = ingress["spec"]["rules"][0]
        require(ingress["metadata"]["namespace"] == "monitoring" and rule["host"] == fuelops_rule["host"],
                "Grafana must share the FuelOps hostname/certificate and target its monitoring namespace")
        require(rule["http"]["paths"] == [{"path": "/grafana", "pathType": "Prefix", "backend": {
            "service": {"name": "kps-grafana", "port": {"number": "80"}},
        }}], "Grafana must preserve its subpath and target the correct Service")
        require(int(annotations["alb.ingress.kubernetes.io/group.order"]) <
                int(app_ingresses[0]["metadata"]["annotations"]["alb.ingress.kubernetes.io/group.order"]),
                "Grafana's route must precede the application's catch-all")
        require(annotations["alb.ingress.kubernetes.io/backend-protocol"] == "HTTP" and
                annotations["alb.ingress.kubernetes.io/healthcheck-protocol"] == "HTTP" and
                annotations["alb.ingress.kubernetes.io/healthcheck-path"] == "/grafana/api/health",
                "Grafana health checks must use its subpath over the in-cluster HTTP Service")


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
    for argocd_enabled in (False, True):
        public_platform = documents(helm("template", "platform", "deploy/platform", "--namespace", "kube-system",
                                         *certs, "--set", "grafana.ingress.enabled=true",
                                         "--set", f"argocd.ingress.enabled={str(argocd_enabled).lower()}"))
        check_https(public_platform, app, CERTIFICATES, "argocd.hemal.me" if argocd_enabled else None, True)
    helm("template", "platform", "deploy/platform", expected_error="/alb/certificateARNs")
    for invalid in (["not-an-arn"], [CERTIFICATES[0], CERTIFICATES[0]]):
        helm("template", "platform", "deploy/platform", "--set-json", f"alb.certificateARNs={json.dumps(invalid)}",
             expected_error="/alb/certificateARNs")
    for hostname in ("", "*.hemal.me", "https://fuelops.hemal.me", "fuelops.hemal.me/path"):
        helm("template", "fuelops", APP, *valid_tags, "--set-string", f"ingress.hostname={hostname}",
             expected_error="/ingress/hostname")
        helm("template", "platform", "deploy/platform", *certs,
             "--set-string", f"argocd.ingress.hostname={hostname}", expected_error="/argocd/ingress/hostname")

    for key in ("REQUIRE_AUTH", "OPERATOR_TOKEN", "ADMIN_TOKEN"):
        helm("template", "fuelops", APP, *valid_tags, "--set-string", f"api.env.{key}=false",
             expected_error=f"invalid propertyName '{key}'")

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

    print("Bootstrap chart checks passed: required API-only tokens, protected auth settings, SNI certificates, HTTPS routing/redirects, public/private Argo CD and Grafana, invalid certificates/hostnames/images rejected.")


if __name__ == "__main__":
    main()
