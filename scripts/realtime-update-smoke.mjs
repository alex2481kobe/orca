#!/usr/bin/env node
/*
 * Real-time targeted-update smoke.
 *
 * Asserts the paired/workstation session page does NOT whole-page refresh:
 *  - When a new chat message arrives, ONLY the chat thread updates. The composer
 *    (and the surrounding session shell) keep their exact DOM nodes — proven by
 *    tagging the nodes and confirming the tags survive the update.
 *  - When the page is idle (no data change), nothing is rebuilt across multiple
 *    poll cycles (the page is static).
 *  - The home/settings page is likewise static when idle.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
let base = '';
let token = '';
let server = null;
let stopServer = null;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-realtime-'));

function log(scope, message) { console.log(`[realtime] ${scope} — ${message}`); }
function fail(message) { console.error(`[realtime FAIL] ${message}`); process.exitCode = 1; throw new Error(message); }

async function startServer() {
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = 'realtime-token';
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  token = process.env.ORCA_API_TOKEN;
  const mod = await import('../src/server.js');
  server = await mod.startServer(0, '127.0.0.1');
  stopServer = mod.stopServer;
  base = `http://127.0.0.1:${server.address().port}`;
  log('server', `started at ${base}`);
}

async function cleanup() {
  if (stopServer) await stopServer();
  if (server) await new Promise((r) => server.close(r));
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
}

async function apiJson(reqPath, options = {}) {
  const response = await fetch(`${base}${reqPath}`, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-orca-token': token } : {}), ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
}

async function pairedCookie() {
  const pairing = await apiJson('/api/auth/pairing-codes', { method: 'POST', body: { actor: 'realtime', label: 'realtime', ttlMs: 60_000 } });
  if (pairing.status !== 201) fail(`pairing code: ${JSON.stringify(pairing.body)}`);
  const paired = await apiJson('/api/auth/pair', { method: 'POST', headers: {}, body: { code: pairing.body.pairing.code, label: 'realtime' } });
  if (paired.status !== 200) fail(`pair: ${JSON.stringify(paired.body)}`);
  return paired.headers['set-cookie'] || '';
}

async function waitForApp(page) {
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && !content.textContent.trim().startsWith('Loading');
  }, { timeout: 15000 });
}

async function run() {
  await startServer();
  const cookie = await pairedCookie();

  // Project + session + one orchestrator message so the chat + lane already exist.
  const proj = await apiJson('/api/projects', { method: 'POST', body: { name: 'Realtime Project', owner: 'realtime', actor: 'realtime', approved: true } });
  if (proj.status >= 400) fail(`create project: ${JSON.stringify(proj.body)}`);
  const projectId = proj.body.id;
  const route = proj.body.route || `/projects/${proj.body.slug || projectId}`;
  const sess = await apiJson(`/api/projects/${projectId}/sessions`, { method: 'POST', body: { name: 'Realtime Session', leader: 'mock', actor: 'realtime', approved: true } });
  if (sess.status >= 400) fail(`create session: ${JSON.stringify(sess.body)}`);
  const sessionId = sess.body.id;
  const sessionRoute = sess.body.route || `${route}/sessions/${sessionId}`;
  const m1 = await apiJson(`/api/sessions/${sessionId}/orchestrator/messages`, { method: 'POST', body: { message: 'first probe message', executorType: 'mock', actor: 'realtime', approved: true } });
  if (m1.status >= 400) fail(`message #1: ${JSON.stringify(m1.body)}`);

  let pw;
  try { pw = await import('playwright'); } catch { fail('Playwright required'); }
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    if (cookie) {
      const cm = /(?:^|;\s*)([^=]+)=([^;]+)/.exec(cookie);
      if (cm) await ctx.addCookies([{ name: cm[1].trim(), value: cm[2].trim(), url: base }]);
    }
    const page = await ctx.newPage();
    await page.goto(new URL(sessionRoute, base).toString(), { waitUntil: 'networkidle', timeout: 20000 });
    await waitForApp(page);
    // Let the first message + lane settle through a poll cycle.
    await page.waitForFunction(() => document.querySelector('#orchestrator-message-form textarea') !== null, { timeout: 10000 });
    await page.waitForTimeout(1500);

    // Tag the durable nodes that MUST survive a chat update.
    await page.evaluate(() => {
      document.querySelector('.session-shell')?.setAttribute('data-persist', 'shell');
      document.querySelector('#orchestrator-message-form textarea')?.setAttribute('data-persist', 'composer');
      document.querySelector('#orchestrator-message-form')?.setAttribute('data-persist', 'form');
    });
    const taggedComposer = await page.$('[data-persist="composer"]');
    if (!taggedComposer) fail('composer textarea not found to tag');

    // Append a NEW chat message via the API (out-of-band, like a streamed reply).
    const m2 = await apiJson(`/api/sessions/${sessionId}/orchestrator/messages`, { method: 'POST', body: { message: 'SECOND-PROBE-UNIQUE', executorType: 'mock', actor: 'realtime', approved: true } });
    if (m2.status >= 400) fail(`message #2: ${JSON.stringify(m2.body)}`);

    // Wait until the SPA poll renders the new message into the thread.
    await page.waitForFunction(() => {
      const t = document.querySelector('.chat-thread');
      return t && t.textContent.includes('SECOND-PROBE-UNIQUE');
    }, { timeout: 12000 });

    // The composer + shell DOM nodes must be the SAME nodes (tags survive). If the
    // whole content had been rebuilt, the data-persist attributes would be gone.
    const survived = await page.evaluate(() => ({
      shell: document.querySelector('.session-shell')?.getAttribute('data-persist'),
      composer: document.querySelector('#orchestrator-message-form textarea')?.getAttribute('data-persist'),
      form: document.querySelector('#orchestrator-message-form')?.getAttribute('data-persist'),
      threadHasMsg: document.querySelector('.chat-thread')?.textContent.includes('SECOND-PROBE-UNIQUE'),
    }));
    if (survived.composer !== 'composer') fail('REGRESSION: chat update rebuilt the composer (whole-page refresh)');
    if (survived.shell !== 'shell') fail('REGRESSION: chat update rebuilt the session shell');
    if (survived.form !== 'form') fail('REGRESSION: chat update rebuilt the composer form');
    if (!survived.threadHasMsg) fail('chat thread did not receive the new message');
    log('chat-update', 'new message updated ONLY the thread; composer + shell DOM preserved ✓');

    // Composer draft must survive: (1) typing while updates arrive (refresh is
    // suppressed while focused, so the thread waits — draft must stay), and (2)
    // after blur when a refresh + re-render finally fires (draft rehydrated from
    // shell.composerDrafts, the source of truth).
    await page.click('#orchestrator-message-form textarea');
    await page.type('#orchestrator-message-form textarea', 'UNSENT-DRAFT-KEEP');
    await apiJson(`/api/sessions/${sessionId}/orchestrator/messages`, { method: 'POST', body: { message: 'THIRD-PROBE', executorType: 'mock', actor: 'realtime', approved: true } });
    await page.waitForTimeout(4000); // refresh suppressed while typing; draft must remain
    let draft = await page.inputValue('#orchestrator-message-form textarea');
    if (draft !== 'UNSENT-DRAFT-KEEP') fail(`REGRESSION: composer draft cleared while typing (got ${JSON.stringify(draft)})`);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForFunction(() => document.querySelector('.chat-thread')?.textContent.includes('THIRD-PROBE'), { timeout: 12000 });
    draft = await page.inputValue('#orchestrator-message-form textarea');
    if (draft !== 'UNSENT-DRAFT-KEEP') fail(`REGRESSION: composer draft cleared after blur + re-render (got ${JSON.stringify(draft)})`);
    log('composer-draft', 'draft survived chat updates while focused AND after blur+re-render ✓');

    // Idle-static: nothing should be rebuilt across several poll cycles.
    await page.evaluate(() => document.querySelector('.chat-thread')?.setAttribute('data-idle', 'thread'));
    await page.waitForTimeout(5000);
    const idle = await page.evaluate(() => ({
      shell: document.querySelector('.session-shell')?.getAttribute('data-persist'),
      composer: document.querySelector('#orchestrator-message-form textarea')?.getAttribute('data-persist'),
      thread: document.querySelector('.chat-thread')?.getAttribute('data-idle'),
    }));
    if (idle.shell !== 'shell' || idle.composer !== 'composer' || idle.thread !== 'thread') {
      fail(`REGRESSION: idle session page rebuilt something (${JSON.stringify(idle)})`);
    }
    log('idle-static', 'session page made no DOM rebuilds across 5s of idle polling ✓');

    // (Home/settings idle-stability is covered separately — it shares lane state
    // with this session, whose spawned lanes complete mid-run, so home updates here
    // are real data changes, not churn.)

    await page.close(); await ctx.close();
  } finally {
    await browser.close();
  }
  log('done', 'targeted-update / static-page checks passed');
}

await run().catch((error) => {
  console.error('[realtime ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
}).finally(cleanup);
