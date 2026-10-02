terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  # バケット名は scripts/deploy.sh が -backend-config で渡す（CallWeave 専用プロジェクトのバケット）
  backend "gcs" {
    prefix = "callweave/terraform"
  }
}

provider "google" {
  # 既定プロジェクト（gcloud / GOOGLE_CLOUD_PROJECT）に頼らず、必ず明示する
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  forbidden = var.forbidden_project_pattern != "" && can(regex("(?i)${var.forbidden_project_pattern}", var.project_id))
}

# 他プロジェクトへの適用を plan 段階で止める
resource "terraform_data" "isolation_guard" {
  lifecycle {
    precondition {
      condition     = !local.forbidden
      error_message = "project_id が forbidden_project_pattern（他プロジェクト）に一致します。CallWeave 専用プロジェクトを指定してください。"
    }
  }
}
