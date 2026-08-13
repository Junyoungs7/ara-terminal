#!/usr/bin/env bash
# macOS ad-hoc 서명 — F1~F7 실기기 개발 스모크용 (계획서 §B.6). 배포용 아님.
# Gatekeeper 우회: ad-hoc 서명(--sign -) + quarantine 속성 제거.
set -euo pipefail

APP="${1:-dist/mac/A.R.A.app}"

if [[ ! -d "$APP" ]]; then
  echo "앱 번들을 찾을 수 없습니다: $APP" >&2
  echo "사용법: scripts/sign-adhoc.sh <path-to-.app>" >&2
  exit 1
fi

echo "ad-hoc 서명: $APP"
codesign --sign - --force --deep "$APP"
echo "quarantine 속성 제거"
xattr -cr "$APP"
echo "완료 — 개발 스모크용 ad-hoc 서명 적용됨 (정식 배포 서명 아님)"
