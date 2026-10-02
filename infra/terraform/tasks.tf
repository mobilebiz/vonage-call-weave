resource "google_cloud_tasks_queue" "control" {
  name     = "callweave-control"
  location = var.region
  rate_limits {
    max_dispatches_per_second = 50
    max_concurrent_dispatches = 50
  }
  retry_config {
    max_attempts       = 8
    min_backoff        = "1s"
    max_backoff        = "30s"
    max_doublings      = 4
    max_retry_duration = "600s"
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "reconcile" {
  count            = var.deploy_services ? 1 : 0
  name             = "callweave-reconcile"
  region           = var.region
  description      = "孤児通話・Webhook 欠落・未完了処理の照合"
  schedule         = "* * * * *"
  time_zone        = "Asia/Tokyo"
  attempt_deadline = "60s"
  http_target {
    http_method = "POST"
    uri         = "${local.run_url.control}/internal/cron/reconcile"
    oidc_token {
      service_account_email = local.sa.scheduler
      audience              = local.run_url.control
    }
  }
}

resource "google_cloud_scheduler_job" "cleanup" {
  count            = var.deploy_services ? 1 : 0
  name             = "callweave-cleanup"
  region           = var.region
  description      = "保存期限切れ通話（サブコレクション含む）の削除"
  schedule         = "17 * * * *"
  time_zone        = "Asia/Tokyo"
  attempt_deadline = "300s"
  http_target {
    http_method = "POST"
    uri         = "${local.run_url.control}/internal/cron/cleanup"
    oidc_token {
      service_account_email = local.sa.scheduler
      audience              = local.run_url.control
    }
  }
}
