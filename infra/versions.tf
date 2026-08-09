terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "gcs" {
    bucket = "virtual-library-mcp-tfstate"
    prefix = "mafia"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
