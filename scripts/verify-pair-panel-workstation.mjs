// Verify the WORKSTATION "Pair a device" panel — the admin pairing UI that only
// renders on the loopback host (127.0.0.1), where the server grants bootstrap-admin
// without a token. Covers the pieces that had no working browser proof:
//   - #remote renders the workstation .pair-panel (NOT the remote-client panel),
//   - "Create code" (createPairingCode) mints a live code: .pairing-code-value +
//     a .pairing-countdown that actually ticks down,
//   - the device cards open via toggleDeviceCard,
//   - a paired device shows a .device-row with a .device-revoke, and clicking
//     Revoke removes the row.
// The whole set runs in BOTH dark and light, with a screenshot each. Isolated
// .orca state (temp cwd) so it never touches real auth-sessions.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
const realTemp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.chdir(realTemp);
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
// NO ORCA_API_TOKEN: loopback => bootstrap-admin, so the admin pairing endpoints
// (pairing-codes / pair / sessions / logout) all succeed without a token.
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;
const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const b = await chromium.launch();
const results = {};
let failed = false;
const check = (name, cond) => { results[name] = cond; if (!cond) { failed = true; console.error(`  FAIL ${name}`); } };

// Admin helper: mint a one-time code and pair a device against it (server-side),
// creating a real paired session so a .device-row exists on the panel.
async function pairADevice(label, deviceId) {
  const codeResp = await fetch(`${base}/api/auth/pairing-codes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'test', label }),
  }).then((r) => r.json());
  const code = codeResp?.pairing?.code;
  if (!code) return false;
  const pr = await fetch(`${base}/api/auth/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'test', code, label, deviceId }),
  });
  return pr.ok;
}

async function runPass(scheme) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
  const p = await ctx.newPage();
  // Stub the tailnet status as READY so the "Create code" step renders regardless
  // of whether THIS machine has Tailscale installed/logged-in. The pair panel gates
  // step 2 (create-code) behind tsReady; on CI there is no Tailscale, so without
  // this the button never renders and the click times out (real cross-env bug the
  // clean-CI run caught). Device rows come from /api/auth/sessions, unaffected.
  await p.route('**/api/private-access', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      tailnet: { binaryAvailable: true, loggedIn: true, serveConfigured: true, servedUrl: `${base}/` },
      settings: {}, targets: [], setupPlan: { commands: [] },
    }),
  }));
  await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600); // let a poll fire (home renders)
  // Navigate to Remote via a hash change (NOT goto#hash — the 2s poll means
  // 'networkidle' never settles).
  await p.evaluate(() => { window.location.hash = '#remote'; });
  await p.waitForTimeout(700);

  // The WORKSTATION pair panel must render on loopback (not the remote-client panel).
  const panel = await p.evaluate(() => ({
    hasPairPanel: Boolean(document.querySelector('.pair-panel')),
    noRemoteClient: !document.querySelector('[data-action="unlinkThisDevice"]'),
    topbar: document.getElementById('topbar-title')?.textContent || '',
  }));
  check(`${scheme}.pairPanelRenders`, panel.hasPairPanel);
  check(`${scheme}.notRemoteClient`, panel.noRemoteClient);
  check(`${scheme}.topbar`, panel.topbar === 'Remote devices');

  // Create a one-time code from the panel button → live code + ticking countdown.
  await p.click('[data-action="createPairingCode"]');
  await p.waitForTimeout(500);
  const code1 = await p.evaluate(() => ({
    value: document.querySelector('.pairing-code-value')?.textContent || '',
    countdown: document.querySelector('.pairing-countdown')?.textContent || '',
    hasCountdownEl: Boolean(document.querySelector('.pairing-countdown[data-expires]')),
  }));
  check(`${scheme}.codeValueRenders`, code1.value.trim().length > 0);
  check(`${scheme}.countdownPresent`, code1.hasCountdownEl);
  check(`${scheme}.countdownInitialized`, /expires in \d/.test(code1.countdown));
  // ...and it ticks: the M:SS text changes after ~1.3s.
  await p.waitForTimeout(1300);
  const countdown2 = await p.evaluate(() => document.querySelector('.pairing-countdown')?.textContent || '');
  check(`${scheme}.countdownTicks`, countdown2 !== code1.countdown && /expires in \d/.test(countdown2));

  // Pair a real device (server-side), let the 2s remote poll pick up the new
  // session, then open the "Paired devices" card so the .device-row shows.
  const paired = await pairADevice(`Verify ${scheme} phone`, `verify-${scheme}-phone`);
  check(`${scheme}.devicePairedApi`, paired);
  await p.waitForTimeout(2400); // remote-route poll refreshes remoteAuthSessions
  await p.click('[data-action="toggleDeviceCard"][data-card="devices"]');
  await p.waitForTimeout(300);
  const before = await p.evaluate(() => ({
    rows: document.querySelectorAll('.device-row').length,
    hasRevoke: Boolean(document.querySelector('.device-row .device-revoke')),
  }));
  check(`${scheme}.deviceRowShows`, before.rows >= 1);
  check(`${scheme}.revokeButtonPresent`, before.hasRevoke);
  await p.screenshot({ path: path.join(outDir, `pair-panel-workstation-${scheme}.png`) });

  // Revoke removes the row (logout with sessionId → refreshRemote drops it).
  await p.click('.device-row .device-revoke');
  await p.waitForTimeout(1000);
  const afterRows = await p.evaluate(() => document.querySelectorAll('.device-row').length);
  check(`${scheme}.revokeRemovesRow`, afterRows === before.rows - 1);

  await ctx.close();
}

await runPass('dark');
await runPass('light');

console.log('[verify] pair-panel-workstation:', JSON.stringify(results, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] pair-panel-workstation FAILED'); process.exit(1); }
console.log('[verify] pair-panel-workstation OK');
