// Reproduce the "valid paired row vanishes" race and prove the out-of-order guard
// fixes it. The first /api/auth/sessions response (the initial refresh's, fetched
// BEFORE a device pairs → list without B) is held so it lands AFTER a fresh sync
// that includes B. Without the guard, that stale response clobbers and B vanishes;
// with it, B stays (the session is valid the whole time).
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

// Device A already paired (the list starts as [A]).
const pcA = await fetch(base + '/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'v', label: 'A', ttlMs: 60000 }) }).then((r) => r.json());
await fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pcA.pairing.code, label: 'Device A', deviceId: 'dev-A' }) });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1100, height: 880 }, colorScheme: 'dark' });
// Hold ONLY the first auth-sessions response ~2.6s so it resolves after a later sync.
let authCallN = 0;
await ctx.route('**/api/auth/sessions', async (route) => {
  authCallN += 1;
  const resp = await route.fetch();           // server returns CURRENT state now
  const body = await resp.body();
  if (authCallN === 1) await new Promise((r) => setTimeout(r, 2600)); // stale-in-transit
  return route.fulfill({ response: resp, body });
});

const p = await ctx.newPage();
await p.goto(base + '/#pair', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(900); // first auth fetch (=> [A]) is now in flight + held

// Pair device B while the stale first response is still held.
const pcB = await fetch(base + '/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'v', label: 'B', ttlMs: 60000 }) }).then((r) => r.json());
await fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pcB.pairing.code, label: 'Device B', deviceId: 'dev-B' }) });

const hasB = () => p.evaluate(() => Array.from(document.querySelectorAll('.device-row strong')).some((el) => el.textContent.trim() === 'Device B'));
// Let SSE/sync pick up B.
let bShown = false;
for (let i = 0; i < 25; i += 1) { if (await hasB()) { bShown = true; break; } await p.waitForTimeout(120); }
// Now wait past the held stale response (which would clobber without the guard).
await p.waitForTimeout(2600);
const bStillShown = await hasB();

console.log(JSON.stringify({
  bShownAfterPair: bShown,
  bSurvivedStaleResponse: bStillShown,
  pass: bShown && bStillShown,
}, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
