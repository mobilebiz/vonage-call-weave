# ログには本文・電話番号全文・トークンを出さない。callId とエラーコードで追跡する
resource "google_logging_metric" "asr_failed" {
  name   = "callweave/asr_failed"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"callweave-media\" AND jsonPayload.msg=\"asr failed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "job_failed" {
  name   = "callweave/control_job_failed"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"callweave-control\" AND jsonPayload.msg=\"job failed\" AND jsonPayload.final=true"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "signature_rejected" {
  name   = "callweave/webhook_signature_rejected"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"callweave-control\" AND jsonPayload.msg=\"webhook signature rejected\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  depends_on = [google_project_service.apis]
}

resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email != "" ? 1 : 0
  display_name = "CallWeave alerts"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

resource "google_monitoring_alert_policy" "asr_failed" {
  count        = var.alert_email != "" ? 1 : 0
  display_name = "CallWeave: 音声認識の停止"
  combiner     = "OR"
  conditions {
    display_name = "asr failed > 0 (5m)"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/callweave/asr_failed\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.email[0].id]
}

resource "google_monitoring_alert_policy" "job_failed" {
  count        = var.alert_email != "" ? 1 : 0
  display_name = "CallWeave: 呼制御ジョブの最終失敗"
  combiner     = "OR"
  conditions {
    display_name = "control job failed"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/callweave/control_job_failed\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.email[0].id]
}
