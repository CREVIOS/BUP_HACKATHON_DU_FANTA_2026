# One mock plan also supplies the actual Helm settings to check_observability.py.
# Every provider is mocked; no AWS credentials, cluster, or remote state is used.
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

run "observability_contract" {
  command = plan
  assert {
    condition     = helm_release.tempo.namespace == kubernetes_namespace_v1.platform["monitoring"].metadata[0].name
    error_message = "Tempo must use the explicitly managed monitoring namespace."
  }
  assert {
    condition = (
      !yamldecode(helm_release.tempo.values[0]).persistence.enabled &&
      yamldecode(helm_release.tempo.values[0]).service.type == "ClusterIP"
    )
    error_message = "The demo's trace backend must remain private with explicit ephemeral storage."
  }
}
