#!/usr/bin/env bash
# ガード付き terraform。例: scripts/tf.sh plan / scripts/tf.sh apply
set -euo pipefail
source "$(dirname "$0")/lib.sh"
assert_project
tf_env
cd "${ROOT}/infra/terraform"

# Terraform の実効プロジェクトをガード済みの値に揃える。
# TF_VAR_* は tfvars より優先度が低いため、tfvars 側に別の値があれば取り違えとして止める
for f in terraform.tfvars *.auto.tfvars; do
  [[ -f "$f" ]] || continue
  v="$(sed -nE 's/^[[:space:]]*project_id[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$f" | tail -1)"
  [[ -z "$v" || "$v" == "$CW_GCP_PROJECT_ID" ]] || die "$f の project_id=${v} が deploy/callweave.env の ${CW_GCP_PROJECT_ID} と一致しません"
done

# state バケットは名前がグローバルなため、所属プロジェクトを init 前に確認する
: "${CW_TF_STATE_BUCKET:?}"
bucket_pn="$(curl -sf -H "Authorization: Bearer ${GOOGLE_OAUTH_ACCESS_TOKEN}" \
  "https://storage.googleapis.com/storage/v1/b/${CW_TF_STATE_BUCKET}?fields=projectNumber" \
  | sed -nE 's/.*"projectNumber": *"([0-9]+)".*/\1/p')" \
  || die "state バケット gs://${CW_TF_STATE_BUCKET} を参照できません"
project_pn="$(cw_gcloud projects describe "$CW_GCP_PROJECT_ID" --format='value(projectNumber)')"
[[ -n "$bucket_pn" && "$bucket_pn" == "$project_pn" ]] \
  || die "state バケット gs://${CW_TF_STATE_BUCKET} は ${CW_GCP_PROJECT_ID}（${project_pn}）のものではありません（${bucket_pn:-不明}）"

terraform init -input=false -reconfigure -backend-config="bucket=${CW_TF_STATE_BUCKET}" >/dev/null
terraform "$@"
