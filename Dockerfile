FROM node:22-bookworm AS paperclip-build

ARG PAPERCLIP_REPO=https://github.com/paperclipai/paperclip.git
ARG PAPERCLIP_REF=v0.3.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /opt/paperclip
RUN git clone --depth 1 --branch "${PAPERCLIP_REF}" "${PAPERCLIP_REPO}" .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @paperclipai/server add hermes-paperclip-adapter@0.1.1
RUN pnpm --filter @paperclipai/ui add hermes-paperclip-adapter@0.1.1
RUN node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = '/opt/paperclip';

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content);
}
function replaceOnce(content, from, to, err) {
  if (!content.includes(from)) throw new Error(err || `anchor not found: ${from.slice(0, 80)}`);
  return content.replace(from, to);
}

// 1) Server adapter registry: register hermes_local runtime adapter.
{
  const rel = 'server/src/adapters/registry.ts';
  let s = read(rel);

  const importAnchor = `import {
  agentConfigurationDoc as piAgentConfigurationDoc,
} from "@paperclipai/adapter-pi-local";\n`;
  const hermesImports = `import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
`;

  if (!s.includes('from "hermes-paperclip-adapter/server"')) {
    s = replaceOnce(s, importAnchor, importAnchor + hermesImports, 'server registry import anchor not found');
  }

  const hermesAdapterBlock = `
const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: hermesExecute,
  testEnvironment: hermesTestEnvironment,
  sessionCodec: hermesSessionCodec,
  models: [
    ...hermesModels,
    { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  ],
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
};
`;

  if (!s.includes('const hermesLocalAdapter: ServerAdapterModule = {')) {
    const adaptersMapAnchor = 'const adaptersByType = new Map<string, ServerAdapterModule>(';
    s = replaceOnce(s, adaptersMapAnchor, hermesAdapterBlock + '\n' + adaptersMapAnchor, 'server registry map anchor not found');
  }

  if (!s.includes('hermesLocalAdapter,')) {
    const mapAnchor = `    openclawGatewayAdapter,
    processAdapter,`;
    s = replaceOnce(s, mapAnchor, `    openclawGatewayAdapter,
    hermesLocalAdapter,
    processAdapter,`, 'server registry adapter insertion anchor not found');
  }

  write(rel, s);
}

// 2) Shared adapter types: include hermes_local so validators + UI type lists accept it.
{
  const rel = 'packages/shared/src/constants.ts';
  let s = read(rel);
  if (!s.includes('"hermes_local"')) {
    const anchor = '  "opencode_local",\n  "pi_local",';
    s = replaceOnce(s, anchor, '  "opencode_local",\n  "hermes_local",\n  "pi_local",', 'shared constants adapter list anchor not found');
    write(rel, s);
  }
}

// 3) UI labels + enabled adapters in form.
{
  const rel = 'ui/src/components/agent-config-primitives.tsx';
  let s = read(rel);
  if (!s.includes('hermes_local: "Hermes (local)"')) {
    const anchor = '  opencode_local: "OpenCode (local)",\n';
    s = replaceOnce(s, anchor, '  opencode_local: "OpenCode (local)",\n  hermes_local: "Hermes (local)",\n', 'adapter labels anchor not found');
    write(rel, s);
  }
}

{
  const rel = 'ui/src/components/AgentConfigForm.tsx';
  let s = read(rel);

  s = s.replace(
    '    adapterType === "opencode_local" ||\n    adapterType === "cursor";',
    '    adapterType === "opencode_local" ||\n    adapterType === "hermes_local" ||\n    adapterType === "cursor";'
  );

  s = s.replace(
    'const ENABLED_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "gemini_local", "opencode_local", "cursor"]);',
    'const ENABLED_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "gemini_local", "opencode_local", "hermes_local", "cursor"]);'
  );

  s = s.replace(
    '                        : adapterType === "opencode_local"\n                          ? "opencode"\n                          : "claude"',
    '                        : adapterType === "opencode_local"\n                          ? "opencode"\n                        : adapterType === "hermes_local"\n                          ? "hermes"\n                          : "claude"'
  );

  write(rel, s);
}

// 4) UI adapter registry: wire hermes stdout parser + config builder.
{
  const rel = 'ui/src/adapters/registry.ts';
  let s = read(rel);

  if (!s.includes('hermesLocalUIAdapter')) {
    const importAnchor = 'import { openCodeLocalUIAdapter } from "./opencode-local";\n';
    s = replaceOnce(s, importAnchor, importAnchor + 'import { hermesLocalUIAdapter } from "./hermes-local";\n', 'ui adapter registry import anchor not found');

    const listAnchor = '    openCodeLocalUIAdapter,\n';
    s = replaceOnce(s, listAnchor, listAnchor + '    hermesLocalUIAdapter,\n', 'ui adapter registry list anchor not found');
  }

  write(rel, s);
}

// 5) Add minimal Hermes UI adapter module.
{
  const dir = path.join(root, 'ui/src/adapters/hermes-local');
  const file = path.join(dir, 'index.ts');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `import type { UIAdapterModule, AdapterConfigFieldsProps } from "../types";
import { parseHermesStdoutLine, buildHermesConfig } from "hermes-paperclip-adapter/ui";

function HermesLocalConfigFields(_props: AdapterConfigFieldsProps) {
  return null;
}

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes (local)",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
`);
  }
}
NODE
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
