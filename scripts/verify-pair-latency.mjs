// Prove a remote pairing appears on the workstation FAST even when the rest of the
// refresh is slow. We delay /api/projects by 4s (simulating a real workstation
// where CLI-info + projects/sessions/lanes calls take seconds). With the immediate
// render on auth-session change, the paired device must show in ~1s, NOT ~4s+.
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

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1100, height: 880 }, colorScheme: 'dark' });
// Make the LATE part of refresh slow (projects is fetched after auth sessions).
await ctx.route('**/api/projects', async (route) => {
  await new Promise((r) => setTimeout(r, 4000));
  return route.continue();
});
const p = await ctx.newPage();
await p.goto(base + '/#pair', { waitUntil: 'domcontentloaded' });
// Let the (slow) initial refresh settle so subsequent paired-count changes register.
await p.waitForTimeout(6000);

// Pair a "phone" via the API and time how long until the row appears on the workstation.
const pc = await fetch(base + '/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'v', label: 'v', ttlMs: 60000 }) }).then((r) => r.json());
const t0 = Date.now();
await fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pc.pairing.code, label: 'Latency Phone', deviceId: 'lat-1' }) });

let shownAt = null;
for (let i = 0; i < 80; i += 1) { // up to ~8s
  const found = await p.evaluate(() => Array.from(document.querySelectorAll('.device-row strong')).some((el) => el.textContent.trim() === 'Latency Phone'));
  if (found) { shownAt = Date.now(); break; }
  await p.waitForTimeout(100);
}
const latencyMs = shownAt ? shownAt - t0 : null;
console.log(JSON.stringify({
  latencyMs,
  shown: shownAt !== null,
  fastEnough: latencyMs !== null && latencyMs < 3000, // well under the 4s projects delay
  note: 'projects delayed 4s; <3s proves the device rendered before the slow tail',
}, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
