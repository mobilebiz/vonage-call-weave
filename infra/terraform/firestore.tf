resource "google_firestore_database" "db" {
  name                    = "(default)"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
  depends_on              = [google_project_service.apis]
}

# 一覧: callStatus で絞り receivedAt 降順
resource "google_firestore_index" "calls_status_received" {
  collection = "calls"
  fields {
    field_path = "callStatus"
    order      = "ASCENDING"
  }
  fields {
    field_path = "receivedAt"
    order      = "DESCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "DESCENDING"
  }
  depends_on = [google_firestore_database.db]
}

# 確定発話: startMs → segmentId
resource "google_firestore_index" "segments_order" {
  collection = "segments"
  fields {
    field_path = "startMs"
    order      = "ASCENDING"
  }
  fields {
    field_path = "segmentId"
    order      = "ASCENDING"
  }
  depends_on = [google_firestore_database.db]
}

# 照合: 止まった制御ジョブ
resource "google_firestore_index" "jobs_stale" {
  collection = "controlJobs"
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "updatedAt"
    order      = "ASCENDING"
  }
  depends_on = [google_firestore_database.db]
}
