// Regression guard for the remote "change workstation from Settings" feature.
//
// A paired REMOTE device (phone/laptop on the tailnet) used to have no way to
// switch workstations without closing the app — the only workstation switcher
// lived on the pre-pairing gate. This verifies that a connected+paired remote
// sees a "Workstation" connection panel in Settings (switcher + connect input),
// and that the workstation-only host-management panels stay hidden on remote.
//
// "Remote" is simulated with localtest.me (resolves to 127.0.0.1 but is a
// non-localhost hostname, so isWorkstation() is false). Server runs from a temp
// cwd so it never touches the real .orca state.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-remote-ws-')));
process.env.PORT = '0';
process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
process.env.ORCA_RATE_LIMIT_DISABLED = 'true';

const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const base = `http://workstation.localtest.me:${port}`;
const other = 'http://other-mac.example-tailnet.ts.net';

const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();

// Land on the remote origin and seed known workstations (current origin + one
// other) so the switcher has both a "Connected" row and a "Switch" target.
await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
await p.evaluate(({ self, other }) => {
  localStorage.setItem('orca.workstations', JSON.stringify([self, other]));
}, { self: base, other });

// Pair this browser session (same origin → cookie sticks).
const pairStatus = await p.evaluate(async () => {
  const mk = await (await fetch('/api/auth/pairing-codes', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'dashboard', label: 'remote-ws-test' }),
  })).json();
  const r = await fetch('/api/auth/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'dashboard', code: mk.pairing.code, label: 'remote laptop', deviceId: 'remote-ws-dev' }),
  });
  return r.status;
});

// Reload into Settings as an authed remote.
await p.goto(base + '/#system', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

const res = await p.evaluate(() => {
  const conn = document.querySelector('[data-panel-key="connection"]');
  // Scope the workstation-only checks to the Settings grid — the sidebar pairing
  // header is hidden (attribute) on remote but still contributes to body text.
  const grid = document.querySelector('.home-panels');
  const gridText = grid ? grid.textContent || '' : '';
  return {
    isWorkstationFalse: !(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'),
    connectionPanelShown: Boolean(conn),
    hasSwitcher: Boolean(conn && conn.querySelector('.ws-switcher')),
    hasConnectedRow: Boolean(conn && conn.querySelector('.ws-row.is-active .ws-tag')),
    hasSwitchTarget: Boolean(conn && conn.querySelector('.ws-row:not(.is-active) [data-action="connectWorkstation"]')),
    hasConnectButton: Boolean(conn && conn.querySelector('[data-action="connectWorkstation"]')),
    hasUrlInput: Boolean(document.querySelector('#workstation-url-input')),
    connectionPanelPainted: (() => { const c = document.querySelector('[data-panel-key="connection"]'); return Boolean(c) && getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0; })(),
    // Workstation-only Settings panels must NOT appear on a remote:
    pairPanelHidden: !gridText.includes('one-time pairing code'),
    cliHealthHidden: !gridText.includes('CLI health'),
  };
});

const artifactDir = path.resolve(repoDir, 'artifacts', 'remote-workstation');
await fs.mkdir(artifactDir, { recursive: true }).catch(() => {});
const shot = path.join(artifactDir, 'remote-settings-connection.png');
await p.screenshot({ path: shot, fullPage: true }).catch(() => {});

const result = {
  pairStatus,
  ...res,
  screenshot: shot,
};
result.pass = pairStatus === 200
  && result.connectionPanelShown
  && result.connectionPanelPainted
  && result.hasSwitcher
  && result.hasConnectedRow
  && result.hasSwitchTarget
  && result.hasUrlInput
  && result.pairPanelHidden
  && result.cliHealthHidden;

console.log('[verify] remote-workstation-settings:', JSON.stringify(result, null, 2));
await b.close();
if (sm.stopServer) await sm.stopServer();
await new Promise((r) => s.close(r));
if (!result.pass) process.exitCode = 1;
