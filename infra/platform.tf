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

# Helm must not race to create namespaces used by another release's resources.
# Keep the existing fuelops namespace address below unchanged.
resource "kubernetes_namespace_v1" "platform" {
  for_each = toset(["argocd", "argo-rollouts", "monitoring"])
  metadata { name = each.key }
  depends_on = [module.eks]
}

# ALB IngressClass (Auto Mode) for application ingress and default gp3 StorageClass.
# The pinned controller releases use ephemeral storage, so they do not require this
# StorageClass to start. Keep the application gate downstream of controller readiness.
resource "helm_release" "platform" {
  name       = "platform"
  chart      = "${path.module}/../deploy/platform"
  namespace  = "kube-system"
  replace    = true # Preserve recovery of releases left in a failed state.
  depends_on = [helm_release.argocd, helm_release.argo_rollouts, helm_release.monitoring]
}

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.14.0"
  namespace  = "kube-system"
  depends_on = [module.eks]
}

resource "random_password" "grafana" {
  length  = 20
  special = false
}

resource "helm_release" "monitoring" {
  name       = "kps"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  version    = "91.8.1"
  namespace  = kubernetes_namespace_v1.platform["monitoring"].metadata[0].name
  timeout    = 900
  values = [yamlencode({
    prometheus = {
      prometheusSpec = {
        # Pick up ServiceMonitors/PodMonitors/rules from any namespace (our chart ships them).
        serviceMonitorSelectorNilUsesHelmValues = false
        podMonitorSelectorNilUsesHelmValues     = false
        ruleSelectorNilUsesHelmValues           = false
        retention                               = "2d"
      }
    }
    grafana = {
      adminPassword = random_password.grafana.result
      service       = { type = "ClusterIP" }
      ingress       = { enabled = false }
      "grafana.ini" = {
        server           = { root_url = "http://localhost:3000/", serve_from_sub_path = false }
        "auth.anonymous" = { enabled = false }
        users            = { allow_sign_up = false }
      }
      sidecar = { dashboards = { enabled = true, searchNamespace = "ALL" } }
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
    }
  })]
  depends_on = [helm_release.monitoring]
}

resource "helm_release" "argo_rollouts" {
  name       = "argo-rollouts"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-rollouts"
  version    = "2.43.2"
  namespace  = kubernetes_namespace_v1.platform["argo-rollouts"].metadata[0].name
  values = [yamlencode({
    dashboard = {
      enabled  = true
      readonly = true
      rootPath = "/"
      service  = { type = "ClusterIP" }
      ingress  = { enabled = false }
    }
  })]
  depends_on = [module.eks]
}

resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = "10.9.2"
  namespace  = kubernetes_namespace_v1.platform["argocd"].metadata[0].name
  timeout    = 900
  values = [yamlencode({
    server = {
      service = { type = "ClusterIP" }
      ingress = { enabled = false }
    }
    configs = {
      cm = {
        url                       = "https://localhost:8443"
        "admin.enabled"           = true
        "users.anonymous.enabled" = false
      }
      params = {
        "server.insecure" = false
        "server.basehref" = "/"
        "server.rootpath" = ""
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
  depends_on = [module.eks]
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

# Keep this release address stable. During bootstrap it contains no Applications;
# enabling it lets Argo render the git chart, whose schema rejects placeholder tags.
resource "helm_release" "argocd_apps" {
  name       = "argocd-apps"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-apps"
  version    = "2.0.5"
  namespace  = kubernetes_namespace_v1.platform["argocd"].metadata[0].name
  values = [yamlencode({
    applications = var.enable_application ? {
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
    } : {}
  })]
  depends_on = [helm_release.platform, helm_release.metrics_server, kubernetes_secret.fuelops_env]
}
