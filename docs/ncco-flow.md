# NCCO と呼制御手順

## Vonage アプリケーション設定（CallWeave 専用アプリ）

| 項目 | 値 |
| - | - |
| Answer URL | `POST {control}/webhooks/vonage/answer` |
| Event URL | `POST {control}/webhooks/vonage/events` |
| Fallback URL | `POST {control}/webhooks/vonage/fallback` |
| Signed webhooks | **有効**（Show advanced features → Use signed webhooks） |
| 050 番号 | このアプリだけにリンク |

`{control}` は `scripts/tf.sh output vonage_answer_url` などで確認する。
Answer / Event を GET で受けても動作するが、POST を推奨（本文が署名対象になる）。

## 1 通話 = 4 レッグ

| レッグ | 作り方 | conversation NCCO |
| - | - | - |
| 発信者（PSTN 着信） | 着信 | `name=cw-{callId}`, `endOnExit=true`（保留音設定時は `startOnEnter=false`） |
| SIP / PBX | `POST /v1/calls`（to: sip） | `canHear=[発信者UUID]`, `endOnExit=true` |
| 発信者監視 WS | `POST /v1/calls`（to: websocket） | `canHear=[発信者UUID]`, `canSpeak=[]` |
| オペレーター監視 WS | `POST /v1/calls`（to: websocket） | `canHear=[SIP UUID]`, `canSpeak=[]` |

- Conversation 名は `cw-{callId}`。電話番号を名前やキーに使わない
- 監視 WS は `canSpeak: []` のため、人間側には一切音声を送らない
- 発信者レッグの `canHear` は SIP UUID が確定前のため省略。監視 WS は誰にも話さないので、
  発信者に聞こえるのは SIP 側（と保留音）のみ
- SIP と WS を 1 つの NCCO に並べる方式は使わない（同時分岐にならない）。
  呼制御サービスが独立したレッグを生成して同じ Conversation に参加させる

### 監視 WS エンドポイント

```json
{
  "type": "websocket",
  "uri": "wss://{media}/media/vonage",
  "content-type": "audio/l16;rate=16000",
  "headers": { "callId": "…", "role": "caller", "gen": 1 },
  "authorization": { "type": "custom", "value": "Bearer <callId/role/世代付き JWT>" }
}
```

`headers` は WS 確立後の最初の JSON メタデータとして届く（認証には使わない）。
認証は `authorization` で送られる HTTP ヘッダーで、音声中継サービスが期限・callId・role・世代を検証する。
世代が古いトークン（再作成前のレッグ）は 1008 で切断する。

## シーケンス

```
着信 ─▶ answer: 通話レコード作成（IVR より前）→ IVR NCCO（talk + input dtmf 1 桁 / 10 秒）
DTMF ─▶ input: 1/2/3 → engine 保存・callStatus=dialing → NCCO（案内 + conversation）
               → ジョブ dialSip（SIP レッグ作成、ringing_timer=30）
         不正・無入力 1 回目 → 再案内 / 2 回目 → 案内して終了（failed: ivr_no_selection）
SIP answered ─▶ callStatus=active、recognitionBaseAt=応答時刻
               → ジョブ createMonitor(caller, gen1) / createMonitor(operator, gen1)
WS 接続 ─▶ media: トークン検証 → ASR セッション開始 → 認識
人間側終了 ─▶ callStatus=ended → ジョブ hangupLegs（相手・監視 WS を切断）
               → media: 取込停止 → 残りを ASR へ → finalize（最大 10 秒）→ 話者ごと final
               → 両話者 final → transcriptionStatus=completed / partial → ダウンロード可
```

### 異常系

| 事象 | 動作 |
| - | - |
| SIP busy / rejected / unanswered / timeout / failed | `callStatus=failed`、`endReason=sip_*`。発信者へ案内（transfer NCCO）して終了 |
| SIP 発信 API がタイムアウト | 失敗と即断しない。レッグを `unknown` にし、イベント到着か照合（60 秒）で判断。再発信しない |
| 監視 WS だけ切断 | 人間側が通話中なら新世代で再作成（最大 3 回）。前世代の終了〜新世代の開始を欠落として記録 |
| IVR 中・呼出中の切断 | `abandoned`（`ivr_hangup` / `dialing_hangup`） |
| Webhook の重複・順序逆転 | 本文ハッシュ付きキーで重複排除。終了済みレッグへの逆行イベントは無視。active へは戻さない |
| Webhook 欠落 | 1 分ごとの照合で Vonage の通話状態を取得し、終了済みなら終話処理 |
| 55 分到達 | `limitReached=true`、監視 WS を閉じる。通話は継続し、UI に上限到達を表示 |

## 応答判定の注意

- PSTN 着信レッグの answered は IVR 開始時点で発生するため使わない
- SIP レッグの answered を認識開始基準にする。PBX がキュー等で先に 200 OK を返す場合、
  その後の案内音声もオペレーター側として認識される（PBX 内部イベント連携は対象外）
- Brekeke 側は Vonage の SIP 送信元 IP を許可する。`CW_SIP_TARGET_URI` はデプロイ時に設定し、コードに固定しない
