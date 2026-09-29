# Import existing grants before applying. These principals retain only the
# monitoring namespace permissions already used for Grafana access.
resource "aws_eks_access_entry" "monitoring_operator" {
  for_each = var.monitoring_operator_principal_arns

  cluster_name  = module.eks.cluster_name
  principal_arn = each.value
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "monitoring_operator" {
  for_each = aws_eks_access_entry.monitoring_operator

  cluster_name  = each.value.cluster_name
  principal_arn = each.value.principal_arn
  policy_arn    = "arn:${data.aws_partition.current.partition}:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"

  access_scope {
    type       = "namespace"
    namespaces = ["monitoring"]
  }
}
