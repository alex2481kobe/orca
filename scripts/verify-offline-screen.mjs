// Verify the server-down / reconnecting takeover renders in the CURRENT design
// (never a legacy shell), and clears itself when the daemon answers again.
//   - Workstation (loopback host): "Start Orca" + start command + spinner.
//   - Remote (non-loopback host):  "Waiting for your workstation" (no command).
//   - When /api/overview starts answering again, the takeover is removed.
// Isolated .orca state; a fake remote hostname maps to 127.0.0.1 via Chromium.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
// A token is configured so the fake remote host is served as a real remote client
// (matching verify-connect-flow); loopback still loads the static document. The
// fake tailnet host is allowlisted past the anti-DNS-rebinding Host gate (a real
// tailnet hostname would be a recognized serve host).
process.env.ORCA_API_TOKEN = 'verify-token';
process.env.ORCA_ALLOWED_HOSTS = 'remote.test';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP remote.test 127.0.0.1'] });
const results = {};
let failed = false;
const check = (name, cond) => { results[name] = cond; if (!cond) { failed = true; console.error(`  FAIL ${name}`); } };

// ---- Workstation (loopback): server down -> "Start Orca" takeover ----
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  // Make the overview poll fail from the first load => the daemon looks down.
  await p.route('**/api/overview', (route) => route.abort());
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600); // let at least one 2s poll fire
  const ws = await p.evaluate(() => ({
    offlineShown: Boolean(document.querySelector('.connect-offline')),
    bodyOffline: document.body.classList.contains('app-offline'),
    title: document.querySelector('.connect-offline .connect-title')?.textContent || '',
    hasSpinner: Boolean(document.querySelector('.connect-offline .app-loading-spinner')),
    hasStartCmd: Boolean(document.querySelector('.connect-offline .connect-cmd')),
    // The legacy shell must NOT be present.
    noLegacy: !document.querySelector('.home-hero-title, .ios-promo, .appstore-badge, #alerts'),
  }));
  check('workstation.offlineShown', ws.offlineShown);
  check('workstation.bodyOfflineClass', ws.bodyOffline);
  check('workstation.titleStartOrca', ws.title.trim() === 'Start Orca');
  check('workstation.spinner', ws.hasSpinner);
  check('workstation.startCommand', ws.hasStartCmd);
  check('workstation.noLegacyShell', ws.noLegacy);
  await p.screenshot({ path: path.join(outDir, 'offline-workstation.png') });

  // Now let the daemon "come back": stop aborting, the poll should clear it.
  await p.unroute('**/api/overview');
  await p.waitForTimeout(2600);
  const recovered = await p.evaluate(() => ({
    offlineGone: !document.querySelector('.connect-offline'),
    bodyClean: !document.body.classList.contains('app-offline'),
  }));
  check('workstation.reconnectClears', recovered.offlineGone && recovered.bodyClean);
  await ctx.close();
}

// ---- Remote (non-loopback host): "Waiting for your workstation", no command ----
{
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.route('**/api/overview', (route) => route.abort());
  await p.goto(`http://remote.test:${port}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);
  const rm = await p.evaluate(() => ({
    offlineShown: Boolean(document.querySelector('.connect-offline')),
    title: document.querySelector('.connect-offline .connect-title')?.textContent || '',
    noCmd: !document.querySelector('.connect-offline .connect-cmd'),
  }));
  check('remote.offlineShown', rm.offlineShown);
  check('remote.titleWaiting', rm.title.trim() === 'Waiting for your workstation');
  check('remote.noStartCommand', rm.noCmd);
  await p.screenshot({ path: path.join(outDir, 'offline-remote.png') });
  await ctx.close();
}

// ---- Light theme: the workstation offline takeover renders in the CURRENT
// design under light mode too (no legacy shell, tokens resolve in light). ----
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  await ctx.addInitScript(() => { try { localStorage.setItem('orca.theme', 'light'); } catch { /* */ } });
  const p = await ctx.newPage();
  await p.route('**/api/overview', (route) => route.abort());
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);
  const light = await p.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    offlineShown: Boolean(document.querySelector('.connect-offline')),
    title: document.querySelector('.connect-offline .connect-title')?.textContent || '',
    hasStartCmd: Boolean(document.querySelector('.connect-offline .connect-cmd')),
    noLegacy: !document.querySelector('.home-hero-title, .ios-promo, .appstore-badge, #alerts'),
  }));
  check('light.themeIsLight', light.theme === 'light');
  check('light.offlineShown', light.offlineShown);
  check('light.titleStartOrca', light.title.trim() === 'Start Orca');
  check('light.startCommand', light.hasStartCmd);
  check('light.noLegacyShell', light.noLegacy);
  await p.screenshot({ path: path.join(outDir, 'offline-workstation-light.png') });
  await ctx.close();
}

console.log('[verify] offline-screen:', JSON.stringify(results, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] offline-screen FAILED'); process.exit(1); }
console.log('[verify] offline-screen OK');
