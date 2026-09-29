# In-cluster platform: Argo CD (GitOps), Argo Rollouts (canary + auto-rollback),
# kube-prometheus-stack (Prometheus/Grafana/Alertmanager), metrics-server (HPA),
# plus the ALB IngressClass and app secrets. App workloads themselves are synced by Argo CD from deploy/.

locals {
  kube_exec = {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.region]
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = local.kube_exec.api_version
    command     = local.kube_exec.command
    args        = local.kube_exec.args
  }
}

provider "helm" {
  kubernetes = {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec                   = local.kube_exec
  }
}

# ALB IngressClass (Auto Mode), default gp3 StorageClass, shared ingresses for Argo CD + Grafana.
resource "helm_release" "platform" {
  name      = "platform"
  chart     = "${path.module}/../deploy/platform"
  namespace = "kube-system"
  replace   = true # take over a release left in "failed" state by an earlier run
  # Its ingresses live in the argocd / monitoring / argo-rollouts namespaces those releases create.
  depends_on = [helm_release.argocd, helm_release.monitoring, helm_release.argo_rollouts]
}

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  namespace  = "kube-system"
  depends_on = [module.eks]
}

resource "random_password" "grafana" {
  length  = 20
  special = false
}

resource "helm_release" "monitoring" {
  name             = "kps"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  namespace        = "monitoring"
  create_namespace = true
  timeout          = 900
  values = [yamlencode({
    prometheus = {
      prometheusSpec = {
        # Pick up ServiceMonitors/PodMonitors/rules from any namespace (our chart ships them).
        serviceMonitorSelectorNilUsesHelmValues = false
        podMonitorSelectorNilUsesHelmValues     = false
        ruleSelectorNilUsesHelmValues           = false
        retention                               = "2d"
        # Tempo's metrics-generator remote-writes service-graph + span metrics here.
        enableRemoteWriteReceiver = true
        # Keep OTel histogram exemplars so a latency point links straight to its trace.
        enableFeatures = ["exemplar-storage"]
      }
    }
    grafana = {
      adminPassword = random_password.grafana.result
      "grafana.ini" = {
        server = { root_url = "%(protocol)s://%(domain)s/grafana", serve_from_sub_path = true }
      }
      sidecar = {
        dashboards = { enabled = true, searchNamespace = "ALL" }
        # Default Prometheus datasource (uid "prometheus"): exemplar trace_id -> Tempo.
        datasources = { exemplarTraceIdDestinations = { datasourceUid = "tempo", traceIdLabelName = "trace_id" } }
      }
      # One place for every observability datasource, cross-linked:
      # metrics <-> traces <-> logs, plus the Tempo service map.
      additionalDataSources = [
        {
          name   = "Tempo"
          uid    = "tempo"
          type   = "tempo"
          access = "proxy"
          url    = "http://tempo.monitoring.svc:3200"
          jsonData = {
            nodeGraph  = { enabled = true }
            serviceMap = { datasourceUid = "prometheus" }
            search     = { hide = false }
            lokiSearch = { datasourceUid = "loki" }
            tracesToLogsV2 = {
              datasourceUid      = "loki"
              spanStartTimeShift = "-2m"
              spanEndTimeShift   = "2m"
              customQuery        = true
              query              = "{k8s_namespace_name=\"fuelops\"} |= \"$${__trace.traceId}\""
            }
            tracesToMetrics = {
              datasourceUid = "prometheus"
              tags          = [{ key = "service.name", value = "service" }]
              queries = [
                { name = "Request rate", query = "sum(rate(traces_spanmetrics_calls_total{$__tags}[5m]))" },
                { name = "p95 latency", query = "histogram_quantile(0.95, sum by (le) (rate(traces_spanmetrics_latency_bucket{$__tags}[5m])))" },
              ]
            }
          }
        },
        {
          name   = "Loki"
          uid    = "loki"
          type   = "loki"
          access = "proxy"
          url    = "http://loki.monitoring.svc:3100"
          jsonData = {
            derivedFields = [{
              name          = "TraceID"
              matcherRegex  = "\"trace_id\":\"(\\w+)\""
              url           = "$${__value.raw}"
              datasourceUid = "tempo"
            }]
          }
        },
      ]
    }
  })]
  depends_on = [module.eks]
}

# Grafana Tempo (single-binary) as the trace backend. The fuelops OTel collector forwards
# spans here over OTLP; Grafana (from kube-prometheus-stack) queries it via the Tempo datasource
# our chart ships. Storage is the chart's default local filesystem: fine for the event, ephemeral.
resource "helm_release" "tempo" {
  name       = "tempo"
  repository = "https://grafana.github.io/helm-charts"
  chart      = "tempo"
  namespace  = "monitoring"
  values = [yamlencode({
    tempo = {
      receivers = {
        otlp = {
          protocols = {
            grpc = { endpoint = "0.0.0.0:4317" }
            http = { endpoint = "0.0.0.0:4318" }
          }
        }
      }
      # Service graph + RED span metrics -> Prometheus (powers Grafana's service map).
      metricsGenerator = {
        enabled        = true
        remoteWriteUrl = "http://kps-kube-prometheus-stack-prometheus.monitoring.svc:9090/api/v1/write"
      }
      overrides = { defaults = { metrics_generator = { processors = ["service-graphs", "span-metrics"] } } }
    }
  })]
  depends_on = [helm_release.monitoring]
}

