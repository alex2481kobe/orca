#!/usr/bin/env node
/*
 * Proves the dashboard orchestrator chat can start an orchestrator lane and
 * render the resulting conversation/activity without direct API cheating.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orch-ui-'));
const token = 'orchestrator-ui-smoke-token';
let server = null;
let stopServer = null;
let base = '';

const log = (label, info = '') => console.log(`[orchestrator-ui-smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[orchestrator-ui-smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

async function req(method, route, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-orca-token': token,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { status: response.status, body: data, headers: Object.fromEntries(response.headers.entries()) };
}

async function createBrowserSessionCookie() {
  const pairing = await req('POST', '/api/auth/pairing-codes', {
    actor: 'orchestrator-ui-smoke',
    label: 'orchestrator ui smoke browser',
    ttlMs: 60_000,
  });
  if (pairing.status !== 201) fail('pairing code create', JSON.stringify(pairing.body));
  const paired = await req('POST', '/api/auth/pair', {
    code: pairing.body.pairing.code,
    label: 'orchestrator ui smoke browser',
  }, {});
  if (paired.status !== 200) fail('browser pair', JSON.stringify(paired.body));
  return paired.headers['set-cookie'] || '';
}

async function addSessionCookie(context, cookieHeader) {
  const [cookiePair] = String(cookieHeader || '').split(';');
  const [name, ...valueParts] = cookiePair.split('=');
  if (!name || !valueParts.length) return;
  await context.addCookies([{
    name: name.trim(),
    value: valueParts.join('=').trim(),
    url: base,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
}

async function cleanup() {
  if (stopServer) await stopServer();
  if (server) await new Promise((resolve) => server.close(resolve));
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
}

try {
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';

  const [{ chromium }, serverModule] = await Promise.all([
    import('playwright'),
    import('../src/server.js'),
  ]);
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
  log('server', base);

  const project = await req('POST', '/api/projects', {
    actor: 'dashboard',
    approved: true,
    name: 'Orchestrator UI Smoke',
  });
  if (project.status !== 201) fail('project create', JSON.stringify(project.body));
  const session = await req('POST', `/api/projects/${project.body.id}/sessions`, {
    actor: 'dashboard',
    approved: true,
    name: 'Dashboard chat session',
    leader: 'codex',
    approvedCapacity: 2,
    spawnPolicy: 'within_capacity',
  });
  if (session.status !== 201) fail('session create', JSON.stringify(session.body));

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await addSessionCookie(context, await createBrowserSessionCookie());
    const page = await context.newPage();
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) log(`browser ${message.type()}`, message.text());
    });
    page.on('pageerror', (error) => log('browser pageerror', error.stack || error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${base}${session.body.route}`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector('#orchestrator-message-form textarea[name="message"]', { timeout: 15000 });
    // Selects are now custom dropdowns: click the trigger, then the option.
    const pick = async (name, value) => {
      const dd = page.locator(`#orchestrator-message-form .dd:has(select[name="${name}"])`);
      await dd.locator('.dd-trigger').click();
      await dd.locator(`.dd-opt[data-v="${value}"]`).click();
    };
    await pick('executorType', 'mock');
    await pick('permissionsProfile', 'plan');
    // Model is carried on a hidden field (chosen per-agent); set it directly.
    await page.$eval('#orchestrator-message-form input[name="model"]', (el, v) => { el.value = v; }, 'gpt-5');
    await page.fill('#orchestrator-message-form textarea[name="message"]', 'Start the launch verification lane from the dashboard chat.');
    const responsePromise = page.waitForResponse((response) => response.url().includes('/orchestrator/messages'), { timeout: 15000 });
    await page.click('#orchestrator-message-form button[type="submit"]');
    // Sending a chat message no longer pops a confirm modal — the operator's send
    // IS the approval (like a normal chat). The request fires straight through.
    const turnResponse = await responsePromise;
    if (turnResponse.status() !== 201) {
      fail('orchestrator message response', `${turnResponse.status()} ${await turnResponse.text()}`);
    }
    try {
      // Codex-style chat: the turn renders user + assistant message bubbles.
      await page.waitForFunction(() =>
        document.querySelectorAll('.chat-thread .msg').length >= 2,
      { timeout: 15000 });
    } catch (error) {
      const text = await page.evaluate(() => (document.body.textContent || '').slice(0, 4000));
      fail('orchestrator chat/activity did not render', text);
    }
    log('dashboard', 'message submitted and activity rendered');

    const thread = await req('GET', `/api/sessions/${session.body.id}/orchestrator`);
    if (thread.status !== 200) fail('thread fetch', JSON.stringify(thread.body));
    const laneId = thread.body?.activeLaneId;
    if (!laneId) fail('missing active orchestrator lane', JSON.stringify(thread.body));
    const lane = await req('GET', `/api/lanes/${laneId}`);
    if (lane.status !== 200) fail('lane fetch', JSON.stringify(lane.body));
    if (lane.body.owner !== 'orchestrator') fail('lane owner', JSON.stringify(lane.body));
    if (lane.body.executorType !== 'mock') fail('lane executor', JSON.stringify(lane.body));
    if (lane.body.model !== 'gpt-5') fail('lane model', JSON.stringify(lane.body));
    if (lane.body.permissionsProfile !== 'plan') fail('lane mode', JSON.stringify(lane.body));
    if (lane.body.intelligenceProfile !== 'high') fail('lane intelligence', JSON.stringify(lane.body));
    if (!Array.isArray(lane.body.agentEvents) || !lane.body.agentEvents.some((event) => event.type === 'agent.queued')) {
      fail('lane agent events', JSON.stringify(lane.body.agentEvents || []));
    }
    log('lane', `${laneId} ${lane.body.state} model=${lane.body.model} mode=${lane.body.permissionsProfile}`);
    await context.close();
  } finally {
    await browser.close();
  }
  log('done', 'ok');
} finally {
  await cleanup();
}
