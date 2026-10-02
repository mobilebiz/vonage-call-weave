output "vonage_answer_url" {
  description = "Vonage アプリの Answer URL（POST）"
  value       = "${local.run_url.control}/webhooks/vonage/answer"
}

output "vonage_event_url" {
  description = "Vonage アプリの Event URL（POST）"
  value       = "${local.run_url.control}/webhooks/vonage/events"
}

output "vonage_fallback_url" {
  value = "${local.run_url.control}/webhooks/vonage/fallback"
}

output "media_ws_url" {
  value = "${replace(local.run_url.media, "https://", "wss://")}/media/vonage"
}

output "web_url" {
  description = "WebUI（Basic 認証）"
  value       = var.web_domain != "" ? "https://${var.web_domain}" : local.run_url.web
}

output "web_lb_ip" {
  description = "web_domain の A レコードに設定する IP"
  value       = local.lb == 1 ? google_compute_global_address.web[0].address : null
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}"
}

output "build_service_account" {
  value = local.sa.build
}
