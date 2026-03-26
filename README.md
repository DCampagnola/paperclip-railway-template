# Paperclip Railway Template

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/paperclip-1?referralCode=uTN7AS&utm_medium=integration&utm_source=template&utm_campaign=generic)

Deploy Paperclip to Railway with a setup wrapper on the public port.

## Current architecture

- Paperclip is built from source in Docker (`PAPERCLIP_REPO` + `PAPERCLIP_REF`).
- Wrapper process (`src/server.js`) is always the public ingress.
- Backend runs internally on `PAPERCLIP_INTERNAL_PORT` (default `3101`) and is proxied by the wrapper.
- `/` redirects to `/setup` until the first `instance_admin` exists.
- Healthcheck is wrapper-specific: `/wrapper/healthz` (see `railway.json`).
- Setup/bootstrap is wrapper + DB native (no runtime CLI onboarding path).
- Runtime image includes `codex`, `claude`, `opencode`, `hermes`, `tsx`, `git`, `gh`.
- Build injects `hermes-paperclip-adapter` into Paperclip server registry (adapter type: `hermes_local`).

## Endpoints

- `/setup`
- `/setup/api/status`
- `/setup/api/bootstrap`
- `/wrapper/healthz`
- `/setup/healthz`

## Build args

- `PAPERCLIP_REPO` (default: `https://github.com/paperclipai/paperclip.git`)
- `PAPERCLIP_REF` (default: `v0.3.1`)
- `CODEX_VERSION` (default: `latest`)
- `CLAUDE_CODE_VERSION` (default: `latest`)
- `HERMES_AGENT_VERSION` (default: `latest`)

## Railway variables (auto-configured)

You do not need to set these by hand when deploying from this template.
They are pre-configured in Railway template variables.

Template defaults:

- `SETUP_TOKEN="${{secret(48, \"abcdef0123456789\")}}"`
- `DATABASE_URL="${{Postgres.DATABASE_URL}}"`
- `SETUP_ENABLED="true"`
- `BETTER_AUTH_SECRET="${{secret(64, \"abcdef0123456789\")}}"`
- `PAPERCLIP_PUBLIC_URL="https://${{RAILWAY_PUBLIC_DOMAIN}}"`
- `SETUP_AUTO_BOOTSTRAP="true"`
- `PAPERCLIP_INTERNAL_PORT="3101"`
- `PAPERCLIP_SECRETS_MASTER_KEY="${{secret(64, \"abcdef0123456789\")}}"`
- `PAPERCLIP_SECRETS_STRICT_MODE="true"`

If you deploy manually (without template variables), then you must define equivalent values yourself.

## First-time deployment

1. Deploy service with Dockerfile builder.
2. Keep Railway Start Command empty.
3. Open `<public_url>/setup`.
4. Copy `SETUP_TOKEN` from Railway Variables and paste it in setup UI.
5. Click "Generate / show first-admin invite".
6. Open invite URL and finish first admin signup.
7. After onboarding, `/` opens the app directly.

## Troubleshooting

### Crash loop: missing auth secret

If logs show:
`authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) to be set`

Do this:
1. Add `BETTER_AUTH_SECRET` (or `PAPERCLIP_AGENT_JWT_SECRET`) in Railway Variables.
2. Redeploy.

Generate a secret:
`openssl rand -base64 48`

### Wrapper looks healthy but setup API is missing

If `/setup/api/status` returns `{"error":"API route not found"}` then requests are hitting native app routes, not wrapper routes. Confirm:
- Start Command is empty (or explicitly `/usr/bin/tini -- /usr/local/bin/docker-entrypoint.sh`).
- Healthcheck path is `/wrapper/healthz`.
