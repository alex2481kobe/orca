// Screenshot the desktop Pair panel with a mocked tailnet-ready state, to verify
// the URL row + Copy button + QR + caption layout. Not part of the smoke suite.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolate .orca state: AuthSessionStore persists to <cwd>/.orca, so pairing here
// from the project dir would inject phantom "v" devices into the REAL state file.
// chdir to a throwaway dir before importing the server; keep outputs under the
// original cwd.
const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));

process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1'; process.env.ORCA_API_TOKEN = 'verify-token';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;
const token = process.env.ORCA_API_TOKEN;
const pc = await fetch(base + '/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-orca-token': token }, body: JSON.stringify({ actor: 'verify', label: 'v', ttlMs: 60000 }) }).then((r) => r.json());
const pr = await fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pc.pairing.code, label: 'v' }) });
const setCookie = pr.headers.get('set-cookie') || '';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1000, height: 820 }, colorScheme: 'light' });
if (setCookie) { const [cp] = setCookie.split(';'); const [n, ...v] = cp.split('='); await ctx.addCookies([{ name: n.trim(), value: v.join('=').trim(), url: base, httpOnly: true, sameSite: 'Lax' }]); }
const p = await ctx.newPage();
await p.goto(base, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
// Inject a tailnet-ready state and re-render the Pair panel.
await p.evaluate(() => {
  window.location.hash = '#pair';
  // shell + render are module-internal; reach them via the bound dispatcher by
  // forcing a re-render through a hashchange after stubbing privateAccess.
});
// Render with injected state and READ synchronously in the same step so the
// ~500ms poll can't overwrite shell.privateAccess before we inspect.
const renderAndRead = (tailnet) => p.evaluate(async (tn) => {
  const mod = await import('./ui/state.js');
  const views = await import('./ui/render-views.js');
  mod.shell.privateAccess = { settings: { preferredMode: 'tailnet-http' }, targets: [], tailnet: tn };
  window.location.hash = '#pair';
  views.render();
  const panel = document.querySelector('#section-pair');
  return {
    hasQr: Boolean(panel?.querySelector('.qr-wrap')),
    hasUrl: Boolean(panel?.querySelector('.copy-url')),
    hasCreateCode: Boolean(panel?.querySelector('[data-action="createPairingCode"]')),
    mentionsSetup: /Set up Tailscale first/i.test(panel?.textContent || ''),
  };
}, tailnet);
// Tailscale NOT connected: must show setup steps, hide URL/QR and pairing steps.
const notReady = await renderAndRead({ binaryAvailable: false, loggedIn: false });
console.log('[verify] pairpanel-noTailscale:', JSON.stringify(notReady));
await p.screenshot({ path: path.resolve('artifacts/verify', 'desktop-pairpanel-noTailscale.png') });
// Tailscale connected: URL + QR + steps.
await renderAndRead({ binaryAvailable: true, loggedIn: true, servedUrl: 'http://alexs-mac-mini.tailf87abc.ts.net' });
const ok = await p.evaluate(() => Boolean(document.querySelector('.qr-wrap')));
await p.waitForTimeout(300);
const measures = await p.evaluate(() => {
  const code = document.querySelector('.url-row .copy-url')?.getBoundingClientRect();
  const btn = document.querySelector('.url-row .btn')?.getBoundingClientRect();
  const qr = document.querySelector('.qr-wrap')?.getBoundingClientRect();
  const cap = document.querySelector('.qr-wrap span')?.getBoundingClientRect();
  return {
    hasQr: Boolean(qr), qrWidth: qr ? Math.round(qr.width) : null,
    captionWidth: cap ? Math.round(cap.width) : null,
    // Copy button should be on the SAME row as the URL (to its right), not wrapped below.
    copyRightOfUrl: code && btn ? (btn.left >= code.right - 2 && Math.abs(btn.top - code.top) < 20) : null,
    urlWidth: code ? Math.round(code.width) : null,
  };
});
const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
await p.screenshot({ path: path.join(outDir, 'desktop-pairpanel.png') });
console.log('[verify] pairpanel:', JSON.stringify({ rendered: ok, ...measures }));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
