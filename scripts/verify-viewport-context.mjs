// Verify the viewport-height consolidation: the native app / installed PWA resolve
// --vph to 100vh (full screen, no phantom-toolbar bottom gap), while a plain mobile
// browser keeps 100dvh. Also checks the orca_app=1 flag is honored + persisted +
// stripped, and that the App Store promo is suppressed in the native app.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
process.env.ORCA_API_TOKEN = 'verify-token';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP remote.test 127.0.0.1'] });
const results = {};

const readVph = (p) => p.evaluate(() => {
  const root = document.documentElement;
  const vph = getComputedStyle(root).getPropertyValue('--vph').trim();
  return {
    dataNative: root.getAttribute('data-native'),
    dataStandalone: root.getAttribute('data-standalone'),
    vph,
    bodyNativeClass: document.body.classList.contains('is-native-app'),
    urlHasOrcaApp: window.location.search.includes('orca_app'),
    storedNative: (() => { try { return localStorage.getItem('orca.nativeApp'); } catch { return null; } })(),
    promoShown: Boolean(document.querySelector('.ios-promo')),
  };
});

// 1) Plain mobile browser → --vph stays 100dvh, no data-native.
{
  const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(`http://remote.test:${port}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  results.mobileBrowser = await readVph(p);
  await ctx.close();
}

// 2) Native app reaching the workstation origin via orca_app=1 → --vph = 100vh,
//    flag persisted + stripped, promo suppressed.
{
  const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(`http://remote.test:${port}/?orca_app=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  results.nativeAppArriving = await readVph(p);
  // Reload WITHOUT the param — persisted flag should keep it native.
  await p.goto(`http://remote.test:${port}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  results.nativeAppPersisted = await readVph(p);
  await ctx.close();
}

// 3) Installed PWA (standalone display-mode) → --vph = 100vh via data-standalone.
{
  const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    // Force the standalone match the way an installed PWA reports it.
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (q) => (q.includes('display-mode: standalone') ? { matches: true, media: q, addEventListener() {}, addListener() {} } : orig(q));
  });
  const p = await ctx.newPage();
  await p.goto(`http://remote.test:${port}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  results.installedPwa = await readVph(p);
  await ctx.close();
}

console.log('[verify] viewport-context:', JSON.stringify(results, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
