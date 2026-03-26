FROM node:22-bookworm AS paperclip-build

ARG PAPERCLIP_REPO=https://github.com/paperclipai/paperclip.git
ARG PAPERCLIP_REF=v2026.325.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /opt/paperclip
RUN git clone --depth 1 --branch "${PAPERCLIP_REF}" "${PAPERCLIP_REPO}" .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/server build
RUN pnpm --filter paperclipai build
RUN test -f /opt/paperclip/server/dist/index.js \
  && test -f /opt/paperclip/cli/dist/index.js


FROM node:22-bookworm-slim

ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG HERMES_AGENT_VERSION=latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini gosu git gh python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global --omit=dev @openai/codex@${CODEX_VERSION} opencode-ai tsx
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_CODE_VERSION}"
RUN if [ "${HERMES_AGENT_VERSION}" = "latest" ]; then \
      curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --branch main; \
    else \
      curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --branch "${HERMES_AGENT_VERSION}"; \
    fi

ENV PATH="/root/.local/bin:${PATH}"

# Claude installer may place launcher under root's local bin; make it globally discoverable.
RUN set -eux; \
    if ! command -v claude >/dev/null 2>&1; then \
      for p in /root/.local/bin/claude /root/.claude/local/claude /root/.claude/bin/claude; do \
        if [ -x "$p" ]; then ln -sf "$p" /usr/local/bin/claude; break; fi; \
      done; \
    fi; \
    command -v codex; \
    command -v opencode; \
    command -v tsx; \
    command -v claude; \
    command -v hermes; \
    command -v git; \
    command -v gh; \
    codex --version; \
    opencode --version; \
    tsx --version; \
    claude --version; \
    hermes --version; \
    git --version; \
    gh --version

ENV NODE_ENV=production \
  HOME=/paperclip \
  PAPERCLIP_HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=public \
  PAPERCLIP_INTERNAL_PORT=3101 \
  PAPERCLIP_BACKEND_CWD=/opt/paperclip \
  PAPERCLIP_SOURCE_ROOT=/opt/paperclip

WORKDIR /app
COPY package*.json /app/
RUN npm install --omit=dev

COPY src /app/src
COPY --from=paperclip-build /opt/paperclip /opt/paperclip
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && test -f /opt/paperclip/server/dist/index.js \
  && test -f /opt/paperclip/cli/dist/index.js \
  && mkdir -p /paperclip

EXPOSE 3100
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
