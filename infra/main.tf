provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "fuelops", ManagedBy = "terraform", Event = "bup-hackathon-2026" }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "fuelops"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
}

# ---------------------------------------------------------------- network
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.3"

  name            = local.name
  cidr            = var.vpc_cidr
  azs             = local.azs
  public_subnets  = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 4, i + 1)]

  # ponytail: single NAT is an AZ-level SPOF; flip to one_nat_gateway_per_az if AZ failure is demoed.
  enable_nat_gateway = true
  single_nat_gateway = true

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

# ---------------------------------------------------------------- EKS (Auto Mode: managed nodes, ALB, EBS, pod identity)
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "21.26.0"

  name                   = local.name
  kubernetes_version     = var.kubernetes_version
  endpoint_public_access = true

  enable_cluster_creator_admin_permissions = false
  access_entries = {
    for k, arn in {
      root      = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
      terraform = aws_iam_role.terraform.arn
      } : k => {
      principal_arn = arn
      policy_associations = {
        admin = {
          policy_arn   = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = { type = "cluster" }
        }
      }
    }
  }
  enable_irsa = false # Auto Mode uses EKS Pod Identity

  compute_config = {
    enabled    = true
    node_pools = ["general-purpose", "system"]
  }

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets
}

# ---------------------------------------------------------------- Postgres
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "db" {
  name   = "${local.name}-db"
  vpc_id = module.vpc.vpc_id

  ingress {
    description     = "Postgres from EKS pods/nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.cluster_primary_security_group_id]
  }
}

resource "aws_db_instance" "this" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.db_instance_class

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "fuelops"
  username = "fuelops"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  multi_az               = var.db_multi_az
  publicly_accessible    = false

  performance_insights_enabled = true
  backup_retention_period      = 1
  # Ephemeral event environment (<= 8h): destroy must be clean.
  deletion_protection = false
  skip_final_snapshot = true
  apply_immediately   = true
}

# ---------------------------------------------------------------- images
resource "aws_ecr_repository" "this" {
  for_each             = toset(["fuelops", "fuelops-web"])
  name                 = each.key
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
}
