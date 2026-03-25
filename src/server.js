#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');
const { createHash, randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const EXTERNAL_PORT = Number(process.env.PORT || 3100);
const INTERNAL_PORT = Number(process.env.PAPERCLIP_INTERNAL_PORT || 3101);
const HOST = process.env.HOST || '0.0.0.0';
const WRAPPER_VERSION = 'setup-wrapper';
const BACKEND_CWD = process.env.PAPERCLIP_BACKEND_CWD || '/opt/paperclip';
const BACKEND_ENTRY = process.env.PAPERCLIP_BACKEND_ENTRY || 'server/dist/index.js';
const BACKEND_TSX_BIN = process.env.PAPERCLIP_BACKEND_TSX_BIN || path.join(BACKEND_CWD, 'node_modules/.bin/tsx');
const GLOBAL_TSX_BIN = '/usr/local/bin/tsx';

console.log(`[setup-wrapper] ${WRAPPER_VERSION} process starting`);

const PAPERCLIP_HOME = process.env.PAPERCLIP_HOME || process.env.HOME || '/paperclip';
const SETUP_ENABLED = (process.env.SETUP_ENABLED || 'true').toLowerCase() !== 'false';
const SETUP_TOKEN = process.env.SETUP_TOKEN || '';
const SETUP_AUTO_BOOTSTRAP = (process.env.SETUP_AUTO_BOOTSTRAP || 'true').toLowerCase() !== 'false';

const setupDir = path.join(PAPERCLIP_HOME, 'setup');
const bootstrapFilePath = path.join(setupDir, 'bootstrap-invite.txt');

const ONBOARDED_CACHE_TTL_MS = 5 * 60 * 1000;
const NOT_ONBOARDED_CACHE_TTL_MS = 15 * 1000;
let onboardedCache = { value: null, at: 0 };

function ensureSetupDir() {
  fs.mkdirSync(setupDir, { recursive: true });
}

function readStoredBootstrapUrl() {
  try {
    return fs.readFileSync(bootstrapFilePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function storeBootstrapUrl(url) {
  ensureSetupDir();
  fs.writeFileSync(bootstrapFilePath, `${url.trim()}\n`, { mode: 0o600 });
}

function getTokenFromRequest(reqUrl, headers) {
  const authorization = headers.authorization || '';
  const authBearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const setupHeader = headers['x-setup-token'] || '';
  const queryToken = reqUrl.searchParams.get('token') || '';
  return queryToken || setupHeader || authBearer;
}

function isSetupApiAuthorized(reqUrl, headers) {
  if (!SETUP_TOKEN) return true;
  return getTokenFromRequest(reqUrl, headers) === SETUP_TOKEN;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store'
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

async function requestBackend(pathname, options = {}) {
  const backendUrl = `http://127.0.0.1:${INTERNAL_PORT}${pathname}`;
  const response = await fetch(backendUrl, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body
  });

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return { ok: response.ok, status: response.status, data: await response.json() };
  }

  const text = await response.text();
  return { ok: response.ok, status: response.status, data: { text } };
}

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host || `localhost:${EXTERNAL_PORT}`;
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function createInviteToken() {
  return `pcp_bootstrap_${randomBytes(24).toString('hex')}`;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function createBootstrapInvite(baseUrl) {
  const dbUrl = (process.env.DATABASE_URL || '').trim();
  if (!dbUrl) throw new Error('DATABASE_URL is not set');

  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
    await client.query('BEGIN');

    const adminResult = await client.query(
      'SELECT COUNT(*)::int AS count FROM instance_user_roles WHERE role = $1',
      ['instance_admin']
    );
    const adminCount = adminResult.rows[0]?.count ?? 0;
    if (adminCount > 0) {
      throw new Error('Instance already onboarded');
    }

    await client.query(
      `UPDATE invites
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE invite_type = $1
         AND revoked_at IS NULL
         AND accepted_at IS NULL
         AND expires_at > NOW()`,
      ['bootstrap_ceo']
    );

    const token = createInviteToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO invites (
         invite_type,
         token_hash,
         allowed_join_types,
         expires_at,
         invited_by_user_id
       ) VALUES ($1, $2, $3, $4, $5)`,
      ['bootstrap_ceo', tokenHash, 'human', expiresAt.toISOString(), 'system']
    );

    await client.query('COMMIT');
    return `${baseUrl.replace(/\/+$/, '')}/invite/${token}`;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function hasInstanceAdmin() {
  const now = Date.now();
  if (onboardedCache.value === true && now - onboardedCache.at < ONBOARDED_CACHE_TTL_MS) return true;
  if (onboardedCache.value === false && now - onboardedCache.at < NOT_ONBOARDED_CACHE_TTL_MS) return false;

  const dbUrl = (process.env.DATABASE_URL || '').trim();
  if (!dbUrl) {
    onboardedCache = { value: false, at: now };
    return false;
  }

  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
    const result = await client.query(
      'SELECT COUNT(*)::int AS count FROM instance_user_roles WHERE role = $1',
      ['instance_admin']
    );
    const adminCount = result.rows[0]?.count ?? 0;
    const onboarded = adminCount > 0;
    onboardedCache = { value: onboarded, at: now };
    return onboarded;
  } catch {
    onboardedCache = { value: false, at: now };
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function renderSetupHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Paperclip Setup</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0a0a;
      --panel: #121212;
      --panel-2: #171717;
      --line: #2a2a2a;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #4f46e5;
      --accent-hover: #4338ca;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
    }
    * { box-sizing: border-box; }
    html {
      height: 100vh;
      min-height: 100vh;
      background: var(--bg);
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.45;
      padding: 28px 16px;
    }
    .wrap { max-width: 860px; margin: 0 auto; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 22px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
    }
    h1 { margin: 0 0 6px 0; font-size: 23px; font-weight: 650; letter-spacing: .2px; }
    .sub { color: var(--muted); font-size: 14px; margin: 0 0 20px 0; }
    .section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
    }
    .section:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }
    .section h2 {
      margin: 0 0 6px 0;
      font-size: 15px;
      color: #e5e7eb;
      font-weight: 620;
    }
    .row { margin-top: 12px; }
    .label { display: block; color: var(--muted); font-size: 13px; margin-bottom: 6px; }
    input {
      width: 100%;
      border: 1px solid #323232;
      border-radius: 10px;
      background: #0f0f10;
      color: var(--text);
      padding: 11px 12px;
      outline: none;
    }
    input:focus {
      border-color: #5b5be6;
      box-shadow: 0 0 0 3px rgba(79,70,229,.22);
    }
    button {
      border: 1px solid transparent;
      border-radius: 10px;
      background: var(--accent);
      color: #fff;
      padding: 10px 14px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--accent-hover); }
    button:disabled { opacity: .6; cursor: default; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      border-radius: 999px;
      padding: 4px 10px;
      border: 1px solid #333;
      background: #111;
      color: #d4d4d8;
    }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: #666; }
    .ok .dot { background: var(--ok); }
    .warn .dot { background: var(--warn); }
    .err .dot { background: var(--err); }
    .hint { color: var(--muted); font-size: 13px; margin-top: 7px; }
    code.block {
      display: block;
      border: 1px solid #2b2b2f;
      border-radius: 10px;
      background: #0e0e0f;
      color: #e4e4e7;
      padding: 11px 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12.5px;
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 44px;
    }
    a { color: #a5b4fc; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <h1>Paperclip Setup</h1>
      <p class="sub">Initial bootstrap for a fresh instance. After first admin exists, root URL redirects to the app.</p>

      <div class="section">
        <h2>Instance status</h2>
        <div class="row">
          <span id="backendBadge" class="badge"><span class="dot"></span><span>Checking backend…</span></span>
          <span id="onboardedBadge" class="badge" style="margin-left:8px;"><span class="dot"></span><span>Checking onboarding…</span></span>
        </div>
      </div>

      <div class="section">
        <h2>Bootstrap invite</h2>
        <div class="label">Setup token</div>
        <input id="setupToken" type="password" placeholder="Paste SETUP_TOKEN" autocomplete="off" />
        <div id="tokenHint" class="hint">If SETUP_TOKEN is configured, it is required for bootstrap actions.</div>

        <div class="row">
          <button id="bootstrapBtn" type="button">Generate / show first-admin invite</button>
        </div>

        <div class="row">
          <div class="label">Invite URL</div>
          <code class="block" id="invite">(none)</code>
        </div>
      </div>

      <div class="section">
        <span class="hint">Tip: if already onboarded, open <a href="/" target="_self">the app root</a>.</span>
      </div>
    </section>
  </main>

  <script>
    const tokenInput = document.getElementById('setupToken');
    const tokenHint = document.getElementById('tokenHint');
    const inviteEl = document.getElementById('invite');
    const backendBadge = document.getElementById('backendBadge');
    const onboardedBadge = document.getElementById('onboardedBadge');

    const savedToken = localStorage.getItem('paperclip_setup_token') || '';
    const queryToken = new URLSearchParams(window.location.search).get('token') || '';
    tokenInput.value = queryToken || savedToken;

    tokenInput.addEventListener('input', () => {
      localStorage.setItem('paperclip_setup_token', tokenInput.value.trim());
    });

    function setBadge(el, state, text) {
      el.className = 'badge ' + state;
      el.querySelector('span:last-child').textContent = text;
    }

    function buildHeaders() {
      const token = tokenInput.value.trim();
      return token ? { 'x-setup-token': token } : {};
    }

    async function loadStatus() {
      try {
        const r = await fetch('/setup/api/status', { headers: buildHeaders() });
        const j = await r.json();

        setBadge(backendBadge, j.backendReachable ? 'ok' : 'warn', j.backendReachable ? 'Backend reachable' : 'Backend starting');
        if (j.instanceOnboarded) {
          setBadge(onboardedBadge, 'ok', 'Instance onboarded');
        } else {
          setBadge(onboardedBadge, 'warn', 'No instance admin yet');
        }

        if (j.authRequired && !j.authorized) {
          tokenHint.textContent = 'This deployment requires a valid setup token for bootstrap.';
        } else if (j.authRequired && j.authorized) {
          tokenHint.textContent = 'Setup token accepted.';
        } else {
          tokenHint.textContent = 'Token is optional unless SETUP_TOKEN is configured.';
        }

        if (j.bootstrapUrl) {
          inviteEl.textContent = j.bootstrapUrl;
        }
      } catch {
        setBadge(backendBadge, 'err', 'Status check failed');
      }
    }

    async function bootstrap() {
      const btn = document.getElementById('bootstrapBtn');
      btn.disabled = true;
      try {
        const r = await fetch('/setup/api/bootstrap', {
          method: 'POST',
          headers: buildHeaders()
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'request failed');
        inviteEl.textContent = j.bootstrapUrl || '(none)';
      } catch (e) {
        inviteEl.textContent = 'Error: ' + e.message;
      } finally {
        btn.disabled = false;
        loadStatus();
      }
    }

    document.getElementById('bootstrapBtn').addEventListener('click', bootstrap);
    loadStatus();
    setInterval(loadStatus, 8000);
  </script>
</body>
</html>`;
}

function proxyToBackend(clientReq, clientRes) {
  const forwardedProto = String(clientReq.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const inferredProto = forwardedProto || (clientReq.socket.encrypted ? 'https' : 'http');
  const originalHost = clientReq.headers.host || '';

  const requestOptions = {
    hostname: '127.0.0.1',
    port: INTERNAL_PORT,
    path: clientReq.url,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: originalHost,
      'x-forwarded-proto': inferredProto,
      'x-forwarded-host': originalHost
    }
  };

  const proxyReq = http.request(requestOptions, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', () => {
    sendJson(clientRes, 502, { error: 'Paperclip backend unavailable' });
  });

  clientReq.pipe(proxyReq);
}

const backendEnv = {
  ...process.env,
  PORT: String(INTERNAL_PORT),
  HOST: '127.0.0.1',
  PAPERCLIP_OPEN_ON_LISTEN: 'false'
};

let child;

function startBackend() {
  const backendEntryPath = path.join(BACKEND_CWD, BACKEND_ENTRY);
  if (!fs.existsSync(backendEntryPath)) {
    console.error(`[setup-wrapper] backend entry missing: ${backendEntryPath}`);
    process.exit(1);
  }

  const tsxBin = fs.existsSync(BACKEND_TSX_BIN)
    ? BACKEND_TSX_BIN
    : (fs.existsSync(GLOBAL_TSX_BIN) ? GLOBAL_TSX_BIN : '');
  const command = tsxBin || 'node';
  const args = [BACKEND_ENTRY];

  console.log(`[setup-wrapper] launching backend: ${command} ${args.join(' ')} (cwd=${BACKEND_CWD})`);

  child = spawn(command, args, {
    cwd: BACKEND_CWD,
    env: backendEnv,
    stdio: 'inherit'
  });

  child.on('exit', (code, signal) => {
    console.error(`[setup-wrapper] Paperclip process exited (code=${code}, signal=${signal || 'none'})`);
    process.exit(code || 1);
  });
}

async function getStatusPayload(reqUrl, headers) {
  let backendReachable = false;
  try {
    const backendHealth = await requestBackend('/api/health');
    backendReachable = backendHealth.ok;
  } catch {
    backendReachable = false;
  }

  const authorized = isSetupApiAuthorized(reqUrl, headers);
  const bootstrapUrl = authorized ? readStoredBootstrapUrl() : '';
  const instanceOnboarded = await hasInstanceAdmin();

  return {
    ok: true,
    component: 'setup-wrapper',
    version: WRAPPER_VERSION,
    setupEnabled: SETUP_ENABLED,
    backendReachable,
    instanceOnboarded,
    authRequired: Boolean(SETUP_TOKEN),
    authorized,
    bootstrapExists: Boolean(bootstrapUrl),
    bootstrapUrl: bootstrapUrl || undefined
  };
}

if (SETUP_AUTO_BOOTSTRAP) {
  setTimeout(async () => {
    try {
      if (!readStoredBootstrapUrl() && !(await hasInstanceAdmin())) {
        const baseUrl = (process.env.PAPERCLIP_PUBLIC_URL || `http://localhost:${EXTERNAL_PORT}`).replace(/\/+$/, '');
        const url = await createBootstrapInvite(baseUrl);
        storeBootstrapUrl(url);
      }
    } catch {
      // Ignore: setup endpoint can still create it later.
    }
  }, 5000);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  if (pathname === '/wrapper/healthz') {
    const backendReachable = await requestBackend('/api/health').then((r) => r.ok).catch(() => false);
    return sendJson(res, 200, { ok: true, component: 'setup-wrapper', version: WRAPPER_VERSION, backendReachable });
  }

  if (pathname === '/setup/healthz') {
    const backendReachable = await requestBackend('/api/health').then((r) => r.ok).catch(() => false);
    return sendJson(res, 200, { ok: true, wrapper: 'ready', version: WRAPPER_VERSION, backendReachable });
  }

  if (!SETUP_ENABLED && (pathname === '/setup' || pathname.startsWith('/setup/api/'))) {
    return sendJson(res, 404, { error: 'Setup endpoint disabled' });
  }

  if (pathname === '/setup' && req.method === 'GET') {
    return sendHtml(res, 200, renderSetupHtml());
  }

  if (pathname === '/setup/api/status' && req.method === 'GET') {
    const payload = await getStatusPayload(reqUrl, req.headers);
    return sendJson(res, 200, payload);
  }

  if (pathname === '/setup/api/bootstrap' && req.method === 'POST') {
    if (!isSetupApiAuthorized(reqUrl, req.headers)) {
      return sendJson(res, 401, {
        ok: false,
        error: 'Setup token required or invalid'
      });
    }

    if (await hasInstanceAdmin()) {
      return sendJson(res, 409, {
        ok: false,
        error: 'Instance already onboarded'
      });
    }

    try {
      let bootstrapUrl = readStoredBootstrapUrl();
      if (!bootstrapUrl) {
        const baseUrl = getRequestBaseUrl(req);
        bootstrapUrl = await createBootstrapInvite(baseUrl);
        storeBootstrapUrl(bootstrapUrl);
      }
      return sendJson(res, 200, { ok: true, bootstrapUrl });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to generate bootstrap invite'
      });
    }
  }

  if (SETUP_ENABLED && req.method === 'GET' && pathname === '/') {
    if (!(await hasInstanceAdmin())) {
      return redirect(res, '/setup');
    }
  }

  return proxyToBackend(req, res);
});

server.listen(EXTERNAL_PORT, HOST, () => {
  console.log(`[setup-wrapper] Listening on ${HOST}:${EXTERNAL_PORT}, backend on 127.0.0.1:${INTERNAL_PORT}`);
  startBackend();
});

function shutdown(signal) {
  console.log(`[setup-wrapper] ${signal} received, shutting down...`);
  server.close(() => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
