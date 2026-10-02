#!/usr/bin/env bash
# 初回/通常デプロイ:
#   1) 基盤（API・AR・SA・Secret 容器）を作成  2) イメージをビルド  3) 秘密情報の確認  4) 全体を apply
set -euo pipefail
source "$(dirname "$0")/lib.sh"
assert_project
cd "$ROOT"

echo "== 1/4 基盤"
# 初回のみ基盤だけを作る。2 回目以降に deploy_services=false で apply すると稼働中のサービスを削除してしまう
# state を取得できないとき（通信・認証エラー）に初回扱いすると稼働中のサービスを削除するため、停止する
STATE="$(scripts/tf.sh state list)" || die "Terraform state を取得できませんでした。初回構築と区別できないため中止します"
if [[ -n "$STATE" ]]; then
  echo "既存環境: 基盤ステップをスキップ"
else
  echo "初回構築: 基盤だけを作成"
  scripts/tf.sh apply -input=false -auto-approve -var="deploy_services=false" -var="image=unused"
fi

echo "== 2/4 イメージ"
IMAGE="${CW_IMAGE:-$(scripts/build-image.sh | tail -1)}"
echo "image: $IMAGE"

echo "== 3/4 秘密情報"
for s in cw-vonage-private-key cw-vonage-signature-secret cw-media-token-secret cw-amivoice-appkey cw-elevenlabs-api-key cw-deepgram-api-key cw-web-basic-auth-password; do
  cw_gcloud secrets versions list "$s" --filter='state=ENABLED' --limit=1 --format='value(name)' | grep -q . \
    || die "$s に値がありません。scripts/set-secrets.sh を実行してください"
done

echo "== 4/4 サービス"
scripts/tf.sh apply -input=false -auto-approve -var="image=${IMAGE}"
scripts/tf.sh output
