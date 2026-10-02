#!/usr/bin/env bash
# 空のプロジェクト（オーナーのみ）から Terraform を動かせる状態にする:
#   最低限の API 有効化と、Terraform state 用バケットの作成
set -euo pipefail
source "$(dirname "$0")/lib.sh"
assert_project
: "${CW_TF_STATE_BUCKET:?}"

cw_gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
  storage.googleapis.com iam.googleapis.com

if ! cw_gcloud storage buckets describe "gs://${CW_TF_STATE_BUCKET}" >/dev/null 2>&1; then
  cw_gcloud storage buckets create "gs://${CW_TF_STATE_BUCKET}" \
    --location="$CW_REGION" --uniform-bucket-level-access --public-access-prevention
  cw_gcloud storage buckets update "gs://${CW_TF_STATE_BUCKET}" --versioning
fi
echo "bootstrap 完了: state bucket gs://${CW_TF_STATE_BUCKET}"
