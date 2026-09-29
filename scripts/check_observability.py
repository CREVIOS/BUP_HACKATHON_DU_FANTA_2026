#!/usr/bin/env python3
"""Check the rendered tracing path using real chart packages and a mock TF plan.

Requires initialized Terraform providers, Helm, and requirements-infra.txt.
Downloads the pinned observability Helm packages; never contacts AWS or Kubernetes.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit

import yaml

from check_bootstrap_charts import APP, ROOT, SHA, check_https, helm


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def resource(docs, kind, name):
    matches = [doc for doc in docs if doc.get("kind") == kind and doc["metadata"]["name"] == name]
    require(len(matches) == 1, f"Expected exactly one {kind}/{name}, found {len(matches)}")
    return matches[0]


def mock_releases(infra_dir):
    result = subprocess.run(
        [os.environ.get("TERRAFORM", "terraform"), f"-chdir={infra_dir}", "test",
         "-filter=tests/observability.tftest.hcl", "-json", "-verbose"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    resources = {}
    for line in result.stdout.splitlines():
        event = json.loads(line)
        if event.get("type") in ("diagnostic", "test_summary"):
            print(event.get("@message", ""))
        if event.get("type") == "test_plan" and event.get("@testrun") == "observability_contract":
            resources = {
                item["address"]: item["change"]["after"]
                for item in event["test_plan"]["resource_changes"]
            }
    require(result.returncode == 0, f"Mock Terraform plan failed: {result.stderr}")
    return {name: resources[f"helm_release.{name}"] for name in ("monitoring", "tempo", "loki", "otel_logs", "platform")}


def chart_package(release, locked, cache):
    for key in ("repository", "chart", "version"):
        require(release[key] == locked[key], f"{release['name']} {key} differs from chart lock; review the package and update both pins")
    package = cache / f"{release['chart']}-{release['version']}.tgz"
    if not package.exists():
        helm("pull", release["chart"], "--repo", release["repository"],
             "--version", release["version"], "--destination", str(cache))
    require(hashlib.sha256(package.read_bytes()).hexdigest() == locked["sha256"],
            f"Checksum mismatch for {package.name}")
    return package


def render(name, chart, namespace, *extra):
    output = helm("template", name, str(chart), "--namespace", namespace,
                  "--kube-version", "1.36.0", *extra)
    # BaseLoader keeps scalars as strings and also handles bare '=' in upstream CRDs.
    return [doc for doc in yaml.load_all(output, Loader=yaml.BaseLoader) if doc]


def ports_match(service, workload, expected):
    template = workload["spec"]["template"]
    require(all(template["metadata"]["labels"].get(k) == v for k, v in service["spec"]["selector"].items()),
            f"{service['metadata']['name']} selector misses its Pods")
    container_ports = {
        port["name"]: int(port["containerPort"])
        for container in template["spec"]["containers"] for port in container.get("ports", [])
    }
    for number in expected:
        matches = [port for port in service["spec"]["ports"] if int(port["port"]) == number]
        require(len(matches) == 1, f"{service['metadata']['name']} does not expose {number}")
        target = matches[0].get("targetPort", str(number))
        resolved = int(target) if target.isdigit() else container_ports.get(target)
        require(resolved == number and number in container_ports.values(),
                f"{service['metadata']['name']} port {number} misses its container listener")


def check_enabled(app, tempo, monitoring, tempo_namespace):
    collector = resource(app, "Deployment", "otel-collector")
    collector_service = resource(app, "Service", "otel-collector")
    ports_match(collector_service, collector, (4317, 4318, 8889))
    config = yaml.safe_load(resource(app, "ConfigMap", "otel-collector")["data"]["collector.yaml"])
    protocols = config["receivers"]["otlp"]["protocols"]
    require(protocols["grpc"]["endpoint"] == "0.0.0.0:4317" and
            protocols["http"]["endpoint"] == "0.0.0.0:4318", "Collector receiver ports changed")
    require(config["exporters"]["prometheus"]["endpoint"] == "0.0.0.0:8889", "Collector metrics listener changed")
    require(config["exporters"]["prometheus"]["enable_open_metrics"], "Collector must retain main's exemplar support")
    require(config["service"]["pipelines"]["traces"]["exporters"] == ["otlp/tempo"] and
            config["service"]["pipelines"]["metrics"]["exporters"] == ["prometheus"], "Collector pipeline exporters are disconnected")

    tempo_service = resource(tempo, "Service", "tempo")
    tempo_pods = resource(tempo, "StatefulSet", "tempo")
    ports_match(tempo_service, tempo_pods, (4317, 4318, 3200))
    tempo_host = f"{tempo_service['metadata']['name']}.{tempo_namespace}.svc"
    require(config["exporters"]["otlp/tempo"]["endpoint"] == f"{tempo_host}:4317", "Collector exports to the wrong Tempo Service")
    tempo_config = yaml.safe_load(resource(tempo, "ConfigMap", "tempo")["data"]["tempo.yaml"])
    require(tempo_config["distributor"]["receivers"]["otlp"]["protocols"] == protocols,
            "Tempo's OTLP listeners do not match the advertised ports")
    require(tempo_config["server"]["http_listen_port"] == 3200, "Tempo query listener differs from its Service")
    require(not tempo_pods["spec"].get("volumeClaimTemplates"), "Demo Tempo unexpectedly requires a PVC")
    prometheus_name = "kps-kube-prometheus-stack-prometheus"
    prometheus = resource(monitoring, "Prometheus", prometheus_name)["spec"]
    resource(monitoring, "Service", prometheus_name)
    require(prometheus["enableRemoteWriteReceiver"] == "true" and "exemplar-storage" in prometheus["enableFeatures"],
            "Prometheus must accept Tempo metrics and retain exemplars")
    require(tempo_config["metrics_generator"]["storage"]["remote_write"][0]["url"] ==
            f"http://{prometheus_name}.monitoring.svc:9090/api/v1/write", "Tempo remote write misses Prometheus")
    require(set(tempo_config["overrides"]["defaults"]["metrics_generator"]["processors"]) == {"service-graphs", "span-metrics"},
            "Tempo service-map/span-metric generation is disabled")

    for kind, name in (("Rollout", "api"), ("Rollout", "intel"), ("Deployment", "ingestor")):
        pod = resource(app, kind, name)["spec"]["template"]["spec"]
        env = {item["name"]: item.get("value") for item in pod["containers"][0]["env"]}
        endpoint = urlsplit(env["OTEL_EXPORTER_OTLP_ENDPOINT"])
        require(endpoint.scheme == "http" and endpoint.hostname == "otel-collector.fuelops.svc" and endpoint.port == 4317,
                f"{name} does not export to the Collector Service")
        require(env["OTEL_EXPORTER_OTLP_PROTOCOL"] == "grpc", f"{name} protocol differs from its endpoint")

    monitor = resource(app, "PodMonitor", "otel-collector")
    require(monitor["spec"]["selector"]["matchLabels"] == collector_service["spec"]["selector"],
            "Collector PodMonitor selects different Pods")
    require(monitor["spec"]["podMetricsEndpoints"][0]["port"] == "metrics", "Collector PodMonitor misses the metrics port")

    require(not any(doc["metadata"]["name"] == "fuelops-tempo-datasource" for doc in app),
            "The app must not provision a duplicate Tempo datasource")
    datasource_cm = resource(monitoring, "ConfigMap", "kps-kube-prometheus-stack-grafana-datasource")
    datasources = yaml.safe_load(datasource_cm["data"]["datasource.yaml"])["datasources"]
    uids = [datasource["uid"] for datasource in datasources]
    require(len(uids) == len(set(uids)) and {"tempo", "loki", "prometheus"} <= set(uids),
            "Grafana must provision each linked datasource exactly once")
    by_uid = {datasource["uid"]: datasource for datasource in datasources}
    require(by_uid["tempo"]["type"] == "tempo" and by_uid["tempo"]["url"] == f"http://{tempo_host}:3200", "Grafana queries the wrong Tempo Service")
    require(by_uid["loki"]["type"] == "loki" and by_uid["loki"]["url"] == "http://loki.monitoring.svc:3100", "Grafana queries the wrong Loki Service")
    trace_links = by_uid["tempo"]["jsonData"]
    require(trace_links["serviceMap"]["datasourceUid"] == "prometheus" and
            trace_links["tracesToMetrics"]["datasourceUid"] == "prometheus" and
            trace_links["tracesToLogsV2"]["datasourceUid"] == "loki" and
            "${__trace.traceId}" in trace_links["tracesToLogsV2"]["query"], "Tempo's metric/log links were lost")
    require(by_uid["loki"]["jsonData"]["derivedFields"][0]["datasourceUid"] == "tempo" and
            by_uid["loki"]["jsonData"]["derivedFields"][0]["url"] == "${__value.raw}" and
            by_uid["prometheus"]["jsonData"]["exemplarTraceIdDestinations"][0]["datasourceUid"] == "tempo",
            "Log and exemplar links must target the Tempo datasource")
    grafana = resource(monitoring, "Deployment", "kps-grafana")["spec"]["template"]["spec"]
    sidecars = [container for container in grafana["containers"] if container["name"].endswith("-sc-datasources")]
    require(len(sidecars) == 1, "Grafana must have a datasource sidecar")
    sidecar_env = {item["name"]: item.get("value") for item in sidecars[0]["env"]}
    require(sidecar_env["NAMESPACE"] == "monitoring" and datasource_cm["metadata"]["namespace"] == "monitoring",
            "Grafana must discover the centrally managed datasources")
    require(sidecar_env["RESOURCE"] == "configmap" and
            datasource_cm["metadata"]["labels"].get(sidecar_env["LABEL"]) == sidecar_env["LABEL_VALUE"],
            "Grafana's sidecar does not select the Tempo datasource ConfigMap")
    bindings = [doc for doc in monitoring if doc["kind"] == "ClusterRoleBinding" and any(
        subject.get("kind") == "ServiceAccount" and subject.get("name") == grafana["serviceAccountName"] and
        subject.get("namespace") == "monitoring" for subject in doc.get("subjects", []))]
    require(any(any("configmaps" in rule.get("resources", []) and
                    {"get", "list", "watch"} <= set(rule.get("verbs", []))
                    for rule in resource(monitoring, "ClusterRole", binding["roleRef"]["name"])["rules"])
                for binding in bindings), "Grafana lacks ConfigMap discovery permissions")

    dashboard = resource(app, "ConfigMap", "fuelops-dashboards")
    require(json.loads(dashboard["data"]["fuelops-operations.json"])["panels"], "Main's operations dashboard is missing")
    dashboard_sidecar = next(container for container in grafana["containers"] if container["name"].endswith("-sc-dashboard"))
    dashboard_env = {item["name"]: item.get("value") for item in dashboard_sidecar["env"]}
    require(dashboard_env["NAMESPACE"] == "ALL" and
            dashboard["metadata"]["labels"].get(dashboard_env["LABEL"]) == dashboard_env["LABEL_VALUE"],
            "Grafana cannot discover the application's dashboard")

    for doc in tempo + monitoring:
        require(doc["kind"] not in ("Ingress", "HTTPRoute", "Gateway"), "Tracing must not publish an operator endpoint")
        if doc["kind"] == "Service":
            require(doc["spec"].get("type", "ClusterIP") == "ClusterIP", "Observability Service must remain private")


def check_disabled(app):
    require(not any(doc["metadata"]["name"] in ("otel-collector", "fuelops-tempo-datasource") for doc in app),
            "Disabled tracing still renders Collector/datasource resources")
    for kind, name in (("Rollout", "api"), ("Rollout", "intel"), ("Deployment", "ingestor")):
        env = resource(app, kind, name)["spec"]["template"]["spec"]["containers"][0]["env"]
        require(not any(item["name"].startswith("OTEL_") for item in env), f"{name} still enables OTel")
    resource(app, "PodMonitor", "fuelops")
    resource(app, "PrometheusRule", "fuelops")


def check_logs(loki, logs, platform):
    service = resource(loki, "Service", "loki")
    workload = resource(loki, "StatefulSet", "loki")
    ports_match(service, workload, (3100,))
    config = yaml.safe_load(resource(loki, "ConfigMap", "loki")["data"]["config.yaml"])
    require(config["server"]["http_listen_port"] == 3100 and config["limits_config"]["allow_structured_metadata"],
            "Loki's query/OTLP receiver configuration changed")
    require(config["schema_config"]["configs"][0]["schema"] == "v13", "Loki OTLP metadata needs the configured v13 schema")
    claim = workload["spec"]["volumeClaimTemplates"][0]["spec"]
    storage = resource(platform, "StorageClass", claim["storageClassName"])
    require(claim["resources"]["requests"]["storage"] == "10Gi" and storage["provisioner"] == "ebs.csi.eks.amazonaws.com",
            "Loki's PVC must use the platform's Auto Mode gp3 StorageClass")

    agent_name = "otel-logs-opentelemetry-collector-agent"
    agent = resource(logs, "DaemonSet", agent_name)["spec"]["template"]["spec"]
    relay = yaml.safe_load(resource(logs, "ConfigMap", agent_name)["data"]["relay"])
    require(set(relay["service"]["pipelines"]) == {"logs"}, "Node agent must only collect logs")
    pipeline = relay["service"]["pipelines"]["logs"]
    require(pipeline["exporters"] == ["otlp_http/loki"] and pipeline["receivers"] == ["file_log"] and
            "k8s_attributes" in pipeline["processors"], "Node logs must receive Kubernetes metadata and export to Loki")
    require(relay["exporters"]["otlp_http/loki"]["endpoint"] == "http://loki.monitoring.svc:3100/otlp",
            "Node agent exports to the wrong Loki endpoint")
    require(set(relay["receivers"]["file_log"]["include"]) == {
        "/var/log/pods/fuelops_*/*/*.log", "/var/log/pods/argocd_*/*/*.log", "/var/log/pods/argo-rollouts_*/*/*.log"
    }, "Log collection namespace scope changed")
    require(any(volume.get("hostPath", {}).get("path") == "/var/log/pods" for volume in agent["volumes"]),
            "Node agent cannot read Pod log files")
    require(not any(port.get("hostPort") for container in agent["containers"] for port in container.get("ports", [])),
            "The file-only node agent must not reserve receiver host ports")
    for doc in loki + logs:
        require(doc["kind"] not in ("Ingress", "HTTPRoute", "Gateway"), "Logging must not publish an operator endpoint")
        if doc["kind"] == "Service":
            require(doc["spec"].get("type", "ClusterIP") == "ClusterIP", "Logging Services must remain private")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--infra-dir", type=Path, default=ROOT / "infra")
    parser.add_argument("--chart-cache", type=Path, help="Reuse previously downloaded, checksum-verified chart packages")
    args = parser.parse_args()
    releases = mock_releases(args.infra_dir.resolve())
    locks = json.loads((ROOT / "scripts/observability-charts.lock.json").read_text())
    with tempfile.TemporaryDirectory(prefix="fuelops-observability-") as directory:
        scratch = Path(directory)
        cache = args.chart_cache.resolve() if args.chart_cache else scratch
        cache.mkdir(parents=True, exist_ok=True)
        manifests = {}
        for name in locks:
            release = releases[name]
            package = chart_package(release, locks[name], cache)
            value_files = []
            for index, contents in enumerate(release["values"]):
                path = scratch / f"{name}-{index}.yaml"
                path.write_text(contents)
                value_files.extend(["-f", str(path)])
            manifests[name] = render(release["name"], package, release["namespace"], *value_files)
        tags = ["--set-string", f"image.tag={SHA},web.tag={SHA}"]
        platform_values_file = scratch / "platform.yaml"
        platform_values_file.write_text(releases["platform"]["values"][0])
        platform_values = yaml.safe_load(platform_values_file.read_text())
        platform = render("platform", "deploy/platform", "kube-system", "-f", str(platform_values_file))
        app = render("fuelops", APP, "fuelops", *tags)
        check_https(platform, app, platform_values["alb"]["certificateARNs"],
                    platform_values["argocd"]["ingress"]["hostname"])
        check_enabled(app, manifests["tempo"],
                      manifests["monitoring"], releases["tempo"]["namespace"])
        check_logs(manifests["loki"], manifests["otel_logs"], platform)
        check_disabled(render("fuelops", APP, "fuelops", *tags, "--set-string", "otel.endpoint="))
    print("Observability checks passed: pinned charts, trace/metric/log routing, unique linked datasources, dashboard discovery, Loki storage, private Services, tracing enabled/disabled.")


if __name__ == "__main__":
    main()
