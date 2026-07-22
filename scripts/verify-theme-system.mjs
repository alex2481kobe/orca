// Verify that with Appearance = "System", the app follows LIVE OS theme changes
// (the reported mobile bug: flip the phone to dark, the app stays light). Uses
// Playwright emulateMedia to change prefers-color-scheme after load and asserts
// document data-theme updates — and that an explicit Light/Dark pref does NOT follow
// the OS. Loopback bootstrap-admin; isolated .orca state. Engine is picked by
// VERIFY_ENGINE (default chromium; webkit runs the same proof under iOS Safari's
// engine — no remote host needed, this test only uses 127.0.0.1).
import { launchBrowser } from './lib/verify-browser.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const b = await launchBrowser();
const results = {};
let failed = false;
const check = (n, c) => { results[n] = c; if (!c) { failed = true; console.error(`  FAIL ${n}`); } };
const theme = (p) => p.evaluate(() => document.documentElement.getAttribute('data-theme'));

// System appearance (no saved pref) follows the OS, live.
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(700);
  check('system.startsLight', (await theme(p)) === 'light');
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.waitForTimeout(300);
  check('system.followsToDark', (await theme(p)) === 'dark'); // the fix
  await p.emulateMedia({ colorScheme: 'light' });
  await p.waitForTimeout(300);
  check('system.followsBackToLight', (await theme(p)) === 'light');
  await p.screenshot({ path: path.join(outDir, 'theme-system.png') });
  await ctx.close();
}

// An explicit Light pref must NOT follow the OS flipping to dark.
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await ctx.addInitScript(() => { try { localStorage.setItem('orca.theme', 'light'); } catch { /* */ } });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(700);
  check('explicitLight.staysLightOnDarkOS', (await theme(p)) === 'light');
  await ctx.close();
}

console.log('[verify] theme-system:', JSON.stringify(results, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] theme-system FAILED'); process.exit(1); }
console.log('[verify] theme-system OK');
