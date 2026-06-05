// Reproduce/verify: revoking a paired device REMOVES its row from the workstation
// UI (not just server-side). Pairs two REAL devices via the API so the live poll
// drives shell.authSessions, loads the workstation admin view, opens Paired
// devices, clicks Revoke on the first, accepts the confirm, and asserts the row
// count drops. Isolated .orca state (chdir to temp before importing the server).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));

process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
// No ORCA_API_TOKEN: loopback browser is bootstrap-admin (the real workstation case).
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;

async function pair(label, deviceId) {
  const pc = await fetch(base + '/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'verify', label, ttlMs: 60000 }) }).then((r) => r.json());
  await fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pc.pairing.code, label, deviceId }) });
}
await pair('Device One', 'dev-1');
await pair('Device Two', 'dev-2');

const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1100, height: 880 }, colorScheme: 'dark' });
const p = await ctx.newPage();
// Auto-accept the revoke confirm modal by clicking its Confirm button when it appears.
await p.goto(base + '/#pair', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500); // let the poll populate authSessions

const rowCount = () => p.evaluate(() => document.querySelectorAll('[data-action="revokeBrowserSession"]').length);
await p.evaluate(() => { const d = document.querySelector('details[data-uikey="pair-paired-devices"]'); if (d) d.open = true; });
await p.waitForTimeout(200);
const before = await rowCount();

// Click the first Revoke, then the modal Confirm.
await p.evaluate(() => document.querySelector('[data-action="revokeBrowserSession"]').click());
await p.waitForTimeout(250);
await p.evaluate(() => { const c = document.querySelector('.modal-confirm'); if (c) c.click(); });
// Short wait: the optimistic removal should drop the row immediately, WITHOUT
// needing a full poll cycle. (before = devices × 3 panels.)
await p.waitForTimeout(400);
await p.evaluate(() => { const d = document.querySelector('details[data-uikey="pair-paired-devices"]'); if (d) d.open = true; });
await p.waitForTimeout(150);
const afterImmediate = await rowCount();
// And it stays gone after the poll reconciles.
await p.waitForTimeout(1500);
await p.evaluate(() => { const d = document.querySelector('details[data-uikey="pair-paired-devices"]'); if (d) d.open = true; });
const afterSettle = await rowCount();
await p.screenshot({ path: path.join(outDir, 'revoke-removes.png') });

const panels = before / 2; // two devices across N identical panels
console.log(JSON.stringify({
  beforeRows: before, afterImmediate, afterSettle, panels,
  removedImmediately: afterImmediate === before - panels,
  stillGone: afterSettle === before - panels,
}, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
