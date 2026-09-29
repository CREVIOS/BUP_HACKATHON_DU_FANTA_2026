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
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = "${var.github_oidc_sub_prefix}:*" }
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
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "${var.github_oidc_sub_prefix}:ref:refs/heads/main"
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
