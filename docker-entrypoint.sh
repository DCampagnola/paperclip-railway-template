#!/usr/bin/env sh
set -eu

export HOME="${HOME:-/paperclip}"
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME}"
export HOST="${HOST:-0.0.0.0}"

INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"

mkdir -p "$PAPERCLIP_HOME" "$PAPERCLIP_HOME/instances/$INSTANCE_ID/logs"

# Bind mounts / volume roots are often root-owned (e.g. Railway). The app runs as
# user `node`; fix ownership so logs and instance data are writable.
chown -R node:node "$PAPERCLIP_HOME"

# Railway usually provides only the hostname. Paperclip needs a full public URL
# for authenticated/public mode onboarding.
if [ -z "${PAPERCLIP_PUBLIC_URL:-}" ] && [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  export PAPERCLIP_PUBLIC_URL="https://${RAILWAY_PUBLIC_DOMAIN}"
fi

exec /usr/sbin/gosu node node /app/src/server.js
