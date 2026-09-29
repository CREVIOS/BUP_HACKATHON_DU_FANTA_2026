# Plan-only tests: every provider is mocked; no credentials or live cluster needed.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-southeast-1a", "ap-southeast-1b"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}
mock_provider "helm" { override_during = plan }
mock_provider "kubernetes" { override_during = plan }
mock_provider "github" { override_during = plan }
mock_provider "random" {
  override_during = plan
  mock_resource "random_password" {
    defaults = { result = "test-only-password-not-a-secret" }
  }
}
mock_provider "tls" {
  override_during = plan
  mock_resource "tls_private_key" {
    defaults = {
      private_key_openssh = "test-only-private-key-not-a-secret"
      public_key_openssh  = "ssh-ed25519 test-only-public-key"
    }
  }
}

override_module {
  target = module.vpc
  outputs = {
    vpc_id          = "vpc-00000000000000001"
    private_subnets = ["subnet-00000000000000001", "subnet-00000000000000002"]
  }
}

override_module {
  target = module.eks
  outputs = {
    cluster_name                       = "fuelops-test"
    cluster_endpoint                   = "https://eks.example.invalid"
    cluster_certificate_authority_data = "dGVzdA=="
    cluster_primary_security_group_id  = "sg-00000000000000001"
  }
}

run "bootstrap_keeps_application_disabled" {
  command = plan

  assert {
    condition     = length(yamldecode(helm_release.argocd_apps.values[0]).applications) == 0
    error_message = "A default bootstrap must not create an Argo Application or run migrations."
  }
  assert {
    condition     = !output.application_enabled
    error_message = "The bootstrap output must report that the application is disabled."
  }
  assert {
    condition = alltrue([
      for ns in [helm_release.argocd.namespace, helm_release.argo_rollouts.namespace, helm_release.monitoring.namespace] :
      contains([for item in kubernetes_namespace_v1.platform : item.metadata[0].name], ns)
    ])
    error_message = "Each namespaced platform release must use an explicitly managed namespace."
  }
}

run "application_enable_preserves_git_image_ownership" {
  command = plan
  variables {
    enable_application = true
    git_revision       = "tested-revision"
  }

  assert {
    condition     = output.application_enabled
    error_message = "The application must be explicitly enabled."
  }
  assert {
    condition     = toset(keys(yamldecode(helm_release.argocd_apps.values[0]).applications)) == toset(["fuelops"])
    error_message = "Enabling the application must declare exactly the fuelops Application."
  }
  assert {
    condition     = yamldecode(helm_release.argocd_apps.values[0]).applications.fuelops.source.targetRevision == "tested-revision"
    error_message = "The Application must track the configured Git revision."
  }
  assert {
    condition     = toset(keys(yamldecode(helm_release.argocd_apps.values[0]).applications.fuelops.source.helm)) == toset(["valueFiles"])
    error_message = "Terraform must not override image tags owned by the GitOps values file."
  }
}
