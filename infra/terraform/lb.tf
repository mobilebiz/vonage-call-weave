# WebUI / Web API / SSE / エクスポートを外部 HTTPS LB + Cloud Armor の許可元制限下に置く。
locals {
  lb = var.deploy_services && var.web_domain != "" ? 1 : 0
}

resource "terraform_data" "lb_guard" {
  count = local.lb
  lifecycle {
    precondition {
      condition     = length(var.allowed_cidrs) > 0
      error_message = "web_domain を指定する場合は allowed_cidrs（社内固定 IP）を指定してください。公開 URL を知っているだけで閲覧できる構成にはしません。"
    }
  }
}

resource "google_compute_global_address" "web" {
  count = local.lb
  name  = "callweave-web-ip"
}

resource "google_compute_region_network_endpoint_group" "web" {
  count                 = local.lb
  name                  = "callweave-web-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.web[0].name
  }
}

resource "google_compute_security_policy" "web" {
  count       = local.lb
  name        = "callweave-web-allowlist"
  description = "社内固定 IP / VPN のみ許可"

  rule {
    action   = "allow"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = var.allowed_cidrs
      }
    }
    description = "allowed office ranges"
  }

  rule {
    action   = "deny(403)"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "default deny"
  }
}

resource "google_compute_backend_service" "web" {
  count                 = local.lb
  name                  = "callweave-web-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  # Serverless NEG のバックエンドは timeout_sec を指定できない。SSE の長さは Cloud Run の timeout で制御する
  security_policy = google_compute_security_policy.web[0].id
  backend {
    group = google_compute_region_network_endpoint_group.web[0].id
  }
  log_config {
    enable = true
  }
}

resource "google_compute_url_map" "web" {
  count           = local.lb
  name            = "callweave-web-urlmap"
  default_service = google_compute_backend_service.web[0].id
}

resource "google_compute_managed_ssl_certificate" "web" {
  count = local.lb
  name  = "callweave-web-cert"
  managed {
    domains = [var.web_domain]
  }
}

resource "google_compute_target_https_proxy" "web" {
  count            = local.lb
  name             = "callweave-web-https"
  url_map          = google_compute_url_map.web[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.web[0].id]
}

resource "google_compute_global_forwarding_rule" "web" {
  count                 = local.lb
  name                  = "callweave-web-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.web[0].id
  port_range            = "443"
  target                = google_compute_target_https_proxy.web[0].id
}
