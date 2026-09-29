# GitHub Actions -> AWS via OIDC (no static keys). CI only builds + pushes images;
# Argo CD (in-cluster) deploys, so this role needs no cluster access.
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  github_release_subject = coalesce(var.github_oidc_subject, "${var.github_oidc_sub_prefix}:ref:refs/heads/main")
  github_oidc_provider_arn = var.existing_github_oidc_provider_arn == "" ? (
    aws_iam_openid_connect_provider.github[0].arn
  ) : data.aws_iam_openid_connect_provider.github[0].arn
}

# Preserve the old state address when keeping this root as the provider owner.
moved {
  from = aws_iam_openid_connect_provider.github
  to   = aws_iam_openid_connect_provider.github[0]
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.existing_github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  lifecycle {
    # Account-level identity can serve other stacks. Hand it off before demo teardown.
    prevent_destroy = true
  }
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.existing_github_oidc_provider_arn == "" ? 0 : 1
  arn   = var.existing_github_oidc_provider_arn

  lifecycle {
    precondition {
      condition     = var.existing_github_oidc_provider_arn == "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
      error_message = "The existing GitHub OIDC provider must belong to the current AWS account and partition."
    }
    postcondition {
      condition     = trimprefix(self.url, "https://") == "token.actions.githubusercontent.com" && contains(self.client_id_list, "sts.amazonaws.com")
      error_message = "The existing OIDC provider must use GitHub's issuer and include the sts.amazonaws.com audience."
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name = "${local.name}-github-actions"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = local.github_release_subject
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_actions_ecr" {
  role = aws_iam_role.github_actions.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
          "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
        ]
        Resource = [for r in aws_ecr_repository.this : r.arn]
      },
    ]
  })
}

# Terraform runs in GitHub Actions (stable network, auditable): admin role, main branch only.
resource "aws_iam_role" "terraform" {
  name = "${local.name}-terraform"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = local.github_release_subject
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "terraform_admin" {
  role       = aws_iam_role.terraform.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess" # ponytail: scope down if this outlives the event
}

# Argo CD reads the private repo with this read-only deploy key. The public half and the
# repo variables (AWS_REGION, AWS_ROLE_ARN, TF_ROLE_ARN, ECR_REGISTRY) are set once with `gh`
# (see README), so CI never needs a personal GitHub token.
resource "tls_private_key" "argocd" {
  algorithm = "ED25519"
}
