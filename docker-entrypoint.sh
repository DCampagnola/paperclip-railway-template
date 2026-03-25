#!/usr/bin/env sh
set -eu

export HOME="${HOME:-/paperclip}"
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME}"
export HOST="${HOST:-0.0.0.0}"

INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"

mkdir -p "$PAPERCLIP_HOME" "$PAPERCLIP_HOME/instances/$INSTANCE_ID/logs"

# Railway usually provides only the hostname. Paperclip needs a full public URL
# for authenticated/public mode onboarding.
if [ -z "${PAPERCLIP_PUBLIC_URL:-}" ] && [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  export PAPERCLIP_PUBLIC_URL="https://${RAILWAY_PUBLIC_DOMAIN}"
fi

exec node /app/src/server.js
