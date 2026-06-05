// End-to-end: on the workstation, create a pairing code, then have a "phone" pair
// with it (via the API, like a remote device would). The workstation poll must
// then (1) flash "Device paired" in place of the code, and (2) show the new device
// in Paired devices. Proves the pair → workstation-reacts flow on one server.
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

const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1100, height: 880 }, colorScheme: 'dark' });
const p = await ctx.newPage();
await p.goto(base + '/#pair', { waitUntil: 'networkidle' });
await p.waitForTimeout(1000);

// Workstation creates a one-time code via the actual button.
await p.evaluate(() => document.querySelector('[data-action="createPairingCode"]').click());
await p.waitForTimeout(600);
const code = await p.evaluate(() => document.querySelector('.pairing-code-value')?.textContent?.trim() || '');

// "Phone" pairs using that code (the remote-device path).
const pairResp = await fetch(base + '/api/auth/pair', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, label: 'Alex iPhone', deviceId: 'phone-abc' }),
}).then((r) => r.json());

// The pair bumps the stream revision → the workstation's live SSE connection
// should refresh within ~0.7s (not the slow poll). Check at ~900ms.
await p.waitForTimeout(900);
const viaPoll = await p.evaluate(async () => {
  const { shell } = await import('./ui/state.js');
  const direct = await fetch('/api/auth/sessions').then((r) => r.json()).catch(() => null);
  return {
    documentHidden: document.hidden,
    visibilityState: document.visibilityState,
    authSessionsLen: Array.isArray(shell.authSessions) ? shell.authSessions.length : null,
    serverSessionsLen: direct ? (direct.sessions || []).length : 'fetch-failed',
    serverPaired: direct ? (direct.sessions || []).filter((s) => s.paired).length : null,
  };
});
console.log('[debug] after ~0.9s (SSE path):', JSON.stringify(viaPoll));
// Brief extra wait so the "Device paired" flash is on screen for the screenshot.
await p.waitForTimeout(700);
const observed = await p.evaluate(() => {
  const accepted = document.querySelector('.pairing-code-box.pairing-accepted');
  document.querySelectorAll('details[data-uikey$="paired-devices"]').forEach((d) => { d.open = true; });
  const rows = Array.from(document.querySelectorAll('.device-row strong')).map((el) => el.textContent.trim());
  const summary = document.querySelector('details[data-uikey="pair-paired-devices"] summary small')?.textContent || '';
  return {
    acceptedFlashShown: Boolean(accepted),
    deviceRowLabels: [...new Set(rows)],
    summaryText: summary,
  };
});
await p.screenshot({ path: path.join(outDir, 'pair-shows-up.png') });

console.log(JSON.stringify({
  pairedOk: pairResp.paired === true,
  ...observed,
  showsDevice: observed.deviceRowLabels.includes('Alex iPhone'),
}, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
