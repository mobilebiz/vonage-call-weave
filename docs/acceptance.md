# PoC・受入試験の対応表（仕様書 14 節）

「自動」はリポジトリのテスト（`npm test`）で擬似電話網・擬似 ASR により検証済みの論理。
「実機」は実回線・Brekeke・各 ASR 契約での確認が必要な項目（未実施）。

| テスト | 合格条件 | 自動 | 実機で確認すること |
| - | - | - | - |
| 音声分離 | 逆側ストリームへデジタル混合されない | 監視 WS の `canHear` が対象 1 レッグのみ（flow.test） | 片側だけ話す試験で逆側に文字が出ない |
| 同時発話 | 両方取得、話者ラベル不変 | 話者は入力ストリーム固定・同時刻は両方保持（unit.test） | 実音声で同時に話す |
| 監視の無音性 | WS の音が人間に聞こえない | `canSpeak: []`（flow.test） | 実機で確認 |
| 応答判定 | SIP answered で認識開始 | flow.test | PBX の先行 200 OK の有無 |
| IVR | 1/2/3・不正・無入力・切断 | flow.test（不正 2 回・再入力・エンジン選択） | 実 DTMF |
| 日本語認識 | 途中・確定・終話 flush | アダプターの解析（asr.test） | 各社の実接続、キー・契約 |
| 多重着信 | 10 通話でログが混ざらない | callId 単位のキー・SSE の callId 拒否 | 同一番号・非通知を含む 10 通話 |
| 複数画面 | 20 ブラウザで整合 | revision による置換 | 負荷試験 |
| 終話 | 両側切断・呼出中切断・WS のみ切断を区別 | flow.test（caller_hangup、WS 切断の再作成） | オペレーター側切断 |
| 障害 | ASR 停止でも通話継続 | fatal / 再試行の分類（asr.test） | ASR キー無効化試験 |
| 冪等性 | 重複・順序逆転で重複しない | flow.test（answer 重複、answered 重複、ringing 逆行） | |
| 再表示 | 更新後に確定ログ復元 | SSE 再接続時にスナップショット再取得 | |
| エクスポート | UI と一致 | flow.test（TXT / JSON、ファイル名に番号なし、no-store） | |
| 保存期限 | 期限切れ閲覧不可・子データ削除 | 410 応答・cleanup のカスケード削除 | Firestore 上で確認 |
| 制限境界 | 55 分上限表示 | 上限タイマー・照合の保険 | 実通話 55 分超 |
| アクセス | 許可外・直接 URL を拒否 | — | Cloud Armor・ingress |

## PoC で最初に確定すること（仕様書 15 節 1）

1. SIP レッグ answered の意味（Brekeke が先行応答するか）
2. 4 レッグ構成と `canHear` / `canSpeak` の実際の分離
3. 発信者レッグの `canHear` 省略で問題がないか（SIP UUID 確定後の更新が必要か）
4. Vonage の WS 音声が 16kHz / 16bit LE / 20ms フレームであること
5. SIP From に発信者番号を使えるか（`CW_SIP_FROM_MODE`）
6. 冒頭欠落量（`startupGapMs`）の実測
