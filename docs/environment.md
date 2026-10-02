# 環境変数一覧

すべて `CW_` 接頭辞。本番（Cloud Run）では Terraform（`infra/terraform/run.tf`）が設定し、秘密情報は
Secret Manager から注入する。ローカルは `.env`（`env.local.example` を元に作成）。

## 共通

| 変数 | 既定 | 説明 |
| - | - | - |
| `CW_ENV` | `local` | `production` で必須項目の検証が厳しくなる |
| `CW_SERVICE` | `all` | `control` / `media` / `web` / `all`（ローカル単一プロセス） |
| `PORT` | `8080` | |
| `CW_LOG_LEVEL` | prod `info` / local `debug` | |
| `CW_STORE` | prod `firestore` / local `memory` | `memory` は `CW_SERVICE=all` のときのみ |
| `CW_GCP_PROJECT_ID` | — | **CallWeave 専用**プロジェクト。`GOOGLE_CLOUD_PROJECT` は参照しない |
| `CW_FIRESTORE_DATABASE` | `(default)` | |
| `CW_REGION` | `asia-northeast1` | |
| `CW_FORBIDDEN_PROJECT_PATTERN` | — | 取り違えを防ぎたい他プロジェクトの識別子（正規表現）。一致するプロジェクトでは起動しない |
| `CW_FORBIDDEN_VONAGE_APP_IDS` | — | 他プロジェクトの Vonage アプリ ID（カンマ区切り） |
| `CW_RETENTION_DAYS` | `7` | 終話後の保存日数 |
| `CW_MEDIA_TOKEN_SECRET` 🔒 | — | 監視 WS トークンの HMAC 鍵（32 文字以上。control と media で同じ値） |

## control（呼制御）

| 変数 | 既定 | 説明 |
| - | - | - |
| `CW_QUEUE` | prod `cloudtasks` | `inline` はローカル用 |
| `CW_TASKS_QUEUE` / `CW_TASKS_LOCATION` | `callweave-control` / リージョン | |
| `CW_TASKS_INVOKER_SA` | — | Cloud Tasks の OIDC トークン発行 SA |
| `CW_INTERNAL_CALLER_SAS` | — | `/internal/*` を呼べる SA（Tasks・Scheduler） |
| `CW_CONTROL_BASE_URL` | — | Webhook・タスクの公開ベース URL |
| `CW_MEDIA_WS_URL` | — | 監視 WS の接続先 `wss://…/media/vonage` |
| `CW_VONAGE_APPLICATION_ID` | — | CallWeave 専用の Vonage アプリケーション ID |
| `CW_VONAGE_PRIVATE_KEY` 🔒 / `CW_VONAGE_PRIVATE_KEY_PATH` | — | アプリの秘密鍵（PEM）。ローカルはパス指定可 |
| `CW_VONAGE_SIGNATURE_SECRET` 🔒 | — | 署名付き Webhook の検証用 |
| `CW_VONAGE_NUMBER` | — | 050 番号（E.164、+ なし）。監視レッグ等の From |
| `CW_VONAGE_API_BASE` | `https://api.nexmo.com` | リージョン指定する場合は変更 |
| `CW_VERIFY_WEBHOOK_SIGNATURE` | prod `true` | |
| `CW_VERIFY_PAYLOAD_HASH` | `false` | HTTPS 前提のため既定は JWT 検証のみ |
| `CW_SIP_TARGET_URI` | — | Brekeke の SIP URI の既定値（コードに固定しない）。画面の設定で上書きでき、web は既定値の表示に使う |
| `CW_SIP_FROM_MODE` | `caller` | SIP の From に発信者番号を使うか、050 番号を使うか |
| `CW_SIP_HEADERS_JSON` | `{}` | SIP INVITE に付ける追加ヘッダー（`X-` が付与される） |
| `CW_SIP_RINGING_TIMEOUT_SEC` | `30` | SIP 呼出タイムアウト |
| `CW_HOLD_MUSIC_URL` | — | PBX 応答まで発信者に流す保留音 |
| `CW_MAX_WS_RECREATE` | `3` | 監視 WS の再作成上限（話者ごと） |
| `CW_FINALIZE_DEADLINE_MS` | `30000` | 終話から最終化を打ち切るまで（照合処理が partial にする） |

## media（音声中継）

| 変数 | 既定 | 説明 |
| - | - | - |
| `CW_ASR_LANGUAGE` | `ja` | |
| `CW_ENGINE_CONFIG_VERSION` | `2026-10-02.1` | 通話に記録される設定版 |
| `CW_AMIVOICE_APPKEY` 🔒 | — | |
| `CW_AMIVOICE_URL` | `wss://acp-api.amivoice.com/v1/nolog/` | ログ保存なしエンドポイント |
| `CW_AMIVOICE_ENGINE` | `-a-general` | |
| `CW_AMIVOICE_RESULT_UPDATED_INTERVAL` | `500` | 途中結果の間隔（ms） |
| `CW_ELEVENLABS_API_KEY` 🔒 | — | |
| `CW_ELEVENLABS_MODEL` | `scribe_v2_realtime` | |
| `CW_ELEVENLABS_ENABLE_LOGGING` | `false` | 契約により無効化されない場合あり |
| `CW_ELEVENLABS_VAD_SILENCE_SECS` | `0.8` | |
| `CW_DEEPGRAM_API_KEY` 🔒 | — | |
| `CW_DEEPGRAM_MODEL` | `nova-3` | |
| `CW_DEEPGRAM_ENDPOINTING_MS` / `CW_DEEPGRAM_UTTERANCE_END_MS` | `300` / `1000` | |
| `CW_TRANSCRIPTION_LIMIT_MIN` | `55` | 認識対象時間の上限（通話は切らない） |
| `CW_FINALIZE_WAIT_MS` | `10000` | 終話後に最後の確定結果を待つ時間 |
| `CW_AUDIO_QUEUE_MAX_MS` | `5000` | ASR 準備中・再接続中に保持する音声 |
| `CW_PARTIAL_MIN_INTERVAL_MS` | `500` | 途中結果の書込み間隔（話者ごと最大 2 回/秒） |
| `CW_MEDIA_TOKEN_TTL_SEC` | `300` | 監視 WS トークンの有効期限 |
| `CW_ASR_FAKE` | `false` | ローカル検証用の擬似エンジン（本番では起動拒否） |

## web

| 変数 | 既定 | 説明 |
| - | - | - |
| `CW_STATIC_DIR` | `../web/dist` | ビルド済み UI |
| `CW_MAX_SSE_CLIENTS` | `200` | インスタンスあたりの SSE 上限 |
| `CW_WEB_BASIC_AUTH_USER` | `callweave` | Basic 認証ユーザー |
| `CW_WEB_BASIC_AUTH_PASSWORD` 🔒 | — | Basic 認証パスワード（本番は 16 文字以上必須） |

🔒 = Secret Manager（`cw-vonage-private-key`、`cw-vonage-signature-secret`、`cw-media-token-secret`、
`cw-amivoice-appkey`、`cw-elevenlabs-api-key`、`cw-deepgram-api-key`）
