#!/usr/bin/env node
/*
 * Disclosure / popover persistence smoke (regression for "opens then auto-closes").
 *
 * Reproduces the reported bug: an open <details> disclosure or a half-typed input
 * on a screen that re-renders from a background poll/SSE got wiped within ~1-3s
 * ("opens then auto-closes" / "input reverts").
 *
 * Case 1 (unpaired phone access/pairing gate): the gate has no disclosures, so we
 * assert the in-progress pairing-label input survives several background refresh
 * cycles. Case 2 (paired project view): we assert BOTH a disclosure stays open and
 * a typed input is retained across the same window.
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
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-disclosure-'));

function log(scope, message) { console.log(`[disclosure] ${scope} — ${message}`); }
function fail(message) { console.error(`[disclosure FAIL] ${message}`); process.exitCode = 1; throw new Error(message); }

async function startServer() {
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = 'disclosure-token';
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
  const pairing = await apiJson('/api/auth/pairing-codes', { method: 'POST', body: { actor: 'disclosure', label: 'disclosure', ttlMs: 60_000 } });
  if (pairing.status !== 201) fail(`pairing code: ${JSON.stringify(pairing.body)}`);
  const paired = await apiJson('/api/auth/pair', { method: 'POST', headers: {}, body: { code: pairing.body.pairing.code, label: 'disclosure' } });
  if (paired.status !== 200) fail(`pair: ${JSON.stringify(paired.body)}`);
  return paired.headers['set-cookie'] || '';
}

async function waitForApp(page) {
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && !content.textContent.trim().startsWith('Loading');
  }, { timeout: 15000 });
}

// Wait long enough to cross several background-poll cycles (poll runs every 500ms,
// refresh cadence 1-3s). 5s guarantees multiple re-render opportunities.
const POLL_WAIT_MS = 5000;

async function findDetailsBySummary(page, text) {
  return page.evaluateHandle((t) => {
    const all = Array.from(document.querySelectorAll('#content details'));
    return all.find((d) => (d.querySelector('summary')?.textContent || '').includes(t)) || null;
  }, text);
}

async function detailsOpenState(page, text) {
  return page.evaluate((t) => {
    const all = Array.from(document.querySelectorAll('#content details'));
    const d = all.find((x) => (x.querySelector('summary')?.textContent || '').includes(t));
    return d ? d.open : null;
  }, text);
}

async function run() {
  await startServer();
  let pw;
  try { pw = await import('playwright'); } catch { fail('Playwright required'); }
  const browser = await pw.chromium.launch({ headless: true });

  try {
    // ---- Case 1: unpaired phone access/pairing gate, in-progress input survives.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const gate = await phone.newPage();
    await gate.goto(base, { waitUntil: 'networkidle', timeout: 20000 });
    await waitForApp(gate);

    // The gate must actually be the pairing gate (the regression is specific to it).
    if (!(await gate.$('#pairing-label-input'))) fail('access gate: pairing-label input not found');

    // Type into the pairing label field to verify in-progress input survives.
    await gate.fill('#pairing-label-input', 'my pixel 8');
    // Blur focus so background refreshes are NOT suppressed by the isEditingContent
    // guard — otherwise no re-render fires and the test can't observe the bug.
    await gate.evaluate(() => document.activeElement && document.activeElement.blur());
    if (await gate.evaluate(() => !!document.activeElement?.closest?.('.ops-main'))) fail('test setup: focus still inside content; refreshes would be suppressed');

    // Wait across multiple poll cycles — the regression window.
    await gate.waitForTimeout(POLL_WAIT_MS);

    const labelVal = await gate.inputValue('#pairing-label-input');
    if (labelVal !== 'my pixel 8') fail(`REGRESSION: pairing label reverted to "${labelVal}"`);
    const shotDir = path.resolve(previousCwd, 'artifacts', 'disclosure');
    await fs.mkdir(shotDir, { recursive: true });
    await gate.screenshot({ path: path.join(shotDir, 'access-gate-open-after-wait.png'), fullPage: true });
    log('access-gate', `pairing input retained after ${POLL_WAIT_MS}ms ✓`);
    await gate.close();
    await phone.close();

    // ---- Case 2: paired project view, "Agent flow" details
    const cookie = await pairedCookie();
    const created = await apiJson('/api/projects', { method: 'POST', body: { name: 'Disclosure Project', owner: 'disclosure', actor: 'disclosure', approved: true } });
    if (created.status >= 400) fail(`create project: ${JSON.stringify(created.body)}`);
    const route = created.body?.route || created.body?.project?.route || `/projects/${created.body?.slug || created.body?.id}`;

    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    if (cookie) {
      const m = /(?:^|;\s*)([^=]+)=([^;]+)/.exec(cookie);
      if (m) await ctx.addCookies([{ name: m[1].trim(), value: m[2].trim(), url: base }]);
    }
    // ---- Case 2a: a settings <details> stays open across background refresh.
    const settings = await ctx.newPage();
    await settings.goto(new URL('/#system', base).toString(), { waitUntil: 'networkidle', timeout: 20000 });
    await waitForApp(settings);
    const firstSummary = await settings.evaluate(() => {
      const d = document.querySelector('#content details');
      return d ? (d.querySelector('summary')?.textContent || '').replace(/\s+/g, ' ').trim() : null;
    });
    if (!firstSummary) fail('settings view: no <details> disclosure found');
    await settings.evaluate(() => document.querySelector('#content details > summary')?.click());
    if ((await detailsOpenState(settings, firstSummary)) !== true) fail('settings view: disclosure did not open');
    await settings.evaluate(() => document.activeElement && document.activeElement.blur());
    await settings.waitForTimeout(POLL_WAIT_MS);
    if ((await detailsOpenState(settings, firstSummary)) !== true) fail('REGRESSION: settings disclosure auto-closed after background refresh');
    log('settings', `"${firstSummary}" disclosure still open after ${POLL_WAIT_MS}ms ✓`);
    await settings.close();

    // ---- Case 2b: the project chat composer keeps what's typed across refresh.
    const proj = await ctx.newPage();
    await proj.goto(new URL(route, base).toString(), { waitUntil: 'networkidle', timeout: 20000 });
    await waitForApp(proj);
    const composerSel = '#orchestrator-message-form textarea[name="message"]';
    if (!(await proj.$(composerSel))) fail('project chat: composer textarea not found');
    await proj.fill(composerSel, 'persisted composer draft');
    await proj.evaluate(() => document.activeElement && document.activeElement.blur());
    if (await proj.evaluate(() => !!document.activeElement?.closest?.('.ops-main'))) fail('test setup: focus still inside content; refreshes would be suppressed');
    await proj.waitForTimeout(POLL_WAIT_MS);
    const draftVal = await proj.inputValue(composerSel);
    if (draftVal !== 'persisted composer draft') fail(`REGRESSION: composer draft reverted to "${draftVal}"`);
    log('project', `composer draft retained after ${POLL_WAIT_MS}ms ✓`);
    await proj.close();
    await ctx.close();
  } finally {
    await browser.close();
  }
  log('done', 'all disclosure/popover persistence checks passed');
}

await run().catch((error) => {
  console.error('[disclosure ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
}).finally(cleanup);