# Grafana Loki (single binary, filesystem on a gp3 PVC) for logs, fed over OTLP by the collector below.
resource "helm_release" "loki" {
  name       = "loki"
  repository = "https://grafana.github.io/helm-charts"
  chart      = "loki"
  namespace  = "monitoring"
  timeout    = 900
  values = [yamlencode({
    deploymentMode = "SingleBinary"
    loki = {
      auth_enabled = false
      commonConfig = { replication_factor = 1 }
      storage      = { type = "filesystem" }
      schemaConfig = { configs = [{
        from  = "2024-04-01", store = "tsdb", object_store = "filesystem", schema = "v13"
        index = { prefix = "loki_index_", period = "24h" }
      }] }
      limits_config    = { allow_structured_metadata = true, volume_enabled = true, retention_period = "48h" }
      pattern_ingester = { enabled = true }
    }
    singleBinary = { replicas = 1, persistence = { enabled = true, size = "10Gi" } }
    backend      = { replicas = 0 }
    read         = { replicas = 0 }
    write        = { replicas = 0 }
    gateway      = { enabled = false }
    chunksCache  = { enabled = false }
    resultsCache = { enabled = false }
    lokiCanary   = { enabled = false }
    test         = { enabled = false }
    minio        = { enabled = false }
  })]
  depends_on = [helm_release.monitoring, helm_release.platform]
}

# Node-level OTel Collector: tails pod logs (fuelops + delivery namespaces), adds k8s metadata,
# ships them to Loki over OTLP. App traces/metrics keep using the in-namespace collector.
resource "helm_release" "otel_logs" {
  name       = "otel-logs"
  repository = "https://open-telemetry.github.io/opentelemetry-helm-charts"
  chart      = "opentelemetry-collector"
  namespace  = "monitoring"
  values = [yamlencode({
    mode  = "daemonset"
    image = { repository = "otel/opentelemetry-collector-k8s" }
    presets = {
      logsCollection       = { enabled = true }
      kubernetesAttributes = { enabled = true }
    }
    config = {
      receivers = {
        filelog = { include = ["/var/log/pods/fuelops_*/*/*.log", "/var/log/pods/argocd_*/*/*.log", "/var/log/pods/argo-rollouts_*/*/*.log"] }
      }
      exporters = { "otlphttp/loki" = { endpoint = "http://loki.monitoring.svc:3100/otlp" } }
      service = {
        pipelines = {
          logs    = { exporters = ["otlphttp/loki"] }
          traces  = null
          metrics = null
        }
      }
    }
  })]
  depends_on = [helm_release.loki]
}

resource "helm_release" "argo_rollouts" {
  name             = "argo-rollouts"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-rollouts"
  namespace        = "argo-rollouts"
  create_namespace = true
  values = [yamlencode({
    dashboard  = { enabled = true }
    controller = { metrics = { enabled = true, serviceMonitor = { enabled = true } } }
  })]
  depends_on = [module.eks, helm_release.monitoring]
}

resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  namespace        = "argocd"
  create_namespace = true
  timeout          = 900
  values = [yamlencode({
    controller = { metrics = { enabled = true, serviceMonitor = { enabled = true } } }
    server     = { metrics = { enabled = true, serviceMonitor = { enabled = true } } }
    configs = {
      params = {
        "server.insecure" = true
      }
      # Argo CD reads the private repo with a read-only deploy key.
      repositories = {
        fuelops = {
          url           = "git@github.com:${var.github_repo}.git"
          sshPrivateKey = tls_private_key.argocd.private_key_openssh
        }
      }
    }
  })]
  depends_on = [module.eks, helm_release.monitoring]
}

# App secrets. ponytail: values sit in (encrypted) TF state; use External Secrets if this outlives the event.
resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "kubernetes_namespace" "fuelops" {
  metadata { name = "fuelops" }
  depends_on = [module.eks]
}

resource "kubernetes_secret" "fuelops_env" {
  metadata {
    name      = "fuelops-env"
    namespace = kubernetes_namespace.fuelops.metadata[0].name
  }
  data = {
    DATABASE_URL     = "postgres://${aws_db_instance.this.username}:${random_password.db.result}@${aws_db_instance.this.address}:5432/${aws_db_instance.this.db_name}?sslmode=require"
    TYPESAFE_API_KEY = var.typesafe_api_key
    SEED_USERS       = var.seed_users
    JWT_SECRET       = random_password.jwt.result
  }
}

# Root Argo CD Application: syncs the fuelops chart from git (CI bumps image tags there).
resource "helm_release" "argocd_apps" {
  name       = "argocd-apps"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-apps"
  namespace  = "argocd"
  values = [yamlencode({
    applications = {
      fuelops = {
        namespace = "argocd"
        project   = "default"
        source = {
          repoURL        = "git@github.com:${var.github_repo}.git"
          targetRevision = var.git_revision
          path           = "deploy/charts/fuelops"
          helm           = { valueFiles = ["values.yaml"] }
        }
        destination = { server = "https://kubernetes.default.svc", namespace = "fuelops" }
        syncPolicy = {
          automated   = { prune = true, selfHeal = true }
          syncOptions = ["CreateNamespace=false", "RespectIgnoreDifferences=true"]
        }
        # Argo Rollouts rewrites canary/stable Service selectors mid-rollout; don't let selfHeal fight it.
        ignoreDifferences = [{ group = "", kind = "Service", jsonPointers = ["/spec/selector"] }]
      }
    }
  })]
  depends_on = [helm_release.argocd, helm_release.argo_rollouts, helm_release.monitoring, kubernetes_secret.fuelops_env]
}
