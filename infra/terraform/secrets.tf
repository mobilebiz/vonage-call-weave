# 値は Terraform に持たせず scripts/set-secrets.sh で版を追加する（state に秘密を残さない）
locals {
  secrets = {
    "cw-vonage-private-key"      = ["control"]
    "cw-vonage-signature-secret" = ["control"]
    "cw-media-token-secret"      = ["control", "media"]
    "cw-amivoice-appkey"         = ["media"]
    "cw-elevenlabs-api-key"      = ["media"]
    "cw-deepgram-api-key"        = ["media"]
    "cw-web-basic-auth-password" = ["web"]
  }
  secret_bindings = flatten([
    for name, users in local.secrets : [for u in users : { secret = name, user = u }]
  ])
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.secrets
  secret_id = each.key
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each  = { for b in local.secret_bindings : "${b.secret}/${b.user}" => b }
  secret_id = google_secret_manager_secret.s[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.sa[each.value.user]}"
}
