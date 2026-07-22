#!/usr/bin/env node
/*
 * Orca end-to-end smoke.
 *
 * Walks the operator path against a running local server and proves both the
 * happy path AND that the security guards reject the bad path:
 *   1. health, policy, mobile manifest, system blockers
 *   2. unauthorized POST → 401
 *   3. spoofed actor (scheduler/system) → 403
 *   4. oversized JSON body → 413
 *   5. malformed JSON body → 400
 *   6. malformed query string → 400
 *   7. orchestrator register (project-by-cwd) + mock executor lane; lane reaches done
 *   8. MCP CRUD + Codex executor lane attachment (blocked execution OK)
 *   9. audit queue + ack + worktree route shape
 *  10. private access states/targets (Funnel rejection), PWA static guards
 *  11. notifications settings + read-all
 *
 * (v2 note: provider-config HTTP routes, browsing/evidence, app export/import,
 * and artifacts/cleanup were removed in the v2 refactor; their sections were
 * dropped here. Provider secret-redaction coverage lives in the node suite —
 * test/provider-profiles.test.js and test/api-provider-executor.test.js.)
 *
 * Usage:
 *   node scripts/smoke.mjs
 *   ORCA_API_TOKEN=<token> node scripts/smoke.mjs --base http://127.0.0.1:3000
 *
 * Exits non-zero on the first failing step so it can gate startup.
 */

import fs from 'node:fs/promises';
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
    // v2 UI: the home/overview screen is hash-less; project drill-in is via the
    // sidebar, not a `#project:` hash. Prove responsive render at desktop + phone.
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 920, path: '/' },
      { name: 'phone', width: 390, height: 844, path: '/' },
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
        return content && !content.textContent.trim().startsWith('Connecting');
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

