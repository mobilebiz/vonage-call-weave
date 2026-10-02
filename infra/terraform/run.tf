locals {
  # Cloud Run の決定的 URL（https://{service}-{project_number}.{region}.run.app）
  run_url = { for s in ["control", "media", "web"] : s => "https://callweave-${s}-${data.google_project.this.number}.${var.region}.run.app" }

  common_env = {
    CW_ENV                       = "production"
    CW_GCP_PROJECT_ID            = var.project_id
    CW_FORBIDDEN_PROJECT_PATTERN = var.forbidden_project_pattern
    CW_REGION                    = var.region
    CW_STORE                     = "firestore"
    CW_RETENTION_DAYS            = tostring(var.retention_days)
    CW_TRANSCRIPTION_LIMIT_MIN   = "55"
  }

  control_env = merge(local.common_env, {
    CW_SERVICE               = "control"
    CW_QUEUE                 = "cloudtasks"
    CW_TASKS_QUEUE           = google_cloud_tasks_queue.control.name
    CW_TASKS_LOCATION        = var.region
    CW_TASKS_INVOKER_SA      = local.sa.tasks
    CW_INTERNAL_CALLER_SAS   = "${local.sa.tasks},${local.sa.scheduler}"
    CW_CONTROL_BASE_URL      = local.run_url.control
    CW_MEDIA_WS_URL          = "${replace(local.run_url.media, "https://", "wss://")}/media/vonage"
    CW_VONAGE_APPLICATION_ID = var.vonage_application_id
    CW_VONAGE_NUMBER         = var.vonage_number
    CW_VONAGE_API_BASE       = var.vonage_api_base
    CW_SIP_TARGET_URI        = var.sip_target_uri
    CW_SIP_FROM_MODE         = var.sip_from_mode
    CW_HOLD_MUSIC_URL        = var.hold_music_url
  })

  media_env = merge(local.common_env, {
    CW_SERVICE = "media"
    CW_QUEUE   = "inline"
  })

  web_env = merge(local.common_env, {
    CW_SERVICE             = "web"
    CW_QUEUE               = "inline"
    CW_STATIC_DIR          = "/app/web/dist"
    CW_WEB_BASIC_AUTH_USER = var.web_basic_auth_user
    # 設定画面で未設定のときの既定値として表示する
    CW_SIP_TARGET_URI = var.sip_target_uri
    # Cloud Run 直接公開は 1 段、外部 LB 経由は LB の分を足して 2 段
    CW_TRUST_PROXY_HOPS = var.web_domain != "" ? "2" : "1"
  })

  control_secrets = {
    CW_VONAGE_PRIVATE_KEY      = "cw-vonage-private-key"
    CW_VONAGE_SIGNATURE_SECRET = "cw-vonage-signature-secret"
    CW_MEDIA_TOKEN_SECRET      = "cw-media-token-secret"
  }
  media_secrets = {
    CW_MEDIA_TOKEN_SECRET = "cw-media-token-secret"
    CW_AMIVOICE_APPKEY    = "cw-amivoice-appkey"
    CW_ELEVENLABS_API_KEY = "cw-elevenlabs-api-key"
    CW_DEEPGRAM_API_KEY   = "cw-deepgram-api-key"
  }
}

# ---------------------------------------------------------------- control
resource "google_cloud_run_v2_service" "control" {
  count               = var.deploy_services ? 1 : 0
  name                = "callweave-control"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL" # Vonage Webhook の受信口。署名検証と OIDC で保護
  deletion_protection = false

  template {
    service_account                  = local.sa.control
    timeout                          = "300s"
    max_instance_request_concurrency = 40
    scaling {
      min_instance_count = var.control_min_instances
      max_instance_count = 4
    }
    containers {
      image = var.image
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = false
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.control_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.control_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.access, google_project_iam_member.datastore_user]
}

# ---------------------------------------------------------------- media
resource "google_cloud_run_v2_service" "media" {
  count               = var.deploy_services ? 1 : 0
  name                = "callweave-media"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL" # Vonage 音声 WS の受信口。世代付きトークンで保護
  deletion_protection = false

  template {
    service_account                  = local.sa.media
    timeout                          = "3600s" # WS は最大 60 分。認識対象は 55 分以内
    max_instance_request_concurrency = var.media_concurrency
    scaling {
      min_instance_count = var.media_min_instances
      max_instance_count = var.media_max_instances
    }
    containers {
      image = var.image
      resources {
        limits            = { cpu = "2", memory = "1Gi" }
        cpu_idle          = false
        startup_cpu_boost = true # 応答後も音声中継・ASR 接続を処理し続ける
      }
      dynamic "env" {
        for_each = local.media_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.media_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.access, google_project_iam_member.datastore_user]
}

# ---------------------------------------------------------------- web
resource "google_cloud_run_v2_service" "web" {
  count    = var.deploy_services ? 1 : 0
  name     = "callweave-web"
  location = var.region
  # ドメインあり: LB 経由のみ（直接 URL から Cloud Armor を迂回させない）
  # ドメインなし: Cloud Run URL を直接公開し、アプリの Basic 認証で保護する
  ingress             = var.web_domain != "" ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = local.sa.web
    timeout                          = "3600s" # SSE
    max_instance_request_concurrency = 80
    scaling {
      min_instance_count = var.web_min_instances
      max_instance_count = 4
    }
    containers {
      image = var.image
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = false
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.web_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "CW_WEB_BASIC_AUTH_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.s["cw-web-basic-auth-password"].secret_id
            version = "latest"
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }
  depends_on = [google_project_iam_member.datastore_user, google_secret_manager_secret_iam_member.access]
}

# Vonage（control / media）と LB（web）からの未認証呼出しを許可。アプリ側で署名・トークンを検証する
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = var.deploy_services ? toset(["control", "media", "web"]) : toset([])
  name     = "callweave-${each.key}"
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
  depends_on = [
    google_cloud_run_v2_service.control,
    google_cloud_run_v2_service.media,
    google_cloud_run_v2_service.web,
  ]
}
