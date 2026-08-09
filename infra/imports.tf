# The staging service was first stood up imperatively on 2026-08-09 to prove
# the pipe end-to-end (see DECISIONS.md); this brings it under Terraform.
# Safe to delete this file once the import has been applied everywhere.

import {
  to = google_cloud_run_v2_service.mafia
  id = "projects/virtual-library-mcp/locations/us-central1/services/mafia-staging"
}
