// Verify the remote-device pairing GATE — what an UNPAIRED device (a phone that
// opened the tailnet URL) sees instead of the dashboard. A token is configured so
// the fake remote host `remote.test` (mapped to 127.0.0.1) gets no implicit admin:
// /api/overview 401s and the whole screen is taken over by the .connect-gate.
// Covers:
//   - the gate renders (.connect-gate),
//   - a WRONG code surfaces .connect-error,
//   - the "opens then wipes" no-clobber guard: a half-typed code SURVIVES a 2s
//     poll (the gate only re-renders once, on the transition into blocked),
//   - a VALID code pairs the device and the dashboard replaces the gate.
// Isolated .orca state; remote.test allowlisted past the anti-DNS-rebinding gate.
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

const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
const p = await ctx.newPage();
await p.goto(`http://remote.test:${port}/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2600); // let the first poll 401 → gate takeover

// 1. The gate renders (unpaired device is blocked).
const gate = await p.evaluate(() => ({
  hasGate: Boolean(document.querySelector('.connect-gate')),
  hasInput: Boolean(document.querySelector('#pairing-code-input')),
  hasPairBtn: Boolean(document.querySelector('[data-action="pairBrowserSession"]')),
  bodyGated: document.body.classList.contains('access-gated'),
}));
check('gate.renders', gate.hasGate);
check('gate.hasCodeInput', gate.hasInput);
check('gate.hasPairButton', gate.hasPairBtn);
check('gate.bodyAccessGated', gate.bodyGated);
await p.screenshot({ path: path.join(outDir, 'pair-gate.png') });

// 2. A WRONG code surfaces .connect-error.
await p.fill('#pairing-code-input', 'WRONG-CODE-9999');
await p.click('[data-action="pairBrowserSession"]');
await p.waitForTimeout(700);
const wrong = await p.evaluate(() => ({
  hasError: Boolean(document.querySelector('.connect-error')),
  stillGated: Boolean(document.querySelector('.connect-gate')),
}));
check('wrongCode.showsError', wrong.hasError);
check('wrongCode.stillOnGate', wrong.stillGated);

// 3. No-clobber: type a code, let a 2s poll fire, the half-typed value SURVIVES.
// (The gate re-renders only once, on the transition into blocked; subsequent
// 401 polls return early so they can't wipe the field.)
await p.fill('#pairing-code-input', 'HALF-TYPED-1234');
await p.waitForTimeout(2300); // > one poll interval
const survived = await p.evaluate(() => document.querySelector('#pairing-code-input')?.value || '');
check('noClobber.valueSurvivesPoll', survived === 'HALF-TYPED-1234');

// 4. A VALID code pairs the device and the dashboard replaces the gate.
const codeResp = await fetch(`${base}/api/auth/pairing-codes`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orca-token': 'verify-token' },
  body: JSON.stringify({ actor: 'test', label: 'phone' }),
}).then((r) => r.json());
const code = codeResp?.pairing?.code;
check('valid.gotPairingCode', Boolean(code));
await p.fill('#pairing-code-input', code || '');
await p.click('[data-action="pairBrowserSession"]');
await p.waitForTimeout(1200);
const paired = await p.evaluate(() => ({
  gateGone: !document.querySelector('.connect-gate'),
  notGated: !document.body.classList.contains('access-gated'),
  hasSidebar: Boolean(document.getElementById('sidebar')),
}));
check('valid.gateReplaced', paired.gateGone);
check('valid.bodyUngated', paired.notGated);
check('valid.dashboardVisible', paired.hasSidebar);

console.log('[verify] pair-gate:', JSON.stringify(results, null, 2));
await ctx.close();
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] pair-gate FAILED'); process.exit(1); }
console.log('[verify] pair-gate OK');
