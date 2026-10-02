# サービスごとに最小権限のサービスアカウントを分ける
resource "google_service_account" "sa" {
  for_each = {
    control   = "CallWeave call control (Vonage webhooks, Cloud Tasks)"
    media     = "CallWeave media relay (Vonage WS -> ASR)"
    web       = "CallWeave web UI / API / SSE"
    tasks     = "CallWeave Cloud Tasks OIDC invoker"
    scheduler = "CallWeave Cloud Scheduler OIDC invoker"
    build     = "CallWeave Cloud Build"
  }
  account_id   = "cw-${each.key}"
  display_name = each.value
  depends_on   = [google_project_service.apis]
}

locals {
  sa = { for k, v in google_service_account.sa : k => v.email }
}

# Firestore: control / media は通話データ、web は画面の設定（settings/app）を書き込む
# （Firestore の IAM はコレクション単位で絞れないため、web の書込みはアプリ側で settings に限定）
resource "google_project_iam_member" "datastore_user" {
  for_each = toset(["control", "media", "web"])
  project  = var.project_id
  role     = "roles/datastore.user"
  member   = "serviceAccount:${local.sa[each.key]}"
}

resource "google_project_iam_member" "log_writer" {
  for_each = toset(["control", "media", "web", "build"])
  project  = var.project_id
  role     = "roles/logging.logWriter"
  member   = "serviceAccount:${local.sa[each.key]}"
}

resource "google_project_iam_member" "metric_writer" {
  for_each = toset(["control", "media", "web"])
  project  = var.project_id
  role     = "roles/monitoring.metricWriter"
  member   = "serviceAccount:${local.sa[each.key]}"
}

# control: Cloud Tasks へ投入し、OIDC 用 SA として振る舞う
resource "google_project_iam_member" "control_tasks" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${local.sa.control}"
}

resource "google_service_account_iam_member" "control_act_as_tasks" {
  service_account_id = google_service_account.sa["tasks"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.sa.control}"
}

# Cloud Build: イメージ push とビルドログ
resource "google_project_iam_member" "build_ar_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${local.sa.build}"
}

resource "google_project_iam_member" "build_storage" {
  project = var.project_id
  role    = "roles/storage.objectUser"
  member  = "serviceAccount:${local.sa.build}"
}
