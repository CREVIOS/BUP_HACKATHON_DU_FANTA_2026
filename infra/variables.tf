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
  description = "Branch or exact commit Argo CD tracks"
  type        = string
  default     = "main"
}

variable "existing_github_oidc_provider_arn" {
  description = "Reuse an account-owned GitHub OIDC provider without managing it here. Empty retains managed creation for bootstrap; hand off any existing state entry before switching modes."
  type        = string
  default     = ""
  nullable    = false

  validation {
    condition     = var.existing_github_oidc_provider_arn == "" || can(regex("^arn:[a-z0-9-]+:iam::[0-9]{12}:oidc-provider/token[.]actions[.]githubusercontent[.]com$", var.existing_github_oidc_provider_arn))
    error_message = "Supply an exact GitHub OIDC provider ARN, or leave empty for managed bootstrap. Wildcards, other issuers, paths, and non-provider ARNs are not accepted."
  }
}

variable "github_oidc_subject" {
  description = "Optional exact main-branch OIDC subject override. By default both AWS roles use github_oidc_sub_prefix plus :ref:refs/heads/main."
  type        = string
  default     = null

  validation {
    # @ is reserved for immutable numeric IDs in GitHub's subject format.
    condition = var.github_oidc_subject == null ? true : (
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

variable "github_oidc_sub_prefix" {
  description = "OIDC sub prefix; this repo uses GitHub's immutable subject format (gh api repos/OWNER/REPO/actions/oidc/customization/sub)"
  type        = string
  default     = "repo:CREVIOS@48938983/BUP_HACKATHON_DU_FANTA_2026@1394116440"

  validation {
    condition = (
      can(regex("^repo:[^:@/]+(@[0-9]+)?/[^:@/]+(@[0-9]+)?$", var.github_oidc_sub_prefix)) &&
      replace(var.github_oidc_sub_prefix, "/@[0-9]+/", "") == "repo:${var.github_repo}"
    )
    error_message = "The OIDC prefix must identify github_repo exactly, optionally including its immutable numeric IDs; no wildcard or branch suffix is allowed."
  }
}
