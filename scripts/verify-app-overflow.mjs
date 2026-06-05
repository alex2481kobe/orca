// Find vertical overflow on the native-app (data-native => --vph:100vh) connect
// and "Welcome to Orca" screens — there should be no scroll when content fits.
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
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const b = await chromium.launch();
const measure = async (label, urlPath, init) => {
  const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 } });
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  await p.goto(base + urlPath, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  const r = await p.evaluate(() => {
    const de = document.documentElement;
    const overflow = de.scrollHeight - de.clientHeight;
    const tallest = [];
    document.querySelectorAll('body *').forEach((el) => {
      const h = el.getBoundingClientRect().height;
      if (h > de.clientHeight + 0.5) tallest.push({ cls: (el.className || el.tagName).toString().slice(0, 36), h: Math.round(h) });
    });
    return { vh: de.clientHeight, scrollHeight: de.scrollHeight, overflowPx: overflow, tooTall: tallest.slice(0, 6) };
  });
  await ctx.close();
  return { label, ...r };
};

// Connect screen: native app, unconnected (fake __TAURI__ at localhost origin).
const connect = await measure('connect', '/', () => { window.__TAURI__ = {}; });
// Welcome/home: native app flag via ?orca_app=1 (no projects -> "Welcome to Orca").
const welcome = await measure('welcome-home', '/?orca_app=1', null);

console.log('[verify] app-overflow:', JSON.stringify({ connect, welcome }, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
