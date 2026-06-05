// SECURITY/correctness: the workstation must show "Device paired ✓" ONLY when a
// device actually consumes the code it created — never just from creating a code
// (the false-positive bug, made worse by a pre-existing paired device). Reproduces
// that state: one device already paired, then create a NEW code and confirm NO
// "paired" flash until a device consumes THAT specific code.
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

// Pre-existing paired device (like the user's "phone browser").
const pc0 = await fetch(base + '/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'v', label: 'old', ttlMs: 60000 }) }).then((r) => r.json());
await fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pc0.pairing.code, label: 'Existing phone', deviceId: 'old-dev' }) });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1100, height: 880 }, colorScheme: 'dark' });
const p = await ctx.newPage();
await p.goto(base + '/#pair', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200); // existing device loads into authSessions

const flashShown = () => p.evaluate(() => Boolean(document.querySelector('.pairing-code-box.pairing-accepted')));
const codeShown = () => p.evaluate(() => document.querySelector('.pairing-code-value')?.textContent?.trim() || '');

// Create a NEW code from the workstation. This MUST NOT claim "paired".
await p.evaluate(() => document.querySelector('[data-action="createPairingCode"]').click());
await p.waitForTimeout(2000); // across poll + sync cycles
const afterCreate = { flash: await flashShown(), code: await codeShown() };

// Now a device actually consumes THAT code → flash should appear.
const code = afterCreate.code;
await fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, label: 'New phone', deviceId: 'new-dev' }) });
let flashedAfterPair = false;
for (let i = 0; i < 30; i += 1) { if (await flashShown()) { flashedAfterPair = true; break; } await p.waitForTimeout(150); }

console.log(JSON.stringify({
  falseFlashOnCreate: afterCreate.flash,         // MUST be false
  codeStillShownAfterCreate: Boolean(afterCreate.code), // MUST be true (not consumed yet)
  flashedOnlyAfterRealPair: flashedAfterPair,     // MUST be true
  pass: afterCreate.flash === false && Boolean(afterCreate.code) && flashedAfterPair === true,
}, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
