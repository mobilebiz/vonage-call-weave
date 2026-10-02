#!/usr/bin/env bash
# CallWeave 専用の gcloud 構成を作る（default 構成は変更しない・切り替えない）
set -euo pipefail
source "$(dirname "$0")/lib.sh"

if ! gcloud config configurations describe "$CW_GCLOUD_CONFIG" >/dev/null 2>&1; then
  gcloud config configurations create "$CW_GCLOUD_CONFIG" --no-activate
fi
gcloud config set account "$CW_GCLOUD_ACCOUNT" --configuration="$CW_GCLOUD_CONFIG"
gcloud config set project "$CW_GCP_PROJECT_ID" --configuration="$CW_GCLOUD_CONFIG"
gcloud config set run/region "$CW_REGION" --configuration="$CW_GCLOUD_CONFIG"
gcloud config set compute/region "$CW_REGION" --configuration="$CW_GCLOUD_CONFIG"
echo "gcloud 構成 ${CW_GCLOUD_CONFIG} を作成しました（アクティブ構成は変更していません）"
assert_project