// Regression guard for the remote-device pairing GATE. An unpaired device behind
// Tailscale Serve arrives PROXIED (x-forwarded-* headers), which disables the
// loopback bootstrap-admin trust → /api/overview 401s. The UI MUST render the
// pairing gate (code entry) rather than sit on "Connecting…" forever — the exact
// gate-less-phone regression this proves against. Then a valid code must pair the
// device through the UI and drop it onto the dashboard.
async function capturePairingGateProof() {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch (error) { log('pairing gate proof', `skipped (${error.message})`); return { skipped: true }; }
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { log('pairing gate proof', `skipped (${error.message})`); return { skipped: true }; }
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    // Make every request look like it came through the Serve proxy.
    await context.route('**/*', (route) => {
      const h = { ...route.request().headers() };
      h['x-forwarded-for'] = '100.115.92.33';
      h['x-forwarded-proto'] = 'http';
      route.continue({ headers: h });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message || String(error)));
    await page.goto(new URL('/', base).toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#pairing-code-input', { timeout: 15000 })
      .catch(() => fail('pairing gate not rendered for unpaired remote', 'no #pairing-code-input — phone would be stuck on Connecting'));
    if (!(await page.evaluate(() => document.body.classList.contains('access-gated')))) {
      fail('pairing gate should set body.access-gated', 'missing');
    }
    // A fresh, valid code pairs the device THROUGH THE UI → dashboard.
    const mk = await req('POST', '/api/auth/pairing-codes', { actor: 'dashboard', label: 'Gate proof', ttlMs: 60_000 });
    const code = mk.body?.pairing?.code;
    if (!code) fail('pairing gate proof: could not mint code', JSON.stringify(mk));
    await page.fill('#pairing-code-input', code);
    await page.click('[data-action="pairBrowserSession"]');
    await page.waitForFunction(
      () => !document.getElementById('pairing-code-input') && !document.body.classList.contains('access-gated'),
      { timeout: 15000 },
    ).catch(() => fail('pairing gate did not clear after a valid code', 'still gated'));
    if (errors.length) fail('pairing gate console errors', errors.join(' | '));
    await context.close();
    log('pairing gate proof', 'unpaired remote → gate → valid code → dashboard');
    return { ok: true };
  } finally {
    await browser.close();
  }
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
// v2: lanes hang off an orchestrator RECORD registered by cwd, not a session.
// We deliberately register against a NON-git working dir (the smoke tempDir), so
// executor lanes run "direct" with no managed worktree — this preserves the
// worktree/remove → 422 assertion below (a git repo would auto-provision an
// isolated worktree and change that shape).
let registerCwd = null;
if (!explicitBase) {
  process.chdir(tempDir);
  registerCwd = await fs.realpath(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_API_TOKEN = 'full-flow-smoke-token';
  process.env.ORCA_REPO_ROOTS = registerCwd;
  token = process.env.ORCA_API_TOKEN;
  refreshTokenHeaders();
  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
} else {
  registerCwd = await fs.realpath(previousCwd);
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

// --- happy-path: register orchestrator (project-by-cwd) + mock executor lane ---
const slugSuffix = Date.now().toString(36).slice(-6);
// v2: an orchestrator registers by cwd (implicitly creating the project keyed by
// cwd) and lanes are spawned under the orchestrator record — replacing the old
// project→session→lane container chain. Admin token → leaseId 'dashboard'.
const orchestrator = await req('POST', '/api/orchestrators', {
  actor: 'smoke',
  cwd: registerCwd,
  title: `Smoke Orchestrator ${slugSuffix}`,
});
if (orchestrator.status !== 200 || !String(orchestrator.body?.id || '').startsWith('orc_')) fail('registerOrchestrator', JSON.stringify(orchestrator));
const orchestratorId = orchestrator.body.id;
log('orchestrator', `${orchestratorId} (project=${orchestrator.body.projectId})`);

const lane = await req('POST', `/api/orchestrators/${orchestratorId}/executors`, {
  title: 'smoke lane',
  role: 'executor',
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

const codexLane = await req('POST', `/api/orchestrators/${orchestratorId}/executors`, {
  title: 'smoke codex lane',
  role: 'executor',
  executorType: 'codex',
  executorBinary: process.env.ORCA_CODEX_BINARY || 'codex',
  mcpToolIds: [tool.body.id],
  approved: true,
  taskPrompt: 'Plan only',
  model: 'gpt-5',
  permissionsProfile: 'plan',
});
if (codexLane.status !== 201 || !codexLane.body?.id) fail('createCodexLane', JSON.stringify(codexLane));
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

const artifacts = await req('GET', `/api/lanes/${lane.body.id}/artifacts`);
log('artifacts', `${(artifacts.body.files || []).length} files`);

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
const markAll = await req('POST', '/api/notifications/read-all', { actor: 'dashboard' });
if (markAll.status !== 200) fail('notifications mark all read', JSON.stringify(markAll));
log('notifications', `readAll=${markAll.body.updatedCount ?? 'ok'}`);

// --- browser proof: paired-cookie desktop and phone screenshots ---
const browserProof = await captureBrowserScreenshots({
  sessionCookie,
  projectId: orchestrator.body.projectId,
  sessionId: orchestratorId,
  laneId: lane.body.id,
});
if (!browserProof.skipped && (!browserProof.screenshots || browserProof.screenshots.length < 2)) {
  fail('browser screenshot proof incomplete', JSON.stringify(browserProof));
}

// --- pairing gate proof: unpaired remote sees the gate, then pairs into the app ---
const gateProof = await capturePairingGateProof();

// The browser/gate proofs degrade to a silent "skipped" (green) when Playwright
// is unavailable. For a real final-pass / CI run, set ORCA_REQUIRE_BROWSER_PROOF=1
// so a skip becomes a hard failure — a green run then actually proves the gate ran.
if (process.env.ORCA_REQUIRE_BROWSER_PROOF) {
  if (browserProof.skipped) fail('browser proof was skipped but ORCA_REQUIRE_BROWSER_PROOF is set', browserProof.reason || '');
  if (gateProof && gateProof.skipped) fail('pairing gate proof was skipped but ORCA_REQUIRE_BROWSER_PROOF is set', gateProof.reason || '');
}

const elapsed = Date.now() - start;
log('done', `${elapsed}ms`);
}

try {
  await main();
} finally {
  await cleanupStartedServer();
}
