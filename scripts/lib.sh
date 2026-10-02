#!/usr/bin/env bash
# 共通ガード。すべての gcloud / terraform 操作を CallWeave 専用プロジェクトに固定する。
# シェルの GOOGLE_CLOUD_PROJECT や gcloud の default 構成（他プロジェクト向けの可能性がある）は使わない。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/deploy/callweave.env"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "deploy/callweave.env がありません（deploy/callweave.env.example をコピー）"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${CW_GCP_PROJECT_ID:?}" "${CW_REGION:?}" "${CW_GCLOUD_CONFIG:?}" "${CW_GCLOUD_ACCOUNT:?}"
# 取り違えを防ぎたい他プロジェクトの識別子（正規表現、任意）。例: CW_FORBIDDEN_PROJECT_PATTERN='project-a|project-b'
FORBIDDEN_RE="${CW_FORBIDDEN_PROJECT_PATTERN:-}"
shopt -s nocasematch
if [[ -n "$FORBIDDEN_RE" ]]; then
  [[ "$CW_GCP_PROJECT_ID" =~ $FORBIDDEN_RE ]] && die "CW_GCP_PROJECT_ID=${CW_GCP_PROJECT_ID} は他プロジェクトです"
  [[ "$CW_GCLOUD_CONFIG" =~ ^($FORBIDDEN_RE)$ ]] && die "CW_GCLOUD_CONFIG に ${CW_GCLOUD_CONFIG} は使えません"
fi
[[ "$CW_GCLOUD_CONFIG" == "default" ]] && die "CW_GCLOUD_CONFIG に default 構成は使えません（専用構成を作成してください）"
shopt -u nocasematch
# Terraform の取り違え防止にも同じパターンを渡す
export TF_VAR_forbidden_project_pattern="$FORBIDDEN_RE"

# 他プロジェクトの環境変数を無効化し、専用構成を強制する
unset GOOGLE_CLOUD_PROJECT CLOUDSDK_CORE_PROJECT GCLOUD_PROJECT GOOGLE_APPLICATION_CREDENTIALS
export CLOUDSDK_ACTIVE_CONFIG_NAME="$CW_GCLOUD_CONFIG"

cw_gcloud() { gcloud --project="$CW_GCP_PROJECT_ID" "$@"; }

assert_project() {
  local cur
  cur="$(gcloud config get-value project 2>/dev/null || true)"
  [[ "$cur" == "$CW_GCP_PROJECT_ID" ]] || die "gcloud 構成 ${CW_GCLOUD_CONFIG} のプロジェクトが ${cur:-未設定} です（期待値 ${CW_GCP_PROJECT_ID}）。scripts/00-gcloud-config.sh を実行してください"
  local acct
  acct="$(gcloud config get-value account 2>/dev/null || true)"
  [[ "$acct" == "$CW_GCLOUD_ACCOUNT" ]] || die "gcloud 構成のアカウントが ${acct:-未設定} です（期待値 ${CW_GCLOUD_ACCOUNT}）"
  cw_gcloud projects describe "$CW_GCP_PROJECT_ID" --format='value(projectId)' >/dev/null \
    || die "プロジェクト ${CW_GCP_PROJECT_ID} にアクセスできません"
  echo "→ project=${CW_GCP_PROJECT_ID} config=${CW_GCLOUD_CONFIG} account=${acct}" >&2
}

# Terraform は ADC（他プロジェクト用の可能性あり）ではなく、専用構成のアクセストークンを使う
tf_env() {
  export GOOGLE_OAUTH_ACCESS_TOKEN
  GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"
  export TF_VAR_project_id="$CW_GCP_PROJECT_ID"
  export TF_VAR_region="$CW_REGION"
}
