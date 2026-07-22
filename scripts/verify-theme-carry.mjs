// Verify the theme carries across an origin navigation so a dark-mode client does
// not flash white when it reaches the workstation origin. Simulates a LIGHT device
// (colorScheme: 'light') — without the carry, the new origin would default to
// light. With ?orca_theme=dark it must paint dark, strip the param, and persist.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;
const b = await chromium.launch();
const results = {};

// Device in LIGHT mode; arrive at the workstation with the dark theme carried.
{
  const ctx = await b.newContext({ colorScheme: 'light' });
  const p = await ctx.newPage();
  await p.goto(base + '/?orca_theme=dark', { waitUntil: 'domcontentloaded' });
  results.carriedDark = await p.evaluate(() => ({
    dataTheme: document.documentElement.getAttribute('data-theme'),
    urlHasParam: window.location.search.includes('orca_theme'),
    stored: localStorage.getItem('orca.theme'),
  }));
  await ctx.close();
}
// Control: same light device WITHOUT the carry → light (the old white-flash case).
{
  const ctx = await b.newContext({ colorScheme: 'light' });
  const p = await ctx.newPage();
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  results.noCarryLight = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await ctx.close();
}
// A dark device WITH the carry param stays dark (control that the carry doesn't
// only work for light→dark). The former block 3 exercised ui/theme.js's
// appendThemeParam/setThemePref, but that module was removed in the v2 refactor
// (the ?orca_theme= carry is handled inline in index.html now), so it's dropped.
{
  const ctx = await b.newContext({ colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.goto(base + '/?orca_theme=dark', { waitUntil: 'domcontentloaded' });
  results.darkDeviceCarriedDark = await p.evaluate(() => ({
    dataTheme: document.documentElement.getAttribute('data-theme'),
    urlHasParam: window.location.search.includes('orca_theme'),
    stored: localStorage.getItem('orca.theme'),
  }));
  await ctx.close();
}

let failed = false;
const check = (name, cond) => { if (!cond) { failed = true; console.error(`  FAIL ${name}`); } };
check('carriedDark.dataTheme', results.carriedDark.dataTheme === 'dark');
check('carriedDark.paramStripped', results.carriedDark.urlHasParam === false);
check('carriedDark.persisted', results.carriedDark.stored === 'dark');
check('noCarryLight.light', results.noCarryLight === 'light');
check('darkDeviceCarriedDark.dataTheme', results.darkDeviceCarriedDark.dataTheme === 'dark');
check('darkDeviceCarriedDark.paramStripped', results.darkDeviceCarriedDark.urlHasParam === false);

console.log('[verify] theme-carry:', JSON.stringify(results, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] theme-carry FAILED'); process.exit(1); }
console.log('[verify] theme-carry OK');
