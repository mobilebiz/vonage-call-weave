#!/usr/bin/env bash
# Secret Manager に秘密情報の版を追加する。値は画面に表示せず、Terraform state にも残さない。
#   scripts/set-secrets.sh            対話入力（未設定のものだけ）
#   scripts/set-secrets.sh --all      すべて再入力
set -euo pipefail
source "$(dirname "$0")/lib.sh"
assert_project
ALL="${1:-}"
# 秘密情報は画面に出さず入力するため、端末（TTY）から実行する必要がある
INTERACTIVE=1
[[ -t 0 ]] || INTERACTIVE=0
need_tty() { [[ $INTERACTIVE == 1 ]] || die "対話入力が必要です。通常のターミナルで ${ROOT}/scripts/set-secrets.sh を実行してください（Claude Code の ! からは入力できません）"; }

has_version() { cw_gcloud secrets versions list "$1" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null | grep -q .; }

add_from_stdin() { cw_gcloud secrets versions add "$1" --data-file=- >/dev/null && echo "  ✓ $1"; }

prompt_secret() {
  local name="$1" label="$2" v
  if [[ "$ALL" != "--all" ]] && has_version "$name"; then echo "  - $name は設定済み（--all で再設定）"; return; fi
  need_tty
  read -r -s -p "$label: " v; echo
  [[ -n "$v" ]] || { echo "  - $name をスキップ"; return; }
  printf '%s' "$v" | add_from_stdin "$name"
}

echo "Vonage 秘密鍵（${ROOT}/private.key）"
if [[ "$ALL" == "--all" ]] || ! has_version cw-vonage-private-key; then
  [[ -f "${ROOT}/private.key" ]] || die "private.key がありません"
  cw_gcloud secrets versions add cw-vonage-private-key --data-file="${ROOT}/private.key" >/dev/null && echo "  ✓ cw-vonage-private-key"
else
  echo "  - cw-vonage-private-key は設定済み"
fi

if [[ "$ALL" == "--all" ]] || ! has_version cw-media-token-secret; then
  openssl rand -base64 48 | tr -d '\n' | add_from_stdin cw-media-token-secret
else
  echo "  - cw-media-token-secret は設定済み"
fi

prompt_secret cw-vonage-signature-secret "Vonage 署名シークレット（Dashboard > API Settings）"
prompt_secret cw-amivoice-appkey "AmiVoice APPKEY"
prompt_secret cw-elevenlabs-api-key "ElevenLabs API キー"
prompt_secret cw-deepgram-api-key "Deepgram API キー"

echo "WebUI の Basic 認証パスワード（ユーザー名は terraform.tfvars の web_basic_auth_user、既定 callweave）"
if [[ "$ALL" == "--all" ]] || ! has_version cw-web-basic-auth-password; then
  need_tty
  read -r -s -p "パスワード（16 文字以上。空 Enter で自動生成）: " v; echo
  if [[ -z "$v" ]]; then
    v="$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-24)"
    echo "  生成したパスワード（この画面にのみ表示。共有方法は社内で管理してください）: $v"
  fi
  [[ ${#v} -ge 16 ]] || die "16 文字以上にしてください"
  printf '%s' "$v" | add_from_stdin cw-web-basic-auth-password
else
  echo "  - cw-web-basic-auth-password は設定済み（--all で再設定）"
fi
