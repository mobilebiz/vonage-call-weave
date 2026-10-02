# 構築・運用手順

## 初回構築（オーナーのみの空プロジェクトから）

前提: CallWeave 専用 GCP プロジェクト（課金有効）、gcloud / terraform、`private.key` がリポジトリ直下。

1. 設定ファイル
   ```bash
   cp deploy/callweave.env.example deploy/callweave.env
   cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
   ```
   `deploy/callweave.env` に専用プロジェクト ID、`terraform.tfvars` に Vonage 番号・SIP URI・社内 IP・ドメインを記入。
2. 専用 gcloud 構成（アクティブ構成 `default` は変更しない）
   ```bash
   scripts/00-gcloud-config.sh
   CLOUDSDK_ACTIVE_CONFIG_NAME=callweave gcloud auth login   # 未ログインの場合
   ```
3. API と Terraform state バケット: `scripts/01-bootstrap.sh`
4. 基盤（API、Artifact Registry、サービスアカウント、Secret 容器、Firestore、Cloud Tasks）
   ```bash
   scripts/tf.sh apply -var=deploy_services=false -var=image=unused
   ```
5. 秘密情報: `scripts/set-secrets.sh`（private.key と生成した WS トークン鍵は自動、署名シークレット・ASR キーは対話入力）
6. デプロイ: `scripts/deploy.sh`（Cloud Build → Cloud Run 3 サービス、Scheduler、LB、Cloud Armor）
7. 出力の `web_lb_ip` を `web_domain` の A レコードに設定（マネージド証明書の発行に十数分〜）
8. Vonage アプリに `vonage_answer_url` / `vonage_event_url` / `vonage_fallback_url` を設定し、Signed webhooks を有効化
9. Brekeke 側で Vonage の SIP 送信元を許可

作成されるサービスアカウント: `cw-control`、`cw-media`、`cw-web`（Firestore 読取のみ）、`cw-tasks`、`cw-scheduler`、`cw-build`。

## 更新デプロイ

```bash
scripts/deploy.sh
```

## アクセス制限

現在の構成（ドメインなし・IP 可変）: `callweave-web` を Cloud Run URL で直接公開し、アプリの Basic 認証
（ユーザー `callweave`、パスワードは Secret Manager `cw-web-basic-auth-password`）で全経路を保護。
パスワード変更は `scripts/set-secrets.sh --all` の後、web の新リビジョンをデプロイする。
外部から `/healthz` は Cloud Run のフロントエンドに予約されているため 404 になる（コンテナ内の起動確認では使える）。

ドメインと固定 IP を用意した場合は `web_domain` / `allowed_cidrs` を設定すると、以下の LB + Cloud Armor 構成になる。

- WebUI / API / SSE / エクスポートは `callweave-web` のみが提供し、ingress は LB 経由に限定（直接 URL 不可）
- Cloud Armor で `allowed_cidrs` 以外を 403
- control / media は Vonage からの受信口として公開。control は署名付き Webhook、`/internal/*` は OIDC（Tasks・Scheduler の SA のみ）、media は世代付きトークンで保護
- 社内に固定 IP がない場合は別方式（IAP、VPN など）を利用者と確定する

## 監視

- ログは Cloud Logging（JSON 構造化）。本文・電話番号全文・トークンは出さず、callId とエラーコードで追跡
- ログベース指標: `callweave/asr_failed`、`callweave/control_job_failed`、`callweave/webhook_signature_rejected`
- `alert_email` を設定すると ASR 停止・ジョブ最終失敗をメール通知

## よくある対応

| 症状 | 確認 |
| - | - |
| 着信しても IVR が流れない | Vonage アプリの Answer URL、`webhook signature rejected` ログ、署名シークレット |
| 片側だけ認識しない | 通話詳細の話者状態とエラーコード（例: `deepgram_http_401` はキー不正） |
| 「最終化中」のまま | 照合ジョブ（毎分）が 30 秒で partial にする。Scheduler の実行履歴を確認 |
| 通話一覧が更新されない | ブラウザ右上の接続状態、web の Firestore 権限、LB タイムアウト（3600 秒） |
| 孤児レッグ | 照合ジョブが終話済み通話の残存レッグを切断する（`orphanHangups`） |

## 負荷・容量

- 同時 10 通話 = 入力 WS 20 本 + ASR 接続 20 本。`media_concurrency`（既定 20）と `media_max_instances` を負荷試験で確定
- 各 ASR の契約上の同時接続数が 20 以上であることを確認する
- Cloud Run の WS は最長 60 分（timeout 3600 秒）。認識対象は 55 分以内
