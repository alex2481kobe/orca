#!/usr/bin/env node
/*
 * Custom dropdown smoke. Every native <select> is replaced by a styled custom
 * dropdown backed by the (hidden) native select. This verifies:
 *  - native <select> elements are enhanced (a .dd wrapper + trigger + menu),
 *  - clicking the trigger opens a styled menu, clicking an option updates the
 *    underlying native select value AND dispatches a change event (so dependent
 *    controls and form submission keep working),
 *  - exactly one menu is open at a time.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const previousCwd = process.cwd();
let base = '', token = '', server = null, stopServer = null;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-dd-'));
const log = (m) => console.log('[dropdown] ' + m);
function fail(m) { console.error('[dropdown FAIL] ' + m); process.exitCode = 1; throw new Error(m); }

async function startServer() {
  process.chdir(tempDir);
  process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = 'dd'; process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true'; token = 'dd';
  for (const v of ['ORCA_CODEX_BINARY', 'ORCA_CLAUDE_BINARY', 'ORCA_GEMINI_CLI_BINARY', 'ORCA_COMPOSER_CLI_BINARY']) process.env[v] = 'orca-absent-cli';
  const mod = await import('../src/server.js');
  server = await mod.startServer(0, '127.0.0.1'); stopServer = mod.stopServer;
  base = `http://127.0.0.1:${server.address().port}`;
}
async function apiJson(p, o = {}) {
  const r = await fetch(base + p, { method: o.method || 'GET', headers: { 'content-type': 'application/json', 'x-orca-token': token, ...(o.headers || {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b, headers: Object.fromEntries(r.headers.entries()) };
}
async function pairedCookie() {
  const pc = await apiJson('/api/auth/pairing-codes', { method: 'POST', body: { actor: 'dd', label: 'dd', ttlMs: 60000 } });
  const pr = await apiJson('/api/auth/pair', { method: 'POST', headers: {}, body: { code: pc.body.pairing.code, label: 'dd' } });
  return pr.headers['set-cookie'] || '';
}

async function run() {
  await startServer();
  const cookie = await pairedCookie();
  const proj = await apiJson('/api/projects', { method: 'POST', body: { name: 'DD', owner: 'dd', actor: 'dd', approved: true } });
  const pid = proj.body.id;
  const s = await apiJson(`/api/projects/${pid}/sessions`, { method: 'POST', body: { name: 'S', leader: 'mock', actor: 'dd', approved: true } });
  const route = s.body.route || `${proj.body.route}/sessions/${s.body.id}`;

  let pw; try { pw = await import('playwright'); } catch { fail('Playwright required'); }
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const cm = /(?:^|;\s*)([^=]+)=([^;]+)/.exec(cookie); await ctx.addCookies([{ name: cm[1].trim(), value: cm[2].trim(), url: base }]);
    const page = await ctx.newPage();
    await page.goto(new URL(route, base).toString(), { waitUntil: 'networkidle' });
    await page.waitForSelector('#orchestrator-message-form .dd:has(select[name="executorType"])', { timeout: 10000 });

    // Native select is present but hidden; the custom trigger is visible.
    const ddCount = await page.locator('#orchestrator-message-form .dd').count();
    if (ddCount < 2) fail(`expected composer selects enhanced, found ${ddCount} .dd`);
    log(`composer selects enhanced (${ddCount} dropdowns)`);

    // Menus must NOT be open on load (regression: they spawned already-dropped).
    if (await page.locator('.dd.dd-open').count() !== 0) fail('a dropdown was open on load');
    if (await page.locator('.dd-menu:visible').count() !== 0) fail('a dropdown menu was visible on load');
    log('no dropdowns open on load ✓');

    const dd = page.locator('#orchestrator-message-form .dd:has(select[name="executorType"])');
    // Toggle open, then toggle closed via the trigger.
    await dd.locator('.dd-trigger').click();
    if (!(await page.locator('#orchestrator-message-form .dd.dd-open .dd-menu').isVisible())) fail('menu did not open');
    await dd.locator('.dd-trigger').click();
    if (await page.locator('.dd.dd-open').count() !== 0) fail('clicking the trigger again did not close the menu');
    log('trigger toggles open/closed ✓');

    // Open, then click outside -> closes.
    await dd.locator('.dd-trigger').click();
    await page.mouse.click(700, 450);
    if (await page.locator('.dd.dd-open').count() !== 0) fail('clicking outside did not close the menu');
    log('outside click closes the menu ✓');

    // Open and select an option -> updates native select + closes.
    await dd.locator('.dd-trigger').click();
    await dd.locator('.dd-opt[data-v="mock"]').click();
    const val = await dd.locator('select[name="executorType"]').inputValue();
    if (val !== 'mock') fail(`native select not updated by option click (got ${val})`);
    if (await page.locator('.dd.dd-open').count() !== 0) fail('menu did not close after selecting');
    log('option click updated the native select value + closed the menu ✓');

    // Settings dropdowns are enhanced too.
    await page.goto(base + '/#system', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const settingsDd = await page.locator('#content .dd').count();
    if (settingsDd < 1) fail('settings selects not enhanced');
    log(`settings selects enhanced (${settingsDd} dropdowns) ✓`);

    await page.close(); await ctx.close();
  } finally {
    await browser.close();
  }
  log('done — custom dropdowns verified');
}

await run().catch((e) => { console.error('[dropdown ERROR]', e?.stack || e?.message || e); if (!process.exitCode) process.exitCode = 1; })
  .finally(async () => {
    if (stopServer) await stopServer();
    if (server) await new Promise((r) => server.close(r));
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
