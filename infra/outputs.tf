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
