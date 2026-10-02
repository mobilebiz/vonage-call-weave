# CallWeave（vonage-call-weave）

Vonage の 050 番号への着信を既存の Brekeke PBX へ SIP 接続し、発信者・オペレーター双方の通話音声を
リアルタイムに文字起こしして、複数のブラウザから会話形式で閲覧するシステム。
音声認識エンジンは着信時の IVR で選択する（1 = AmiVoice、2 = ElevenLabs、3 = Deepgram）。


## 構成

```
Caller ⇄ Vonage Conversation (cw-{callId}) ⇄ SIP ⇄ Brekeke PBX ⇄ Operator
             │ 発信者監視 WS (canHear=[caller], canSpeak=[])
             │ オペレーター監視 WS (canHear=[sip], canSpeak=[])
             ▼
   callweave-media (Cloud Run) ⇄ AmiVoice / ElevenLabs / Deepgram
             │
          Firestore ◀── callweave-control (Webhook / Cloud Tasks / Scheduler)
             │
   callweave-web (Cloud Run, LB + Cloud Armor) ── SSE / REST ──▶ Browser
```

| ディレクトリ | 内容 |
| - | - |
| `server/` | Node.js 24 + TypeScript + Fastify。`CW_SERVICE` で control / media / web を切替（1 イメージ） |
| `server/src/control` | Answer / Input / Event Webhook、IVR、SIP・監視 WS レッグ作成、冪等ジョブ、照合、削除 |
| `server/src/media` | Vonage 監視 WS 受信、ASR アダプター（AmiVoice / ElevenLabs / Deepgram）、正規化・欠落記録 |
| `server/src/web` | REST、SSE、TXT / JSON エクスポート、静的 UI 配信 |
| `web/` | React + Vite の WebUI（通話一覧・会話ログ） |
| `infra/terraform` | GCP 一式（API、SA、Firestore、Secret Manager、Cloud Run、Tasks、Scheduler、LB、Cloud Armor、監視） |
| `scripts/` | プロジェクト取り違え防止ガード付きの gcloud / terraform / デプロイスクリプト |
| `docs/` | 環境変数、NCCO と呼制御、データ定義、OpenAPI、運用手順、受入試験 |

## ローカルで試す（GCP・Vonage・ASR に接続しない）

```bash
npm install
npm run build -w web
npm run sim            # http://localhost:8080 — 擬似着信が自動で発生する
npm test               # サーバーの単体・結合テスト
```

`npm run sim` はメモリストア・プロセス内キュー・擬似 ASR・擬似電話網で、Vonage と同じ順序の
Webhook と 16kHz PCM を流して全経路を動かす。

UI 開発時は `npm run sim` を動かしたまま `npm run dev:web`（http://localhost:5173、API は 8080 へ中継）。

## 実機 Vonage でローカル実行

1. `cp env.local.example .env` を作り、`CW_VONAGE_*`、`CW_SIP_TARGET_URI`、ASR キーを設定（`CW_ASR_FAKE=0`）
2. ngrok 等で 8080 を公開し、`CW_CONTROL_BASE_URL` / `CW_MEDIA_WS_URL`（`wss://.../media/vonage`）を設定
3. Vonage アプリの Answer URL / Event URL を `docs/ncco-flow.md` のとおり設定
4. `npm run build -w web && npm run dev`

## GCP へのデプロイ（空のプロジェクトから）

手順は [docs/operations.md](docs/operations.md) の「初回構築」。

```bash
cp deploy/callweave.env.example deploy/callweave.env               # 専用プロジェクト ID 等
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
scripts/00-gcloud-config.sh     # 専用 gcloud 構成 callweave を作成（default 構成は変更しない）
scripts/01-bootstrap.sh         # 最低限の API と Terraform state バケット
scripts/tf.sh apply -var=deploy_services=false -var=image=unused   # 基盤（SA / Secret 容器 等）
scripts/set-secrets.sh          # Vonage 秘密鍵・署名シークレット・ASR キー
scripts/deploy.sh               # イメージビルド → 全体 apply
```

## 設定画面

画面右上の「設定」から、オペレーター接続先（PBX の SIP URI）を変更できる。

- 保存した値は Firestore `settings/app` に保存され、**次の着信から**反映される（通話中の通話には影響しない）
- 未設定時・「既定値に戻す」ときは、デプロイ時の `sip_target_uri`（環境変数 `CW_SIP_TARGET_URI`）を使う
- 各通話で実際に発信した接続先は、通話詳細の「接続先」に残る
- 同時に別の画面で更新された場合は上書きせず、再読み込みを求める

## 音声認識エンジンの処理リージョン（2026-10-03 時点）

CallWeave 自身（Cloud Run・Firestore）は GCP 東京リージョン（asia-northeast1）で動作し、原音声は保存しない。
ただし通話音声は、選択したエンジンの事業者の環境へ送られて処理される。

| エンジン | 処理・保存の場所 | ログ・学習利用 | CallWeave の現在の設定 |
| - | - | - | - |
| AmiVoice | **国内**。国内で開発・運用され、音声データは海外へ送信されない | ログ保存なしのエンドポイント（`/v1/nolog/`）を選べる（単価は保存ありより高い） | `wss://acp-api.amivoice.com/v1/nolog/`（ログ保存なし） |
| ElevenLabs | **米国**（既定）。EU・インド・シンガポールのデータレジデンシー環境は Enterprise 契約のみで、それ以外は所在地に関係なく米国環境で処理される | `enable_logging=false` を指定しているが、契約によっては適用されない場合があり、設定だけで無保存とは判断できない | 既定の米国エンドポイント、`enable_logging=false` |
| Deepgram | **米国**（既定）。EU エンドポイント（`api.eu.deepgram.com`）は一般提供済みで、指定すると EU 内で処理が完結する（障害時も域外へフォールバックしない）。日本・アジアのエンドポイントはない | Model Improvement Program（学習利用）の扱いがある。`mip_opt_out=true` を付けたリクエストは処理に必要な期間だけ保持される。オプトアウト時の料金への影響は契約条件で要確認 | 既定の米国エンドポイント、`mip_opt_out` は未指定 |

