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

variable "github_oidc_subject" {
  description = "Exact GitHub OIDC sub for this repository on main. Required because GitHub supports both name-only and immutable owner/repository-ID subjects; confirm the repository's format before applying."
  type        = string
  nullable    = false

  validation {
    # @ is reserved for immutable numeric IDs in GitHub's subject format.
    condition = (
      can(regex("^repo:[^:@/]+(@[0-9]+)?/[^:@/]+(@[0-9]+)?:ref:refs/heads/main$", var.github_oidc_subject)) &&
      replace(var.github_oidc_subject, "/@[0-9]+/", "") == "repo:${var.github_repo}:ref:refs/heads/main"
    )
    error_message = "Use this github_repo's exact main-branch subject: repo:OWNER/REPO:ref:refs/heads/main (optionally with @numeric IDs after the owner/repository names). Wildcards, other branches, PRs, and environments are not accepted."
  }
}

variable "enable_application" {
  description = "Create the Argo CD application after CI has published both images and committed full SHA tags to the tracked chart. Keep false during platform bootstrap."
  type        = bool
  default     = false
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
