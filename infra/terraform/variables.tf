variable "project_id" {
  description = "CallWeave 専用の GCP プロジェクト ID"
  type        = string
}

variable "forbidden_project_pattern" {
  description = "取り違えを防ぎたい他プロジェクトの識別子（正規表現）。一致する project_id では plan を止め、実行時にも起動を拒否する。空なら確認しない"
  type        = string
  default     = ""
}

variable "region" {
  description = "Cloud Run / Firestore / Cloud Tasks のリージョン（東京）"
  type        = string
  default     = "asia-northeast1"
}

variable "image" {
  description = "コンテナイメージ（Artifact Registry、タグまたは digest）"
  type        = string
}

variable "deploy_services" {
  description = "false の場合、Cloud Run 等は作らず基盤（API / AR / SA / Secret）だけ作る（初回イメージ push 前）"
  type        = bool
  default     = true
}

variable "vonage_application_id" {
  description = "CallWeave 専用 Vonage アプリケーション ID（他プロジェクトと共用しない）"
  type        = string
}

variable "vonage_number" {
  description = "着信用 050 番号（E.164、+ なし。例: 8150XXXXXXXX）"
  type        = string
}

variable "vonage_api_base" {
  description = "Vonage Voice API のベース URL"
  type        = string
  default     = "https://api.nexmo.com"
}

variable "sip_target_uri" {
  description = "Brekeke PBX の接続先 SIP URI（例: sip:1000@pbx.example.com;transport=tls）"
  type        = string
}

variable "sip_from_mode" {
  description = "SIP 発信時の From: caller（発信者番号）または vonage_number"
  type        = string
  default     = "caller"
}

variable "hold_music_url" {
  description = "PBX 応答まで発信者に流す保留音の URL（空なら無音）"
  type        = string
  default     = ""
}

variable "web_basic_auth_user" {
  description = "WebUI の Basic 認証ユーザー名（パスワードは Secret Manager の cw-web-basic-auth-password）"
  type        = string
  default     = "callweave"
}

variable "web_domain" {
  description = "WebUI の独自ドメイン（外部 HTTPS LB + Cloud Armor）。空なら LB を作らない"
  type        = string
  default     = ""
}

variable "allowed_cidrs" {
  description = "WebUI / Web API / SSE / エクスポートへのアクセスを許可する社内固定 IP（CIDR）"
  type        = list(string)
  default     = []
}

variable "retention_days" {
  type    = number
  default = 7
}

variable "control_min_instances" {
  type    = number
  default = 1
}

variable "web_min_instances" {
  description = "web の最小インスタンス数。0 なら未使用時は停止（初回表示が数秒遅れる）"
  type        = number
  default     = 1
}

variable "media_min_instances" {
  type    = number
  default = 1
}

variable "media_max_instances" {
  type    = number
  default = 4
}

variable "media_concurrency" {
  description = "1 インスタンスあたりの同時 WS 数（1 通話 = 入力 WS 2 本）"
  type        = number
  default     = 20
}

variable "alert_email" {
  description = "監視アラートの通知先（空なら通知チャネルを作らない）"
  type        = string
  default     = ""
}
