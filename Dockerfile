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
RUN pnpm --filter @paperclipai/plugin-sdk build
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

# Claude and Hermes install under $HOME; installing as root leaves binaries in /root, which a
# non-root user cannot execute via symlinks. Use the image's node user and /paperclip as HOME.
RUN mkdir -p /paperclip && chown node:node /paperclip

USER node
WORKDIR /paperclip
ENV HOME=/paperclip

RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_CODE_VERSION}"
RUN if [ "${HERMES_AGENT_VERSION}" = "latest" ]; then \
      curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --branch main; \
    else \
      curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --branch "${HERMES_AGENT_VERSION}"; \
    fi

# Same PATH the runtime user will use (no /root/.local — not traversable as non-root).
RUN set -eux; \
    export PATH="/paperclip/.local/bin:${PATH}"; \
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

USER root

ENV NODE_ENV=production \
  HOME=/paperclip \
  PATH=/paperclip/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin \
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
  && mkdir -p /paperclip \
  && chown -R node:node /app /opt/paperclip /paperclip

# Entrypoint starts as root so it can chown a root-owned volume at /paperclip, then drops to node.
USER root

EXPOSE 3100
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
