# Plan-only tests: every provider is mocked; no credentials or live cluster needed.
variables {
  github_oidc_subject = "repo:CREVIOS/BUP_HACKATHON_DU_FANTA_2026:ref:refs/heads/main"
}

mock_provider "aws" {
  override_during = plan
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-southeast-1a", "ap-southeast-1b"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_openid_connect_provider" {
    defaults = {
      url            = "token.actions.githubusercontent.com"
      client_id_list = ["sts.amazonaws.com", "another-existing-audience"]
    }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
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

run "operator_access_and_release_trust" {
  command = plan

  assert {
    condition = (
      yamldecode(helm_release.argocd.values[0]).server.service.type == "ClusterIP" &&
      !yamldecode(helm_release.argocd.values[0]).server.ingress.enabled &&
      !yamldecode(helm_release.argocd.values[0]).configs.params["server.insecure"] &&
      yamldecode(helm_release.argocd.values[0]).configs.params["server.basehref"] == "/" &&
      yamldecode(helm_release.argocd.values[0]).configs.params["server.rootpath"] == "" &&
      yamldecode(helm_release.argocd.values[0]).configs.cm["admin.enabled"] &&
      !yamldecode(helm_release.argocd.values[0]).configs.cm["users.anonymous.enabled"]
    )
    error_message = "Argo CD must use a private Service, TLS, root paths, and authenticated access."
  }
  assert {
    condition = (
      yamldecode(helm_release.monitoring.values[0]).grafana.service.type == "ClusterIP" &&
      !yamldecode(helm_release.monitoring.values[0]).grafana.ingress.enabled &&
      yamldecode(helm_release.monitoring.values[0]).grafana["grafana.ini"].server.root_url == "http://localhost:3000/" &&
      !yamldecode(helm_release.monitoring.values[0]).grafana["grafana.ini"].server.serve_from_sub_path &&
      !yamldecode(helm_release.monitoring.values[0]).grafana["grafana.ini"]["auth.anonymous"].enabled &&
      !yamldecode(helm_release.monitoring.values[0]).grafana["grafana.ini"].users.allow_sign_up
    )
    error_message = "Grafana must use localhost port-forward access with anonymous access and signup disabled."
  }
  assert {
    condition = (
      yamldecode(helm_release.argo_rollouts.values[0]).dashboard.readonly &&
      yamldecode(helm_release.argo_rollouts.values[0]).dashboard.service.type == "ClusterIP" &&
      !yamldecode(helm_release.argo_rollouts.values[0]).dashboard.ingress.enabled &&
      yamldecode(helm_release.argo_rollouts.values[0]).dashboard.rootPath == "/"
    )
    error_message = "The Rollouts dashboard must be private and read-only for workloads."
  }
  assert {
    condition = jsondecode(aws_iam_role.github_actions.assume_role_policy).Statement[0].Condition == {
      StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:CREVIOS/BUP_HACKATHON_DU_FANTA_2026:ref:refs/heads/main"
      }
    }
    error_message = "GitHub trust must match the exact main-branch subject and STS audience."
  }
}

run "immutable_github_subject" {
  command = plan
  variables {
    github_oidc_subject = "repo:CREVIOS@123456/BUP_HACKATHON_DU_FANTA_2026@456789:ref:refs/heads/main"
  }
  assert {
    condition     = jsondecode(aws_iam_role.github_actions.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == var.github_oidc_subject
    error_message = "Preserve the exact immutable subject, including both IDs, in the IAM policy."
  }
}

run "main_immutable_prefix_used_by_both_roles" {
  command = plan
  variables {
    github_oidc_subject = null
  }
  assert {
    condition = alltrue([
      for policy in [aws_iam_role.github_actions.assume_role_policy, aws_iam_role.terraform.assume_role_policy] :
      jsondecode(policy).Statement[0].Condition == {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:CREVIOS@48938983/BUP_HACKATHON_DU_FANTA_2026@1394116440:ref:refs/heads/main"
        }
      }
    ])
    error_message = "Both roles must preserve main's immutable identity and restrict it to the exact main branch."
  }
}

run "reject_wildcard_prefix" {
  command = plan
  variables {
    github_oidc_sub_prefix = "repo:CREVIOS/*"
  }
  expect_failures = [var.github_oidc_sub_prefix]
}

run "reject_wildcard_subject" {
  command = plan
  variables {
    github_oidc_subject = "repo:CREVIOS/BUP_HACKATHON_DU_FANTA_2026:*"
  }
  expect_failures = [var.github_oidc_subject]
}

run "reject_other_branch_subject" {
  command = plan
  variables {
    github_oidc_subject = "repo:CREVIOS/BUP_HACKATHON_DU_FANTA_2026:ref:refs/heads/infra/deployment-readiness"
  }
  expect_failures = [var.github_oidc_subject]
}

run "reject_other_repository_subject" {
  command = plan
  variables {
    github_oidc_subject = "repo:CREVIOS/other-repo:ref:refs/heads/main"
  }
  expect_failures = [var.github_oidc_subject]
}

run "reject_pull_request_subject" {
  command = plan
  variables {
    github_oidc_subject = "repo:CREVIOS/BUP_HACKATHON_DU_FANTA_2026:pull_request"
  }
  expect_failures = [var.github_oidc_subject]
}

run "reject_environment_subject" {
  command = plan
  variables {
    github_oidc_subject = "repo:CREVIOS/BUP_HACKATHON_DU_FANTA_2026:environment:production"
  }
  expect_failures = [var.github_oidc_subject]
}

run "managed_oidc_bootstrap" {
  command = plan
  assert {
    condition = (
      length(aws_iam_openid_connect_provider.github) == 1 &&
      length(data.aws_iam_openid_connect_provider.github) == 0 &&
      output.github_oidc_provider_managed &&
      output.github_oidc_provider_arn == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    )
    error_message = "Empty ARN must preserve managed bootstrap and expose its ownership."
  }
  assert {
    condition = alltrue([
      for policy in [aws_iam_role.github_actions.assume_role_policy, aws_iam_role.terraform.assume_role_policy] :
      jsondecode(policy).Statement[0].Principal.Federated == aws_iam_openid_connect_provider.github[0].arn
    ])
    error_message = "Both roles must trust the managed provider in bootstrap mode."
  }
}

run "reuse_shared_oidc_without_ownership" {
  command = plan
  variables {
    existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    github_oidc_subject               = null
  }
  assert {
    condition = (
      length(aws_iam_openid_connect_provider.github) == 0 &&
      length(data.aws_iam_openid_connect_provider.github) == 1 &&
      !output.github_oidc_provider_managed &&
      output.github_oidc_provider_arn == var.existing_github_oidc_provider_arn
    )
    error_message = "Reuse must only read the shared provider, with no managed provider resource."
  }
  assert {
    condition = alltrue([
      for policy in [aws_iam_role.github_actions.assume_role_policy, aws_iam_role.terraform.assume_role_policy] :
      jsondecode(policy).Statement[0].Principal.Federated == var.existing_github_oidc_provider_arn &&
      jsondecode(policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity" &&
      jsondecode(policy).Statement[0].Condition == {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:CREVIOS@48938983/BUP_HACKATHON_DU_FANTA_2026@1394116440:ref:refs/heads/main"
        }
      }
    ])
    error_message = "Reusing identity infrastructure must preserve both roles' exact main-branch trust."
  }
}

run "reject_wildcard_provider_arn" {
  command = plan
  variables {
    existing_github_oidc_provider_arn = "arn:aws:iam::*:oidc-provider/token.actions.githubusercontent.com"
  }
  expect_failures = [var.existing_github_oidc_provider_arn]
}

run "reject_non_github_provider_arn" {
  command = plan
  variables {
    existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/example.com"
  }
  expect_failures = [var.existing_github_oidc_provider_arn]
}

run "reject_cross_account_provider" {
  command = plan
  variables {
    existing_github_oidc_provider_arn = "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com"
  }
  expect_failures = [data.aws_iam_openid_connect_provider.github]
}

run "reject_cross_partition_provider" {
  command = plan
  variables {
    existing_github_oidc_provider_arn = "arn:aws-us-gov:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }
  expect_failures = [data.aws_iam_openid_connect_provider.github]
}

run "reject_provider_without_sts_audience" {
  command = plan
  variables {
    existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }
  override_data {
    target = data.aws_iam_openid_connect_provider.github[0]
    values = {
      url            = "token.actions.githubusercontent.com"
      client_id_list = ["another-existing-audience"]
    }
  }
  expect_failures = [data.aws_iam_openid_connect_provider.github]
}

run "reject_provider_with_wrong_issuer" {
  command = plan
  variables {
    existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }
  override_data {
    target = data.aws_iam_openid_connect_provider.github[0]
    values = {
      url            = "https://example.com"
      client_id_list = ["sts.amazonaws.com"]
    }
  }
  expect_failures = [data.aws_iam_openid_connect_provider.github]
}
