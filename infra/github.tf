# GitHub Actions -> AWS via OIDC (no static keys). CI only builds + pushes images;
# Argo CD (in-cluster) deploys, so this role needs no cluster access.
data "aws_caller_identity" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "github_actions" {
  name = "${local.name}-github-actions"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = var.github_oidc_subject
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
          "ecr:DescribeImages", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
        ]
        Resource = [for r in aws_ecr_repository.this : r.arn]
      },
    ]
  })
}

# Repo wiring: CI variables + a read-only deploy key for Argo CD.
provider "github" {
  owner = split("/", var.github_repo)[0]
}

locals {
  repo_name = split("/", var.github_repo)[1]
}

resource "github_actions_variable" "this" {
  for_each = {
    AWS_REGION   = var.region
    AWS_ROLE_ARN = aws_iam_role.github_actions.arn
    ECR_REGISTRY = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
  }
  repository    = local.repo_name
  variable_name = each.key
  value         = each.value
}

resource "tls_private_key" "argocd" {
  algorithm = "ED25519"
}

resource "github_repository_deploy_key" "argocd" {
  repository = local.repo_name
  title      = "argocd-${local.name}"
  key        = tls_private_key.argocd.public_key_openssh
  read_only  = true
}
