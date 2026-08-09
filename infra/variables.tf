variable "project_id" {
  type    = string
  default = "virtual-library-mcp"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "service_name" {
  type    = string
  default = "mafia-staging"
}

/** Full image ref to deploy; CI passes the freshly pushed tag. */
variable "image" {
  type = string
}

/** owner/repo — gates which GitHub repo may impersonate the deployer SA. */
variable "github_repository" {
  type    = string
  default = "willtech3/mafia"
}
