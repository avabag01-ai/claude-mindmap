#!/bin/sh
# 이 맥 전용 고정 서명 인증서 만들기 (한 번만). tauri.conf.json 의 signingIdentity 가 이 이름을 쓴다.
# 서명이 빌드마다 같아서 다시 빌드해도 손쉬운 사용 같은 권한이 안 풀린다.
# 다른 맥에서 빌드하려면 그 맥에서도 한 번 돌린다 (인증서가 없으면 빌드의 서명 단계가 실패한다).
set -e
N="Claude Mindmap Local Signing"
if security find-identity -p codesigning | grep -q "\"$N\""; then echo "이미 있어요: $N"; exit 0; fi
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
openssl req -x509 -newkey rsa:2048 -keyout "$D/key.pem" -out "$D/cert.pem" -days 3650 -nodes -subj "/CN=$N" \
    -addext "extendedKeyUsage=critical,codeSigning" -addext "keyUsage=critical,digitalSignature" -addext "basicConstraints=critical,CA:false"
P=$(openssl rand -hex 12)
LEGACY=$(openssl version | grep -q '^OpenSSL 3' && echo -legacy || true)
openssl pkcs12 -export $LEGACY -out "$D/id.p12" -inkey "$D/key.pem" -in "$D/cert.pem" -name "$N" -passout "pass:$P"
security import "$D/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$P" -T /usr/bin/codesign
echo "만들었어요: $N (신뢰 표시 없음은 괜찮아요 — 서명은 됩니다)"
