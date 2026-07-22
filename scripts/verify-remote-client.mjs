// Verify the remote-client "Remote devices" screen (a paired phone / browser away
// from the workstation), which replaces the workstation-only pair panel with:
//   - "This device" + an Unlink button that self-logs-out WITHOUT a sessionId
//     (so it doesn't hit the admin gate — the reported 403 self-unlink bug),
//   - "Connect to another workstation" (URL field + remembered-workstation switcher).
// A fake tailnet host maps to 127.0.0.1 (allowlisted past anti-rebinding).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
process.env.ORCA_API_TOKEN = 'verify-token';
process.env.ORCA_ALLOWED_HOSTS = 'remote.test';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP remote.test 127.0.0.1'] });
const results = {};
let failed = false;
const check = (name, cond) => { results[name] = cond; if (!cond) { failed = true; console.error(`  FAIL ${name}`); } };

// Admin (token) mints a one-time pairing code.
const codeResp = await fetch(`${base}/api/auth/pairing-codes`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orca-token': 'verify-token' },
  body: JSON.stringify({ actor: 'test', label: 'phone' }),
}).then((r) => r.json());
const code = codeResp?.pairing?.code;
check('setup.gotPairingCode', Boolean(code));

const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
// Seed a SECOND known workstation so the switcher list has a row.
await ctx.addInitScript(() => {
  localStorage.setItem('orca.workstations', JSON.stringify(['http://other-mac.tailnet.ts.net:3000']));
});
const p = await ctx.newPage();
await p.goto(`http://remote.test:${port}/`, { waitUntil: 'domcontentloaded' });
// Pair this device from the page context so the cookie lands on the remote origin.
const paired = await p.evaluate(async (c) => {
  const r = await fetch('/api/auth/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: c, label: 'Alex iPhone', deviceId: 'phone-xyz' }),
  });
  return r.ok;
}, code);
check('setup.paired', paired);

// Reload so the paired cookie takes effect, then open Remote devices via the hash
// (a hash change, not a navigation — the 2s poll means 'networkidle' never settles).
await p.goto(`http://remote.test:${port}/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(600);
await p.evaluate(() => { window.location.hash = '#remote'; });
await p.waitForTimeout(700);
const rc = await p.evaluate(() => ({
  thisDevice: Boolean([...document.querySelectorAll('#remote-body h3')].find((h) => h.textContent.includes('This device'))),
  unlinkBtn: Boolean(document.querySelector('[data-action="unlinkThisDevice"]')),
  connectHeading: Boolean([...document.querySelectorAll('#remote-body h3')].find((h) => h.textContent.includes('Connect to another workstation'))),
  urlInput: Boolean(document.querySelector('#workstation-url-input')),
  switcherRows: document.querySelectorAll('.ws-switcher .ws-row').length,
  switcherLabel: document.querySelector('.ws-switcher .ws-go span')?.textContent || '',
  // The workstation-only admin pair panel must NOT be shown to a remote client.
  noPairPanel: !document.querySelector('.pair-panel'),
}));
check('remote.thisDeviceCard', rc.thisDevice);
check('remote.unlinkButton', rc.unlinkBtn);
check('remote.connectHeading', rc.connectHeading);
check('remote.urlInput', rc.urlInput);
check('remote.switcherHasRow', rc.switcherRows === 1);
check('remote.switcherLabelHost', rc.switcherLabel === 'other-mac.tailnet.ts.net:3000');
check('remote.noAdminPairPanel', rc.noPairPanel);
await p.screenshot({ path: path.join(outDir, 'remote-client.png') });

// Sidebar nav on a remote client (mobile drawer) must actually navigate — clicking
// Settings / Remote devices must render those screens, not just collapse the drawer
// back to home (the symptom of the OLD cached UI, which rendered empty on remote).
await p.evaluate(() => document.body.classList.add('nav-open'));
await p.click('[data-nav="settings"]');
await p.waitForTimeout(400);
const navSettings = await p.evaluate(() => ({
  hash: location.hash,
  topbar: document.getElementById('topbar-title')?.textContent || '',
  hasAppearance: Boolean(document.querySelector('[data-action="setTheme"]')),
  drawerClosed: !document.body.classList.contains('nav-open'),
}));
check('nav.settings.route', navSettings.hash === '#settings');
check('nav.settings.rendersAppearance', navSettings.hasAppearance);
check('nav.settings.topbar', navSettings.topbar === 'Settings');
check('nav.settings.drawerClosed', navSettings.drawerClosed);

await p.evaluate(() => document.body.classList.add('nav-open'));
await p.click('[data-nav="remote"]');
await p.waitForTimeout(400);
const navRemote = await p.evaluate(() => ({
  hash: location.hash,
  topbar: document.getElementById('topbar-title')?.textContent || '',
  hasRemoteBody: Boolean(document.getElementById('remote-body')),
}));
check('nav.remote.route', navRemote.hash === '#remote');
check('nav.remote.rendersRemoteBody', navRemote.hasRemoteBody);
check('nav.remote.topbar', navRemote.topbar === 'Remote devices');

// Unlink must POST /api/auth/logout with NO sessionId (own-cookie logout).
let logoutBody = null;
await p.route('**/api/auth/logout', async (route) => {
  try { logoutBody = JSON.parse(route.request().postData() || '{}'); } catch { logoutBody = {}; }
  route.continue();
});
await p.click('[data-action="unlinkThisDevice"]');
await p.waitForTimeout(800);
check('unlink.calledLogout', logoutBody !== null);
check('unlink.noSessionId', logoutBody !== null && logoutBody.sessionId === undefined);
// After unlink the cookie is cleared → next poll 401s → pair gate takes over.
const afterUnlink = await p.evaluate(() => Boolean(document.querySelector('.connect-gate')));
check('unlink.showsGate', afterUnlink);

console.log('[verify] remote-client:', JSON.stringify(results, null, 2));
await ctx.close();
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] remote-client FAILED'); process.exit(1); }
console.log('[verify] remote-client OK');
