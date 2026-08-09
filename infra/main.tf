# ---------------------------------------------------------------------------
# APIs

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Container images

resource "google_artifact_registry_repository" "mafia" {
  repository_id = "mafia"
  location      = var.region
  format        = "DOCKER"
  description   = "Mafia MCP server images"
  depends_on    = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Runtime identity + token secret

resource "google_service_account" "runtime" {
  account_id   = "mafia-runtime"
  display_name = "Mafia MCP server runtime"
}

resource "google_project_iam_member" "runtime_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "random_password" "token_secret" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "token_secret" {
  secret_id = "mafia-token-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "token_secret" {
  secret      = google_secret_manager_secret.token_secret.id
  secret_data = random_password.token_secret.result
}

resource "google_secret_manager_secret_iam_member" "runtime_reads_secret" {
  secret_id = google_secret_manager_secret.token_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------------------------------------------------------------------------
# Cloud Run service

resource "google_cloud_run_v2_service" "mafia" {
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email

    scaling {
      # min 2: the kill-an-instance demo must be real, and cold starts on
      # stage are unacceptable.
      min_instance_count = 2
      max_instance_count = 10
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name = "MAFIA_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.token_secret.secret_id
            version = "latest"
          }
        }
      }

      ports {
        container_port = 8080
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.runtime_reads_secret,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.mafia.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------------------
# Firestore TTL: rooms expire ~48h after their last write (cleanup, not
# correctness). The (default) Firestore database predates this config and is
# not managed here.

resource "google_firestore_field" "ttl" {
  for_each   = toset(["rooms", "players", "actions"])
  database   = "(default)"
  collection = each.value
  field      = "expiresAt"

  ttl_config {}

  index_config {}

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# GitHub Actions deployer: keyless via Workload Identity Federation

resource "google_service_account" "deployer" {
  account_id   = "mafia-deployer"
  display_name = "Mafia CI deployer (GitHub Actions)"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# The deployer runs `terraform apply` for this stack, so it needs to manage
# everything the stack contains. Sandbox project — broad by design.
resource "google_project_iam_member" "deployer_roles" {
  for_each = toset([
    "roles/editor",
    "roles/resourcemanager.projectIamAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.workloadIdentityPoolAdmin",
    "roles/run.admin",
    "roles/secretmanager.admin",
    "roles/datastore.owner",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_uses_runtime_sa" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
