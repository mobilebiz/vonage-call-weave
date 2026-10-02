# 環境の分離（他プロジェクトと混ぜない）

CallWeave は、同じ開発端末で扱う他のプロジェクトとは全く別のプロジェクトとして扱う。
開発端末には他プロジェクトの既定値が残っていることが多く、暗黙の解決に頼ると誤ったプロジェクトへ書き込む危険がある。

| 既定値 | よくある状態 | CallWeave での扱い |
| - | - | - |
| `GOOGLE_CLOUD_PROJECT` | シェルの設定で他プロジェクトを指している | **参照しない**。プロジェクトは `CW_GCP_PROJECT_ID` のみ |
| gcloud アクティブ構成 | `default` 構成が他プロジェクトを指している | **使わない・切り替えない**。専用構成 `callweave` を `CLOUDSDK_ACTIVE_CONFIG_NAME` で指定 |
| ADC（application default credentials） | 他用途と共用 | Terraform は専用構成のアクセストークン（`GOOGLE_OAUTH_ACCESS_TOKEN`）で実行 |
| Vonage アプリ | 他プロジェクト用のアプリがある | CallWeave 専用アプリと専用 050 番号のみ |

取り違えを防ぎたい他プロジェクトの識別子は、正規表現 `CW_FORBIDDEN_PROJECT_PATTERN`（例: `project-a|project-b`）で与える。
リポジトリには含めず、`deploy/callweave.env` と `infra/terraform/terraform.tfvars`（`forbidden_project_pattern`、いずれも git 管理外）に書く。

## 多重の安全装置

1. **アプリ起動時**（`server/src/config.ts`）
   - 設定は `CW_` 接頭辞のみ読む。`GOOGLE_CLOUD_PROJECT` や `VONAGE_*` を拾わない
   - `CW_GCP_PROJECT_ID` が `CW_FORBIDDEN_PROJECT_PATTERN` に一致したら起動しない
   - Cloud Run 上では、メタデータサーバーの実行プロジェクトと `CW_GCP_PROJECT_ID` の一致を確認
   - `CW_FORBIDDEN_VONAGE_APP_IDS` に他プロジェクトの Vonage アプリ ID を列挙すると、誤設定時に起動しない
   - Firestore / Cloud Tasks クライアントには projectId を明示的に渡す
2. **スクリプト**（`scripts/lib.sh`、`scripts/tf.sh`）
   - `deploy/callweave.env` の値だけを使い、`GOOGLE_CLOUD_PROJECT` 等を unset
   - `CLOUDSDK_ACTIVE_CONFIG_NAME=callweave` を強制し、すべての gcloud に `--project` を付与。`default` 構成は拒否
   - gcloud 構成のプロジェクトとアカウントが期待値と一致しなければ停止
   - `terraform.tfvars` の `project_id` が `deploy/callweave.env` と食い違えば停止
   - Terraform state バケットの所属プロジェクトを init 前に確認
3. **Terraform**
   - provider に `project` / `billing_project` を明示
   - `project_id` が `forbidden_project_pattern` に一致すれば plan 時点で停止（precondition）
   - state は CallWeave プロジェクト内のバケットに分離
4. **ローカル開発**
   - 既定はメモリストア・擬似 ASR で GCP に接続しない（`npm run sim`）

## Vonage

- CallWeave 専用アプリを作成し、秘密鍵はリポジトリ直下 `private.key` に置く（git / Docker / Cloud Build から除外）
- 署名シークレットは Vonage アカウント（API キー）単位。可能であれば CallWeave 用サブアカウントを使い、
  他プロジェクトと署名シークレット・課金を分ける
- 050 番号は CallWeave アプリだけにリンクする
