// Verify the REAL mobile touch nav on a paired remote client: open the drawer via
// the floating reopen control (there is no topbar on mobile), then TAP "Remote
// devices" and "Settings" — each must route + render, not collapse back to home.
// Also asserts the drawer's left content clears the edge (the left-cutoff fix).
// Uses a real touch context (hasTouch/isMobile + page.tap), unlike a forced-open
// click test. Fake tailnet host maps to 127.0.0.1 (allowlisted past anti-rebinding).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
process.env.ORCA_API_TOKEN = 'verify-token'; process.env.ORCA_ALLOWED_HOSTS = 'remote.test';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;
const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP remote.test 127.0.0.1'] });
const results = {};
let failed = false;
const check = (n, c) => { results[n] = c; if (!c) { failed = true; console.error(`  FAIL ${n}`); } };

const code = (await (await fetch(`${base}/api/auth/pairing-codes`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orca-token': 'verify-token' },
  body: JSON.stringify({ actor: 'test', label: 'phone' }),
})).json())?.pairing?.code;
check('setup.code', Boolean(code));

const ctx = await b.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
await p.goto(`http://remote.test:${port}/`, { waitUntil: 'domcontentloaded' });
await p.evaluate(async (c) => { await fetch('/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c, label: 'iPhone' }) }); }, code);
await p.goto(`http://remote.test:${port}/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(900);

// The drawer opener on mobile (topbar is hidden → the floating reopen control).
const opener = await p.evaluate(() => {
  const vis = (el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  if (vis(document.getElementById('nav-toggle'))) return '#nav-toggle';
  if (vis(document.getElementById('sidebar-reopen'))) return '#sidebar-reopen';
  return null;
});
check('drawer.hasOpener', Boolean(opener));

async function openDrawerAndTap(navSel) {
  await p.tap(opener);
  await p.waitForTimeout(400);
  await p.tap(navSel, { timeout: 5000 });
  await p.waitForTimeout(500);
}

// Remote devices
await openDrawerAndTap('[data-nav="remote"]');
const remote = await p.evaluate(() => ({
  hash: location.hash, topbar: document.getElementById('topbar-title')?.textContent || '',
  body: Boolean(document.getElementById('remote-body')), navOpen: document.body.classList.contains('nav-open'),
}));
check('remote.route', remote.hash === '#remote');
check('remote.rendered', remote.body && remote.topbar === 'Remote devices');
check('remote.drawerClosed', !remote.navOpen);

// Settings
await openDrawerAndTap('[data-nav="settings"]');
const settings = await p.evaluate(() => ({
  hash: location.hash, topbar: document.getElementById('topbar-title')?.textContent || '',
  appearance: Boolean(document.querySelector('[data-action="setTheme"]')),
}));
check('settings.route', settings.hash === '#settings');
check('settings.rendered', settings.appearance && settings.topbar === 'Settings');

// Left-cutoff fix: with the drawer open, the first nav item clears the edge.
await p.tap(opener);
await p.waitForTimeout(400);
const leftEdge = await p.evaluate(() => {
  const el = document.querySelector('.sidebar-pair-button, [data-nav="remote"]');
  return el ? Math.round(el.getBoundingClientRect().x) : -999;
});
check('drawer.leftClearsEdge', leftEdge >= 15);
await p.screenshot({ path: path.join(outDir, 'mobile-nav.png') });

console.log('[verify] mobile-nav:', JSON.stringify({ ...results, _leftEdge: leftEdge }, null, 2));
await ctx.close();
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] mobile-nav FAILED'); process.exit(1); }
console.log('[verify] mobile-nav OK');
