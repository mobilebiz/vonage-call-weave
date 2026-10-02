# データ定義（Firestore Native mode）

型定義の正は `server/src/shared/types.ts`。日時は UTC の ISO 8601 文字列、表示は Asia/Tokyo。
電話番号はキーに使わない。Firestore はサーバー経由でのみ使い、ブラウザへ直接公開しない。

| コレクション | キー | 主な項目 |
| - | - | - |
| `calls/{callId}` | `YYYYMMDDhhmmss-<10hex>` | callerNumber（正規化）, rawCallerNumber, callerNumberKind, calledNumber, engine, engineConfigVersion, receivedAt, sipAnsweredAt, operatorAnsweredAt（拡張用）, endedAt, callStatus, transcriptionStatus, endReason, recognitionBaseAt, inboundUuid, conversationName, roles{caller,operator}, limitReached, finalizeDeadlineAt, sipTargetUri（発信した接続先）, expiresAt, revision, updatedAt |
| `calls/{callId}/legs/{legId}` | `caller` / `sip` / `caller_ws-g{n}` / `operator_ws-g{n}` | role, generation, vonageUuid, status, createdAt, connectedAt, endedAt |
| `calls/{callId}/segments/{segmentId}` | `{role}-e{epoch}-s{seq}` | role, streamEpoch, text, startMs, endMs, timestampQuality（vendor / estimated）, isFinal, revision, providerResultId, receivedAt, updatedAt |
| `calls/{callId}/live/{role}` | `caller` / `operator` | 最新の途中結果: segmentId, revision, streamEpoch, text, startMs, unconfirmed, updatedAt |
| `calls/{callId}/gaps/{gapId}` | | role, startMs, endMs（null = 終了まで）, reason |
| `settings/app` | 固定 | sipTargetUri（null = 環境変数の既定値）, revision, updatedAt。画面の設定メニューで更新 |
| `settings/app/history/{revision}` | revision | 変更履歴（変更後の値と previous） |
| `legIndex/{vonageUuid}` | Vonage UUID | callId, legId, expiresAt（Webhook の逆引き） |
| `webhookEvents/{eventKey}` | `ev-<sha256>` / `input-{callId}-{attempt}` | status, result（Input の NCCO を再現）, receivedAt, expiresAt |
| `controlJobs/{jobId}` | `{callId}-{op}[-{role}]-g{世代}` | op, generation, params, status, attempts, lastError, lockedUntil, expiresAt |

## roles（話者ごとの認識状態）

| 項目 | 説明 |
| - | - |
| asrStatus | not_started / connecting / streaming / reconnecting / failed / finalizing / done |
| wsGeneration | 監視 WS の世代（0 = 未作成） |
| streamEpoch | ASR セッションの世代（ASR 再接続・WS 再作成で増加） |
| final | 最終化結果 completed / partial / null |
| startupGapMs | 応答から WS 確立までの未収録時間 |
| lastAudioMs / hadGap | 再作成時の欠落記録・完全性判定に使用 |

`transcriptionStatus` は roles から導出する（`deriveTranscriptionStatus`）。

## 時刻

- `startMs` / `endMs` は認識開始基準（SIP レッグ answered = `recognitionBaseAt`）からの相対 ms
- 各ストリームは「WS 接続時刻 − 基準時刻」（streamOffset）と受信サンプル数で位置を管理する
- ASR 再接続・WS 再作成時も時刻をゼロに戻さず、streamEpoch を増やす
- ベンダーの時刻がない結果は受信位置から推定し `timestampQuality=estimated`
- 表示順は startMs → role の固定順（caller → operator）→ segmentId。到着順は使わない

## 保存期間

- `expiresAt` = 終話 + 7 日（終話記録がない場合は着信 + 8 日）
- 期限以降は API が 410 を返す
- 削除は Cloud Scheduler（毎時）の `/internal/cron/cleanup` がサブコレクションごと実施（TTL に依存しない）
- 原音声は保存しない

## インデックス

`infra/terraform/firestore.tf` を参照（calls: callStatus + receivedAt、segments: startMs + segmentId、controlJobs: status + updatedAt）。
