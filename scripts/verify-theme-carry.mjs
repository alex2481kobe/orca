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
// appendThemeParam builds the right URL from the stored pref.
{
  const ctx = await b.newContext({ colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  results.appendParam = await p.evaluate(async () => {
    const theme = await import('./ui/theme.js');
    theme.setThemePref('dark');
    return {
      dark: theme.appendThemeParam('http://mac.tailnet.ts.net'),
      systemDropsParam: (theme.setThemePref('system'), theme.appendThemeParam('http://mac.tailnet.ts.net')),
    };
  });
  await ctx.close();
}

console.log('[verify] theme-carry:', JSON.stringify(results, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
