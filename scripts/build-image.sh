#!/usr/bin/env bash
# Cloud Build でイメージを作り、CallWeave の Artifact Registry に push する。イメージ名を出力する
set -euo pipefail
source "$(dirname "$0")/lib.sh"
assert_project
TAG="${1:-$(date +%Y%m%d-%H%M%S)}"
IMAGE="${CW_REGION}-docker.pkg.dev/${CW_GCP_PROJECT_ID}/callweave/callweave:${TAG}"
BUILD_SA="projects/${CW_GCP_PROJECT_ID}/serviceAccounts/cw-build@${CW_GCP_PROJECT_ID}.iam.gserviceaccount.com"
cd "$ROOT"
cw_gcloud builds submit --region="$CW_REGION" --config=cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" --service-account="$BUILD_SA" \
  --default-buckets-behavior=regional-user-owned-bucket . >&2
echo "$IMAGE"
