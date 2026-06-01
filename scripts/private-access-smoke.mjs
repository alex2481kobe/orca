#!/usr/bin/env node
/*
 * Private access/PWA smoke.
 *
 * This never mutates Tailscale. It exercises mocked tailnet states, URL
 * validation, dry-run setup plans, Funnel rejection, and static-only PWA assets.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const previousCwd = process.cwd();
const previousEnv = { ...process.env };
let explicitBase = Boolean(process.env.ORCA_BASE_URL);
let base = process.env.ORCA_BASE_URL || 'http://127.0.0.1:3000';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base' && args[i + 1]) {
    base = args[i + 1];
    explicitBase = true;
  }
}
let token = process.env.ORCA_API_TOKEN || '';
let headers = {};
function refreshHeaders() {
  headers = {
    'content-type': 'application/json',
    ...(token ? { 'x-orca-token': token } : {}),
  };
}
refreshHeaders();

const tempDir = explicitBase ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'orca-private-access-'));
let server = null;
let stopServer = null;

const log = (label, info = '') => console.log(`[private-access-smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[private-access-smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(label);
};

async function req(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, text };
}

async function cleanupStartedServer() {
  if (stopServer) await stopServer();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) {
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previousEnv)) {
    process.env[key] = value;
  }
}

async function main() {
if (!explicitBase) {
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = 'private-access-smoke-token';
  token = process.env.ORCA_API_TOKEN;
  refreshHeaders();
  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
  log('server', `started isolated local server at ${base}`);
}

const state = await req('GET', '/api/private-access?fakeTailnetState=serve-https');
if (state.status !== 200) fail('GET /api/private-access', JSON.stringify(state.data));
if (state.data.tailnet?.provider !== 'fake') fail('fake tailnet provider not used');
if (!state.data.pwa?.staticOnlyCache) fail('PWA static-only cache flag missing');
log('state', `${state.data.tailnet.serveMode}`);

for (const fake of ['missing', 'installed', 'logged-in', 'serve-http', 'serve-https', 'funnel']) {
  const tailnet = await req('GET', `/api/private-access/tailnet?fake=${fake}`);
  if (tailnet.status !== 200) fail(`fake tailnet ${fake}`, JSON.stringify(tailnet.data));
  if (fake === 'funnel' && !String(tailnet.data.blockers || '').toLowerCase().includes('funnel')) {
    fail('funnel fake state should be blocked');
  }
}
log('fake states', 'ok');

const plan = await req('GET', `/api/private-access/setup-plan?localUrl=${encodeURIComponent(base)}`);
if (plan.status !== 200) fail('setup plan', JSON.stringify(plan.data));
if ((plan.data.commands || []).some((command) => command.id !== 'local' && command.status !== 'dry_run_only' && command.status !== 'read_only')) {
  fail('setup commands must be dry-run/read-only');
}
if (!JSON.stringify(plan.data.commands).includes('tailscale serve')) fail('setup plan missing tailscale serve command');
log('setup plan', 'dry-run only');

const target = await req('POST', '/api/private-access/targets', {
  actor: 'dashboard',
  label: `Smoke private access ${Date.now().toString(36)}`,
  mode: 'local',
  localUrl: base,
});
if (target.status !== 201) fail('create target', JSON.stringify(target.data));
log('target', target.data.id);

const funnel = await req('POST', '/api/private-access/targets', {
  actor: 'dashboard',
  label: 'Bad Funnel',
  mode: 'tailnet-https-serve',
  localUrl: base,
  httpsServeUrl: 'https://orca.funnel.ts.net',
});
if (funnel.status !== 422) fail('Funnel URL should be rejected', JSON.stringify(funnel.data));
log('funnel rejection', 'ok');

const check = await req('POST', `/api/private-access/targets/${target.data.id}/check`, { actor: 'dashboard' });
if (check.status !== 200) fail('target check', JSON.stringify(check.data));
log('health check', check.data.result?.status || 'checked');

const manifest = await req('GET', '/manifest.webmanifest');
if (manifest.status !== 200) fail('manifest webmanifest', String(manifest.status));
if (!manifest.text.includes('"start_url"')) fail('manifest missing start_url');

const sw = await req('GET', '/service-worker.js');
if (sw.status !== 200) fail('service worker', String(sw.status));
if (!sw.text.includes('/api/') || !sw.text.includes('/artifacts/')) fail('service worker must explicitly bypass sensitive routes');
if (!sw.text.includes('STATIC_ASSETS')) fail('service worker missing static cache list');
log('pwa assets', 'ok');

const deleted = await req('DELETE', `/api/private-access/targets/${target.data.id}`, { actor: 'dashboard' });
if (deleted.status !== 200) fail('delete target', JSON.stringify(deleted.data));
log('done', 'ok');
}

try {
  await main();
} finally {
  await cleanupStartedServer();
}
