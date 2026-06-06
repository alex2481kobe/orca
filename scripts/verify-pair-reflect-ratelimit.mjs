// Regression guard for the "workstation takes ~27s to show a paired device" bug.
//
// Root cause: GET /api/auth/sessions (polled ~1/s by the dashboard while a
// pairing code is on screen) was classified under the strict `auth` rate policy
// (12/min, meant for auth MUTATIONS). After ~12s the poll 429'd for the rest of
// the 60s window, so syncAuthSessions bailed and the paired-device list froze.
//
// This runs an ISOLATED server with rate limiting ENABLED (the default — the bug
// is INVISIBLE when limits are disabled, which is why earlier verifies missed it),
// pairs an existing device, then drives the real create-code → pair flow with a
// >12s delay (enough to exhaust the OLD 12/min budget) and asserts the workstation
// reflects the new device in well under 3s.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-rl-')));
process.env.PORT = '0';
process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
// IMPORTANT: do NOT disable rate limiting — this bug only manifests with it ON.
delete process.env.ORCA_RATE_LIMIT_DISABLED;

const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;

const mkCode = async (label) => (await (await fetch(base + '/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', label }) })).json()).pairing;
const pair = async (code, deviceId, label) => fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', code, label, deviceId }) });

// An already-paired device (the user's existing phone).
const ec = await mkCode('existing');
await pair(ec.code, 'existing-dev', 'existing phone');

const b = await chromium.launch();
const page = await b.newContext().then((c) => c.newPage());
await page.goto(base + '/#system', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.evaluate(async () => { window.__shell = (await import('/ui/state.js')).shell; window.__polls = 0; window.__429 = 0; const o = window.fetch; window.fetch = async (...a) => { const u = typeof a[0] === 'string' ? a[0] : a[0]?.url || ''; const r = await o(...a); if (u.includes('/api/auth/sessions')) { window.__polls++; if (r.status === 429) window.__429++; } return r; }; });

// Workstation creates a code via the real button.
await page.evaluate(() => document.querySelector('[data-action="createPairingCode"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(800);
const code = await page.evaluate(() => window.__shell.lastPairing?.code || null);

// Realistic human delay LONGER than the old 12-req/60s window would survive.
await page.waitForTimeout(14000);
const midPolls = await page.evaluate(() => ({ polls: window.__polls, r429: window.__429 }));

// Phone pairs.
const pairStart = Date.now();
await pair(code, 'new-dev', 'new phone');

let clearedMs = null, deviceShownMs = null;
for (let i = 0; i < 60; i++) { // up to ~18s
  const snap = await page.evaluate(() => ({ cleared: !window.__shell.lastPairing, paired: (window.__shell.authSessions || []).filter((x) => x.pairedFromId).length }));
  const now = Date.now() - pairStart;
  if (clearedMs === null && snap.cleared) clearedMs = now;
  if (deviceShownMs === null && snap.paired >= 2) deviceShownMs = now;
  if (clearedMs !== null && deviceShownMs !== null) break;
  await new Promise((r) => setTimeout(r, 200));
}
const final429 = await page.evaluate(() => window.__429);

const result = {
  pollsBeforePair: midPolls.polls,
  rateLimited429sBeforePair: midPolls.r429,
  codeClearedMs: clearedMs,
  bothDevicesShownMs: deviceShownMs,
  total429s: final429,
};
result.pass = result.total429s === 0
  && clearedMs !== null && clearedMs < 3000
  && deviceShownMs !== null && deviceShownMs < 3000;
console.log('[verify] pair-reflect-ratelimit:', JSON.stringify(result, null, 2));

await b.close();
if (sm.stopServer) await sm.stopServer();
await new Promise((r) => s.close(r));
if (!result.pass) process.exitCode = 1;
