#!/usr/bin/env node
/*
 * Orca end-to-end smoke.
 *
 * Walks the full operator path against a running local server and proves
 * both the happy path AND that the security guards reject the bad path:
 *   1. health, policy, mobile manifest, system blockers
 *   2. unauthorized POST → 401
 *   3. spoofed actor (scheduler/system) → 403
 *   4. oversized JSON body → 413
 *   5. malformed JSON body → 400
 *   6. malformed query string → 400
 *   7. project + session + mock lane creation; lane reaches done
 *   8. MCP CRUD + Codex lane attachment (blocked execution OK)
 *   9. API provider secret/profile setup + local dummy provider lane
 *  10. evidence capture; if Playwright is present, assert captured=true
 *      and a real screenshot file with non-zero size; otherwise assert
 *      the degraded state explicitly
 *  11. audit queue + ack + cleanup dry-run + worktree route shape
 *
 * Usage:
 *   node scripts/smoke.mjs
 *   ORCA_API_TOKEN=<token> node scripts/smoke.mjs --base http://127.0.0.1:3000
 *
 * Exits non-zero on the first failing step so it can gate startup.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const repoRoot = previousCwd;
let explicitBase = Boolean(process.env.ORCA_BASE_URL);
let base = process.env.ORCA_BASE_URL || 'http://127.0.0.1:3000';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base' && args[i + 1]) {
    base = args[i + 1];
    explicitBase = true;
  }
}
let token = process.env.ORCA_API_TOKEN || '';

let tokenHeaders = {};
const noTokenHeaders = { 'content-type': 'application/json' };
function refreshTokenHeaders() {
  tokenHeaders = {
    'content-type': 'application/json',
    ...(token ? { 'x-orca-token': token } : {}),
  };
}
refreshTokenHeaders();

const tempDir = explicitBase ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'orca-full-flow-'));
let server = null;
let stopServer = null;

const log = (label, info = '') => console.log(`[smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info) => {
  console.error(`[smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(label);
};
const isMissingPlaywrightBrowser = (value) => /Executable doesn't exist|playwright install|browser.*not.*found/i.test(String(value || ''));

async function req(method, path, body, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: opts.headers || tokenHeaders,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, body: json, text, headers: Object.fromEntries(res.headers.entries()) };
}

async function startDummyApiProvider(secret) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: `full-flow provider ok ${secret}` } }],
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startDummyGeminiProvider(secret) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: `full-flow gemini ok ${secret}` }] } }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function waitForLaneTerminal(laneId, label) {
  let state = 'unknown';
  let latest = null;
  for (let i = 0; i < 40 && !['done', 'failed', 'stopped'].includes(state); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    latest = await req('GET', `/api/lanes/${laneId}`);
    state = latest.body?.state;
  }
  if (!latest) latest = await req('GET', `/api/lanes/${laneId}`);
  if (latest.status !== 200) fail(`${label} lane status`, JSON.stringify(latest));
  return latest;
}

async function captureBrowserScreenshots({ sessionCookie = null, projectId = null, sessionId = null, laneId = null } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    log('browser screenshots', `skipped (${error.message})`);
    return { skipped: true, reason: error.message };
  }

  const artifactDir = path.join(repoRoot, 'artifacts', 'full-flow-smoke');
  await fs.mkdir(artifactDir, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    log('browser screenshots', `skipped (${error.message})`);
    return { skipped: true, reason: error.message };
  }
  const screenshots = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 920, path: projectId ? `/#project:${projectId}` : '/' },
      { name: 'phone', width: 390, height: 844, path: sessionId ? `/#session:${sessionId}` : '/' },
      { name: 'lane', width: 390, height: 844, path: laneId ? `/#lane:${laneId}` : '/' },
    ]) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      if (sessionCookie) {
        const [cookiePair] = String(sessionCookie).split(';');
        const [name, ...valueParts] = cookiePair.split('=');
        if (name && valueParts.length) {
          await context.addCookies([{
            name: name.trim(),
            value: valueParts.join('=').trim(),
            url: base,
            httpOnly: true,
            sameSite: 'Lax',
          }]);
        }
      }
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message || String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(new URL(viewport.path, base).toString(), { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForFunction(() => {
        const content = document.getElementById('content');
        return content && !content.textContent.trim().startsWith('Loading');
      }, { timeout: 15000 });
      const overflowPx = await page.evaluate((width) => document.documentElement.scrollWidth - width, viewport.width);
      if (overflowPx > 1) fail(`browser ${viewport.name} horizontal overflow`, `${overflowPx}px`);
      if (errors.length) fail(`browser ${viewport.name} console errors`, errors.join(' | '));
      const screenshotPath = path.join(artifactDir, `${viewport.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshots.push(screenshotPath);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  log('browser screenshots', screenshots.join(', '));
  return { screenshots };
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
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_API_TOKEN = 'full-flow-smoke-token';
  token = process.env.ORCA_API_TOKEN;
  refreshTokenHeaders();
  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
}

const start = Date.now();
log('start', `base=${base} token=${token ? 'set' : 'unset'}`);

// --- read-only sanity ---
const health = await req('GET', '/api/health');
if (health.status !== 200) fail('health', JSON.stringify(health));
log('health', `counts=${JSON.stringify(health.body.counts || {})}`);

const policy = await req('GET', '/api/policy');
if (policy.status !== 200) fail('policy', JSON.stringify(policy));
log('policy', `${Object.keys(policy.body.policies || {}).length} policies`);

const blockers = await req('GET', '/api/system/blockers');
if (blockers.status !== 200) fail('system blockers', JSON.stringify(blockers));
log('blockers', `${(blockers.body.blockers || []).length} blocker(s)`);

const manifest = await req('GET', '/api/mobile/manifest');
if (manifest.status !== 200) fail('manifest', JSON.stringify(manifest));
log('manifest', `apiTokenRequired=${manifest.body.apiTokenRequired}`);

// --- phone/browser auth pairing ---
const authStatus = await req('GET', '/api/auth/status');
if (authStatus.status !== 200) fail('auth status', JSON.stringify(authStatus));
const pairing = await req('POST', '/api/auth/pairing-codes', {
  actor: 'dashboard',
  label: 'Full-flow phone',
  ttlMs: 60_000,
});
if (pairing.status !== 201) fail('create pairing code', JSON.stringify(pairing));
const pairingCode = pairing.body?.pairing?.code;
if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(pairingCode || '')) fail('pairing code shape', JSON.stringify(pairing.body));
const paired = await req('POST', '/api/auth/pair', {
  code: pairingCode,
  label: 'Full-flow browser',
}, { headers: noTokenHeaders });
if (paired.status !== 200) fail('pair browser session', JSON.stringify(paired));
const sessionCookie = paired.headers['set-cookie'] || '';
if (!sessionCookie.includes(`${authStatus.body.cookieName}=`)) fail('pair response missing session cookie', JSON.stringify(paired.headers));
const authSessions = await req('GET', '/api/auth/sessions');
if (authSessions.status !== 200 || !Array.isArray(authSessions.body?.sessions)) fail('auth sessions list', JSON.stringify(authSessions));
log('auth pairing', `${authSessions.body.sessions.length} session(s)`);

// --- negative auth/spoof/size/malform tests ---
if (token) {
  const unauthorized = await req('POST', '/api/projects', { name: 'unauthorized' }, { headers: noTokenHeaders });
  if (unauthorized.status !== 401) fail('unauthorized POST should be 401', JSON.stringify(unauthorized));
  log('neg/unauthorized', `${unauthorized.status} ok`);
}
const spoofed = await req('POST', '/api/projects', { name: 'spoofed', approved: true, actor: 'scheduler' });
if (spoofed.status !== 403) fail('spoofed actor POST should be 403', JSON.stringify(spoofed));
log('neg/spoofed-actor', `${spoofed.status} ok`);

const overPayload = JSON.stringify({ name: 'over', approved: true, padding: 'x'.repeat(300 * 1024) });
const oversize = await req('POST', '/api/projects', overPayload);
if (oversize.status !== 413) fail('oversize POST should be 413', JSON.stringify(oversize));
log('neg/oversize', `${oversize.status} ok`);

const malformed = await req('POST', '/api/projects', '{ not json ', { headers: tokenHeaders });
if (malformed.status !== 400) fail('malformed JSON should be 400', JSON.stringify(malformed));
log('neg/malformed-json', `${malformed.status} ok`);

const malformedQuery = await req('GET', '/api/audit/events?status=%E0%A4');
if (malformedQuery.status !== 400) fail('malformed query should be 400', JSON.stringify(malformedQuery));
log('neg/malformed-query', `${malformedQuery.status} ok`);

// --- happy-path: project + session + mock lane ---
const slugSuffix = Date.now().toString(36).slice(-6);
const project = await req('POST', '/api/projects', { name: `Smoke ${slugSuffix}`, approved: true });
if (project.status !== 201) fail('createProject', JSON.stringify(project));
log('project', project.body.id);

const session = await req('POST', `/api/projects/${project.body.id}/sessions`, {
  name: `Smoke Session ${slugSuffix}`,
  approved: true,
});
if (session.status !== 201) fail('createSession', JSON.stringify(session));
log('session', session.body.id);

const lane = await req('POST', `/api/sessions/${session.body.id}/lanes`, {
  title: 'smoke lane',
  executorType: 'mock',
  owner: 'smoke',
  approved: true,
  taskPrompt: 'Smoke run',
  model: 'mock',
});
if (lane.status !== 201) fail('createLane', JSON.stringify(lane));
log('lane', lane.body.id);

// Wait for mock lane completion.
const laneDone = await waitForLaneTerminal(lane.body.id, 'mock');
const laneState = laneDone.body.state;
if (laneState !== 'done') fail('lane should reach done', laneState);
log('laneState', laneState);

// --- MCP CRUD + Codex lane attachment ---
const tool = await req('POST', '/api/mcp/tools', {
  name: `smoke-tool-${slugSuffix}`,
  command: 'node',
  args: ['--version'],
  env: { SMOKE: '1' },
  description: 'smoke',
  scope: ['all'],
  approved: true,
});
if (tool.status !== 201) fail('createMcpTool', JSON.stringify(tool));
log('mcpTool', tool.body.id);

const pauseCodexExecution = await req('POST', `/api/sessions/${session.body.id}/capacity/policy`, {
  actor: 'dashboard',
  approved: true,
  spawnPolicy: 'never',
  approvedCapacity: 2,
});
if (pauseCodexExecution.status !== 200) fail('pauseCodexExecution', JSON.stringify(pauseCodexExecution));

const codexLane = await req('POST', `/api/sessions/${session.body.id}/lanes`, {
  title: 'smoke codex lane',
  executorType: 'codex',
  executorBinary: process.env.ORCA_CODEX_BINARY || 'codex',
  mcpToolIds: [tool.body.id],
  approved: true,
  taskPrompt: 'Plan only',
  model: 'gpt-5',
  permissionsProfile: 'plan',
});
if (codexLane.status !== 201) fail('createCodexLane', JSON.stringify(codexLane));
if (codexLane.body?.state !== 'queued') fail('codexLane should stay queued while spawn policy is never', JSON.stringify(codexLane.body));
log('codexLane', codexLane.body.id);

const stopCodexLane = await req('POST', `/api/lanes/${codexLane.body.id}/stop`, {
  actor: 'dashboard',
  approved: true,
});
if (stopCodexLane.status !== 200 || stopCodexLane.body?.state !== 'stopped') fail('stopCodexLane', JSON.stringify(stopCodexLane));

const deleteSmokeTool = await req('DELETE', `/api/mcp/tools/${tool.body.id}`, {
  actor: 'dashboard',
  approved: true,
});
if (deleteSmokeTool.status !== 200) fail('deleteSmokeMcpTool', JSON.stringify(deleteSmokeTool));
log('mcpToolCleanup', tool.body.id);

const resumeExecution = await req('POST', `/api/sessions/${session.body.id}/capacity/policy`, {
  actor: 'dashboard',
  approved: true,
  spawnPolicy: 'within_capacity',
  approvedCapacity: 2,
});
if (resumeExecution.status !== 200) fail('resumeExecution', JSON.stringify(resumeExecution));

const artifacts = await req('GET', `/api/lanes/${lane.body.id}/artifacts`);
log('artifacts', `${(artifacts.body.files || []).length} files`);

// --- API provider lane through dashboard-stored credential ---
const providers = await req('GET', '/api/providers');
if (providers.status !== 200) fail('provider catalog', JSON.stringify(providers));
if (providers.body?.credentialBackend !== 'memory') {
  fail(
    'full-flow API provider smoke requires memory credential backend',
    `Restart Orca with ORCA_CREDENTIAL_BACKEND=memory for safe local provider-secret proof. Current backend=${providers.body?.credentialBackend}`,
  );
}
const apiSecret = `full-flow-api-secret-${slugSuffix}`;
const dummyProvider = await startDummyApiProvider(apiSecret);
const geminiSecret = `full-flow-gemini-secret-${slugSuffix}`;
const dummyGeminiProvider = await startDummyGeminiProvider(geminiSecret);
try {
  const profileUpdate = await req('PATCH', '/api/providers/openai-compatible', {
    actor: 'dashboard',
    approved: true,
    enabled: true,
    baseUrl: dummyProvider.baseUrl,
    apiStyle: 'openai-compatible',
    secretRef: 'provider:openai-compatible',
    apiKeyEnv: 'ORCA_OPENAI_COMPATIBLE_API_KEY',
  });
  if (profileUpdate.status !== 200) fail('provider profile update', JSON.stringify(profileUpdate));
  const setSecret = await req('POST', '/api/providers/openai-compatible/secret', {
    actor: 'dashboard',
    approved: true,
    secret: apiSecret,
  });
  if (setSecret.status !== 200) fail('provider secret set', JSON.stringify(setSecret));
  if (JSON.stringify(setSecret.body).includes(apiSecret)) fail('provider secret response leaked secret');

  const apiLane = await req('POST', `/api/sessions/${session.body.id}/lanes`, {
    title: 'smoke API provider lane',
    executorType: 'openai-compatible',
    owner: 'smoke',
    approved: true,
    taskPrompt: 'Run the full-flow local API provider check.',
    model: 'full-flow-model',
  });
  if (apiLane.status !== 201) fail('createApiProviderLane', JSON.stringify(apiLane));
  const apiLaneDone = await waitForLaneTerminal(apiLane.body.id, 'api provider');
  if (apiLaneDone.body?.state !== 'done') fail('API provider lane should reach done', apiLaneDone.body?.exitReason || JSON.stringify(apiLaneDone.body));
  if (dummyProvider.requests.length !== 1) fail('dummy provider should receive one request', String(dummyProvider.requests.length));
  if (dummyProvider.requests[0].headers.authorization !== `Bearer ${apiSecret}`) fail('dummy provider auth header mismatch');
  if (dummyProvider.requests[0].body.model !== 'full-flow-model') fail('dummy provider model mismatch', JSON.stringify(dummyProvider.requests[0].body));
  if (JSON.stringify(apiLaneDone.body).includes(apiSecret)) fail('API provider lane leaked secret value');
  log('apiProviderLane', `${apiLaneDone.body.state} via ${apiLaneDone.body.processMeta?.credentialBackend || 'unknown'} credential backend`);

  const geminiProfileUpdate = await req('PATCH', '/api/providers/gemini', {
    actor: 'dashboard',
    approved: true,
    enabled: true,
    baseUrl: dummyGeminiProvider.baseUrl,
    apiStyle: 'gemini',
    secretRef: 'provider:gemini',
    apiKeyEnv: 'ORCA_GEMINI_API_KEY',
  });
  if (geminiProfileUpdate.status !== 200) fail('Gemini provider profile update', JSON.stringify(geminiProfileUpdate));
  const setGeminiSecret = await req('POST', '/api/providers/gemini/secret', {
    actor: 'dashboard',
    approved: true,
    secret: geminiSecret,
  });
  if (setGeminiSecret.status !== 200) fail('Gemini provider secret set', JSON.stringify(setGeminiSecret));
  if (JSON.stringify(setGeminiSecret.body).includes(geminiSecret)) fail('Gemini provider secret response leaked secret');

  const geminiLane = await req('POST', `/api/sessions/${session.body.id}/lanes`, {
    title: 'smoke Gemini provider lane',
    executorType: 'gemini',
    owner: 'smoke',
    approved: true,
    taskPrompt: 'Run the full-flow local Gemini provider check.',
    model: 'gemini-1.5-flash',
  });
  if (geminiLane.status !== 201) fail('createGeminiProviderLane', JSON.stringify(geminiLane));
  const geminiLaneDone = await waitForLaneTerminal(geminiLane.body.id, 'gemini provider');
  if (geminiLaneDone.body?.state !== 'done') fail('Gemini provider lane should reach done', geminiLaneDone.body?.exitReason || JSON.stringify(geminiLaneDone.body));
  if (dummyGeminiProvider.requests.length !== 1) fail('dummy Gemini provider should receive one request', String(dummyGeminiProvider.requests.length));
  if (dummyGeminiProvider.requests[0].headers['x-goog-api-key'] !== geminiSecret) fail('dummy Gemini provider API key header mismatch');
  if (dummyGeminiProvider.requests[0].headers.authorization) fail('dummy Gemini provider must not receive Authorization header');
  if (JSON.stringify(geminiLaneDone.body).includes(geminiSecret)) fail('Gemini provider lane leaked secret value');
  log('geminiProviderLane', `${geminiLaneDone.body.state} via ${geminiLaneDone.body.processMeta?.credentialBackend || 'unknown'} credential backend`);
} finally {
  await dummyProvider.close();
  await dummyGeminiProvider.close();
}

// --- evidence: real if Playwright present, degraded otherwise ---
const playwrightBlocker = (blockers.body.blockers || []).find((b) => b.id === 'playwright-missing');
const evidence = await req('POST', `/api/lanes/${lane.body.id}/evidence`, {
  url: `${base}/api/health`,
  modes: ['screenshot'],
  approved: true,
  oneTimeUrlApproved: true,
});
if (evidence.status !== 200) fail('evidence POST should be 200', JSON.stringify(evidence));
if (playwrightBlocker) {
  if (evidence.body?.captured !== false) fail('evidence should be degraded without Playwright', JSON.stringify(evidence.body));
  log('evidence', `degraded ok (captured=false)`);
} else if (evidence.body?.captured === false && isMissingPlaywrightBrowser(evidence.body?.reason || evidence.body?.evidence?.error)) {
  log('evidence', 'degraded ok (Playwright browser binaries unavailable)');
} else {
  if (evidence.body?.captured !== true) fail('evidence should capture with Playwright', JSON.stringify(evidence.body));
  const screenshot = (evidence.body?.evidence?.produced || []).find((name) => name.endsWith('-shot.png'));
  if (!screenshot) fail('evidence should produce a screenshot file', JSON.stringify(evidence.body));
  const fetchShot = await req('GET', `/artifacts/${lane.body.sessionId}/${lane.body.id}/${screenshot}`);
  if (fetchShot.status !== 200) fail('screenshot file should be served', String(fetchShot.status));
  log('evidence', `captured ok (file=${screenshot})`);
}

// --- evidence presets endpoint shape ---
const presets = await req('GET', `/api/lanes/${lane.body.id}/evidence/presets`);
if (presets.status !== 200 || !Array.isArray(presets.body?.presets)) fail('evidence presets shape', JSON.stringify(presets));
log('presets', `${presets.body.presets.length} preset(s)`);

// --- audit queue + ack ---
const audit = await req('POST', `/api/lanes/${lane.body.id}/audit`, { actor: 'dashboard', approved: true });
if (audit.status !== 201) fail('queueLaneAudit', JSON.stringify(audit));
const auditId = audit.body.event?.id || audit.body.id || audit.body.queueId;
log('audit', `id=${auditId}`);
if (auditId) {
  const ack = await req('POST', `/api/audit/events/${auditId}/ack`, { actor: 'dashboard' });
  if (ack.status !== 200) fail('ackAudit', JSON.stringify(ack));
  log('ackedAudit', ack.body.status);
}

// --- cleanup dry-run ---
const cleanup = await req('POST', '/api/artifacts/cleanup', {
  actor: 'dashboard',
  approved: true,
  dryRun: true,
  sessionId: session.body.id,
});
if (cleanup.status !== 200) fail('cleanupDryRun', JSON.stringify(cleanup));
log('cleanupDryRun', `candidates=${cleanup.body.candidates}`);

// --- worktree remove (expected 422 because lane has no managed worktree) ---
const wtRemove = await req('POST', `/api/lanes/${lane.body.id}/worktree/remove`, { actor: 'dashboard', approved: true });
if (wtRemove.status !== 422) fail('worktree remove without managed worktree should be 422', JSON.stringify(wtRemove));
log('worktreeRemoveShape', `${wtRemove.status} ok`);

// --- private access + PWA static assets ---
const privateState = await req('GET', '/api/private-access?fakeTailnetState=serve-https');
if (privateState.status !== 200) fail('private access state', JSON.stringify(privateState));
if (privateState.body.tailnet?.provider !== 'fake') fail('private access fake tailnet state missing', JSON.stringify(privateState.body));
const privatePlan = await req('GET', `/api/private-access/setup-plan?localUrl=${encodeURIComponent(base)}`);
if (privatePlan.status !== 200) fail('private access setup plan', JSON.stringify(privatePlan));
if (!JSON.stringify(privatePlan.body.commands || []).includes('tailscale serve')) fail('private access setup plan missing tailscale serve command');
const privateTarget = await req('POST', '/api/private-access/targets', {
  actor: 'dashboard',
  label: `Full-flow ${slugSuffix}`,
  mode: 'local',
  localUrl: base,
});
if (privateTarget.status !== 201) fail('private access target create', JSON.stringify(privateTarget));
const funnelTarget = await req('POST', '/api/private-access/targets', {
  actor: 'dashboard',
  label: 'Blocked Funnel',
  mode: 'tailnet-https-serve',
  localUrl: base,
  httpsServeUrl: 'https://orca.funnel.ts.net',
});
if (funnelTarget.status !== 422) fail('Funnel private access target should be rejected', JSON.stringify(funnelTarget));
const privateCheck = await req('POST', `/api/private-access/targets/${privateTarget.body.id}/check`, { actor: 'dashboard' });
if (privateCheck.status !== 200) fail('private access target check', JSON.stringify(privateCheck));
const privateDelete = await req('DELETE', `/api/private-access/targets/${privateTarget.body.id}`, { actor: 'dashboard' });
if (privateDelete.status !== 200) fail('private access target delete', JSON.stringify(privateDelete));
log('privateAccess', 'fake states, dry-run setup, target check, and Funnel rejection ok');

const webManifest = await req('GET', '/manifest.webmanifest');
if (webManifest.status !== 200 || !webManifest.text.includes('"start_url"')) fail('web manifest', String(webManifest.status));
const serviceWorker = await req('GET', '/service-worker.js');
if (serviceWorker.status !== 200) fail('service worker', String(serviceWorker.status));
if (!serviceWorker.text.includes('/api/') || !serviceWorker.text.includes('/artifacts/')) fail('service worker missing sensitive route bypasses');
log('pwa', 'manifest and static-only service worker guards present');

// --- notifications ---
const notificationSettings = await req('PATCH', '/api/notifications/settings', {
  actor: 'dashboard',
  approved: true,
  inAppEnabled: true,
  browserEnabled: true,
  minSeverity: 'info',
  muted: false,
});
if (notificationSettings.status !== 200) fail('notification settings update', JSON.stringify(notificationSettings));
const notifications = await req('GET', '/api/notifications');
if (notifications.status !== 200) fail('notifications list', JSON.stringify(notifications));
if (JSON.stringify(notifications.body).includes(apiSecret) || JSON.stringify(notifications.body).includes(geminiSecret)) {
  fail('notifications leaked provider secret');
}
const markAll = await req('POST', '/api/notifications/read-all', { actor: 'dashboard' });
if (markAll.status !== 200) fail('notifications mark all read', JSON.stringify(markAll));
log('notifications', `readAll=${markAll.body.updatedCount ?? 'ok'}`);

// --- import/export redaction ---
const appExport = await req('GET', '/api/app/export');
if (appExport.status !== 200) fail('app export', JSON.stringify(appExport));
if (appExport.body.excludesSecrets !== true || appExport.body.includesAuthSessions !== false) fail('app export redaction flags', JSON.stringify(appExport.body));
if (JSON.stringify(appExport.body).includes(apiSecret) || JSON.stringify(appExport.body).includes(geminiSecret)) fail('app export leaked provider secret');
const appImportDryRun = await req('POST', '/api/app/import/dry-run', appExport.body);
if (appImportDryRun.status !== 200 || appImportDryRun.body.dryRun !== true) fail('app import dry-run', JSON.stringify(appImportDryRun));
const leakyImport = await req('POST', '/api/app/import/dry-run', {
  ...appExport.body,
  secretValue: apiSecret,
});
if (leakyImport.status !== 422) fail('leaky app import should be rejected', JSON.stringify(leakyImport));
if (JSON.stringify(leakyImport.body).includes(apiSecret)) fail('leaky app import echoed secret');
const supportBundle = await req('GET', '/api/app/support-bundle');
if (supportBundle.status !== 200) fail('support bundle', JSON.stringify(supportBundle));
if (JSON.stringify(supportBundle.body).includes(apiSecret) || JSON.stringify(supportBundle.body).includes(geminiSecret)) fail('support bundle leaked provider secret');
log('appBackup', 'export/import/support redaction ok');

// --- browser proof: paired-cookie desktop and phone screenshots ---
const browserProof = await captureBrowserScreenshots({
  sessionCookie,
  projectId: project.body.id,
  sessionId: session.body.id,
  laneId: lane.body.id,
});
if (!browserProof.skipped && (!browserProof.screenshots || browserProof.screenshots.length < 2)) {
  fail('browser screenshot proof incomplete', JSON.stringify(browserProof));
}

const elapsed = Date.now() - start;
log('done', `${elapsed}ms`);
}

try {
  await main();
} finally {
  await cleanupStartedServer();
}