- **国外への音声送信を避けたい通話では AmiVoice を選ぶ**のが現状唯一の選択肢
- ElevenLabs・Deepgram は東京から米国への往復が入るため、遅延（途中結果が出るまでの時間）でも不利になり得る。実測は受入試験（仕様書 12 節）で行う
- 接続先は環境変数で変更できる（`CW_ELEVENLABS_URL`、`CW_DEEPGRAM_URL`）。EU 環境を使う場合は、それぞれ `wss://api.eu.residency.elevenlabs.io/v1/speech-to-text/realtime`（Enterprise 契約が必要）、`wss://api.eu.deepgram.com/v1/listen`
- 各社の契約上のログ保存・学習利用・処理地域は、利用開始前に契約書で確認する（仕様書 13 節）

出典: [AmiVoice API](https://acp.amivoice.com/en/amivoice_api/) / [AmiVoice サービス仕様](https://docs.amivoice.com/en/amivoice-api/manual/specification) / [ElevenLabs Data residency](https://elevenlabs.io/docs/overview/administration/data-residency) / [Deepgram EU Endpoint GA](https://deepgram.com/learn/deepgram-eu-endpoint-now-generally-available) / [Deepgram Model Improvement Program](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program)

## コスト試算（2026-10-02 時点）

1 通話で音声認識ストリームを 2 本（発信者・オペレーター）使うため、ASR 料金は通話時間の 2 倍になる。
Vonage 単価は試験通話の通話記録（`rate`）から取得した実績値（秒課金）。通貨は USD と仮定し 1 USD = 150 円で換算。

### 通話 1 分あたりの変動費

| 内訳 | AmiVoice | ElevenLabs | Deepgram |
| - | - | - | - |
| Vonage（着信 0.01091 + SIP 0.00364 + 監視 WS 0.004 × 2 = 0.02255/分） | 3.38 円 | 3.38 円 | 3.38 円 |
| 音声認識 × 2 本 | 4.95 円 | 1.95 円 | 1.44 円 |
| **合計／分** | **約 8.3 円** | **約 5.3 円** | **約 4.8 円** |

| エンジン | 単価の根拠 |
| - | - |
| AmiVoice | 汎用エンジン・ログ保存なし 148.5 円/時（税込、秒課金）。ログ保存ありは 99 円/時。各エンジン月 60 分無料 |
| ElevenLabs | Scribe v2 Realtime $0.39/時。月額プラン（Starter $6〜Business $990）の含有時間超過分がこの単価 |
| Deepgram | Nova-3（言語固定）$0.0048/分。キャンペーン価格で通常は $0.0077/分（通常価格なら約 5.7 円/分）。多言語版は $0.0058/分 |

### 月額の例（1,000 通話 × 平均 5 分 = 5,000 分）

| | AmiVoice | ElevenLabs | Deepgram |
| - | - | - | - |
| 変動費 | 約 41,700 円 | 約 26,700 円（＋プラン月額） | 約 24,100 円 |
| 固定費 | 約 29,000 円 | 約 29,000 円 | 約 29,000 円 |
| **合計** | **約 70,700 円** | **約 55,700 円〜** | **約 53,100 円** |

### 固定費（エンジンに関係なく毎月）

| 項目 | 月額 |
| - | - |
| Cloud Run 3 サービス × 常時 1 台（計 4 vCPU・2 GiB、東京 vCPU $0.000018/秒・メモリ $0.000002/GiB 秒） | 約 $192（約 29,000 円） |
| Firestore・Cloud Tasks・Scheduler・Secret Manager・ログ | 数十円程度（ほぼ無料枠内） |
| 050 番号の月額 | 未算出（Vonage ダッシュボードで確認） |

- Vonage 分はエンジンに関係なく同額。エンジン差は ASR 料金で、AmiVoice は他 2 社の約 2.5〜3.5 倍
- 通話量が少ない場合は固定費が支配的。音声中継を 1 vCPU にし、web を常時起動しない設定にすると月 1.5 万円前後まで下げられる見込み（同時 10 通話での負荷試験が前提）
- 不確定要素: Vonage アカウントの通貨（EUR 建てなら Vonage 分は約 1 割高）、Deepgram のキャンペーン期間、消費税（AmiVoice のみ税込）

出典: [AmiVoice API 料金](https://acp.amivoice.com/amivoice_api/price/) / [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) / [Deepgram pricing](https://deepgram.com/pricing) / [Vonage voice pricing の仕組み](https://api.support.vonage.com/hc/en-us/articles/204015203-How-does-voice-pricing-work-for-inbound-and-outbound-calls) / Cloud Billing Catalog API（Cloud Run asia-northeast1）

## ドキュメント

- [docs/isolation.md](docs/isolation.md) — 他プロジェクトとの環境分離
- [docs/environment.md](docs/environment.md) — 環境変数一覧
- [docs/ncco-flow.md](docs/ncco-flow.md) — NCCO と呼制御手順、Vonage アプリ設定
- [docs/data-model.md](docs/data-model.md) — Firestore データ定義
- [docs/openapi.yaml](docs/openapi.yaml) — API 定義
- [docs/operations.md](docs/operations.md) — 構築・運用手順
- [docs/acceptance.md](docs/acceptance.md) — PoC・受入試験の対応表
