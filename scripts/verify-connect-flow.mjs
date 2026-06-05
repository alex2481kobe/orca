// Verify the remote-client connect/pair UX redesign:
//   - http/HTTP (case-only) duplicates collapse to ONE workstation entry.
//   - Unconnected mobile app → connect screen with the deduped switcher.
//   - Remote phone browser (non-localhost origin) → pair gate showing step 1
//     "Connected to <host>" DONE + step 2 pairing code, with a switch list of
//     OTHER workstations (active one excluded; shown checkmarked in the step).
//   - forgetWorkstation removes a row.
// Isolated .orca state. A fake remote hostname is mapped to 127.0.0.1 via
// Chromium host-resolver-rules so we get a non-localhost origin with no real DNS.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
// A token is configured so the unauthenticated remote browser is BLOCKED (→ pair
// gate), matching a real remote device with no credentials. Without it, the fake
// host maps to a loopback socket and the server would grant bootstrap-admin.
process.env.ORCA_API_TOKEN = 'verify-token';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP remote.test 127.0.0.1, MAP other.test 127.0.0.1'] });
const results = {};

// ---- Screen A: unconnected mobile app → connect screen + dedup ----
{
  const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  // Fake the installed app (Tauri) and seed recents with a case-only duplicate.
  await ctx.addInitScript(() => {
    window.__TAURI__ = {};
    localStorage.setItem('orca.workstations', JSON.stringify([
      'http://mac.tailnet.ts.net', 'HTTP://mac.tailnet.ts.net', 'http://other-mac.ts.net',
    ]));
  });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  results.connectScreen = await p.evaluate(async () => {
    const ws = await import('./ui/workstations.js');
    const dom = await import('./ui/dom.js');
    return {
      isConnectScreen: Boolean(document.querySelector('.connect-shell .connect-title')),
      title: document.querySelector('.connect-title')?.textContent || '',
      rowCount: document.querySelectorAll('.ws-row').length,
      readWorkstationsLen: ws.readWorkstations().length, // dedup at the source
      normalizedSame: ws.normalizeWorkstationUrl('HTTP://Mac.Tailnet.TS.net/') === ws.normalizeWorkstationUrl('http://mac.tailnet.ts.net'),
      // The native app is already installed → no "add to Home Screen" hint.
      homeHintInApp: dom.installToHomeHint(),
    };
  });
  await p.screenshot({ path: path.join(outDir, 'connect-screen-app.png') });
  // Disconnected settings (workstation switcher reachable while unpaired).
  await p.evaluate(() => { window.location.hash = '#system'; });
  await p.waitForTimeout(400);
  results.disconnectedSettings = await p.evaluate(() => ({
    hasAppearance: Boolean(document.querySelector('[data-action="setTheme"]')),
    hasSwitcher: Boolean(document.querySelector('.ws-switcher')),
    hasUrlInput: Boolean(document.querySelector('#workstation-url-input')),
  }));
  await p.screenshot({ path: path.join(outDir, 'connect-settings-app.png') });
  await ctx.close();
}

// ---- Screen B: remote phone browser → pair gate (connected step + switcher) ----
{
  const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await ctx.addInitScript((p) => {
    localStorage.setItem('orca.workstations', JSON.stringify([
      `http://remote.test:${p}`, 'http://other-mac.ts.net', 'HTTP://other-mac.ts.net',
    ]));
  }, port);
  const p = await ctx.newPage();
  await p.goto(`http://remote.test:${port}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  // Open the "wrong workstation?" switch disclosure for the screenshot.
  await p.evaluate(() => { const d = document.querySelector('details[data-uikey="switch-workstation"]'); if (d) d.open = true; });
  await p.waitForTimeout(200);
  results.pairGate = await p.evaluate(async () => {
    const ws = await import('./ui/workstations.js');
    const dom = await import('./ui/dom.js');
    const doneStep = document.querySelector('.connect-step.is-done');
    return {
      isPairGate: Boolean(document.querySelector('.connect-gate')),
      step1Done: Boolean(doneStep),
      step1Host: doneStep?.querySelector('.connect-step-host')?.textContent || '',
      hasCodeInput: Boolean(document.querySelector('#pairing-code-input')),
      activeUrl: ws.activeWorkstationUrl(),
      switchRows: document.querySelectorAll('.connect-gate .ws-row').length,
      // Mobile WEB browser (not the app) → DOES get a home-screen hint.
      homeHintMobileWeb: dom.installToHomeHint(),
    };
  });
  await p.screenshot({ path: path.join(outDir, 'pair-gate-remote.png') });

  // forgetWorkstation removes a row.
  const beforeForget = await p.evaluate(() => document.querySelectorAll('.connect-gate .ws-row').length);
  await p.evaluate(() => { const f = document.querySelector('.connect-gate .ws-forget'); if (f) f.click(); });
  await p.waitForTimeout(300);
  await p.evaluate(() => { const d = document.querySelector('details[data-uikey="switch-workstation"]'); if (d) d.open = true; });
  const afterForget = await p.evaluate(() => document.querySelectorAll('.connect-gate .ws-row').length);
  results.forget = { beforeForget, afterForget, removed: afterForget === beforeForget - 1 };
  await ctx.close();
}

// ---- Screen C: desktop/laptop web browser → NO home-screen hint ----
{
  const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const ctx = await b.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  await p.goto(`http://remote.test:${port}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  results.desktopWeb = await p.evaluate(async () => {
    const dom = await import('./ui/dom.js');
    return { homeHintDesktop: dom.installToHomeHint() }; // expect null
  });
  await ctx.close();
}

console.log('[verify] connect-flow:', JSON.stringify(results, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
