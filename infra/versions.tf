terraform {
  required_version = ">= 1.11"

  # Reuses the account's existing state bucket (eu-west-3); resources live in var.region.
  backend "s3" {
    bucket       = "talentforge-tfstate-373220260649"
    key          = "fuelops-sg/terraform.tfstate"
    region       = "eu-west-3"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 6.0" }
    helm       = { source = "hashicorp/helm", version = "~> 3.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
    tls        = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}
