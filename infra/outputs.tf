output "region" {
  value = var.region
}

output "cluster_name" {
  value = module.eks.cluster_name
}

output "application_enabled" {
  description = "Whether Terraform declares the Argo CD Application; not a deployment health result."
  value       = var.enable_application
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "github_actions_role_arn" {
  value = aws_iam_role.github_actions.arn
}

output "github_oidc_provider_arn" {
  description = "GitHub OIDC provider used by both roles. Persist as AWS_GITHUB_OIDC_PROVIDER_ARN as part of any managed-state handoff."
  value       = local.github_oidc_provider_arn
}

output "github_oidc_provider_managed" {
  description = "True means this root owns the provider; hand off ownership before demo teardown."
  value       = var.existing_github_oidc_provider_arn == ""
}

output "db_endpoint" {
  value = aws_db_instance.this.address
}

output "grafana_admin_password" {
  value     = random_password.grafana.result
  sensitive = true
}

output "alb_hostname_command" {
  value = "kubectl -n fuelops get ingress -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}'"
}

output "terraform_role_arn" {
  value = aws_iam_role.terraform.arn
}

output "argocd_deploy_public_key" {
  value = tls_private_key.argocd.public_key_openssh
}
