variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.60.0.0/16"
}

variable "kubernetes_version" {
  type    = string
  default = "1.36"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "github_repo" {
  description = "owner/name of the repo Argo CD syncs from and GitHub Actions deploys from"
  type        = string
  default     = "CREVIOS/BUP_HACKATHON_DU_FANTA_2026"
}

variable "git_revision" {
  description = "Branch Argo CD tracks"
  type        = string
  default     = "main"
}

variable "typesafe_api_key" {
  description = "Jev API key (TF_VAR_typesafe_api_key). Empty = rule-based review fallback only."
  type        = string
  default     = ""
  sensitive   = true
}

variable "seed_users" {
  description = "viewer/operator/admin logins for the operator UI, user:pass:role comma-separated"
  type        = string
  default     = ""
  sensitive   = true
}
