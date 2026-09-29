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
      }
    }
    grafana = {
      adminPassword = random_password.grafana.result
      "grafana.ini" = {
        server = { root_url = "%(protocol)s://%(domain)s/grafana", serve_from_sub_path = true }
      }
      sidecar = { dashboards = { enabled = true, searchNamespace = "ALL" } }
    }
  })]
  depends_on = [module.eks]
}

resource "helm_release" "argo_rollouts" {
  name             = "argo-rollouts"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-rollouts"
  namespace        = "argo-rollouts"
  create_namespace = true
  values = [yamlencode({
    dashboard = { enabled = true }
  })]
  depends_on = [module.eks]
}

resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  namespace        = "argocd"
  create_namespace = true
  timeout          = 900
  values = [yamlencode({
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
