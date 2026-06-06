// Regression guard: re-pairing the SAME device (same deviceId) replaces its
// session — the paired-device COUNT is unchanged, only the session id changes.
// applyAuthSessions() used to signal "render" only on a COUNT change, so this
// case skipped the re-render and the workstation kept showing the stale pairing
// code until the slow ~15s SSE-fallback poll (the "10-20s after pairing" lag).
// This verifies the workstation clears the on-screen code in well under 3s when
// its one-time code is consumed, even on a count-unchanged re-pair.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-repair-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;
const b = await chromium.launch();
const p = await b.newContext().then((c) => c.newPage());
await p.goto(base + '/#system', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);

const out = await p.evaluate(async () => {
  const mkCode = async () => (await (await fetch('/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', label: 'repair-test' }) })).json()).pairing;
  const pair = async (code) => fetch('/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', code, label: 'repair phone', deviceId: 'repair-dev' }) });
  const { shell } = await import('/ui/state.js');
  const views = await import('/ui/render-views.js');

  // Baseline: pair the device once so the re-pair keeps the count constant.
  const c1 = await mkCode();
  await pair(c1.code);
  await new Promise((r) => setTimeout(r, 1000));

  // Workstation creates a code → render it into the DOM.
  const c2 = await mkCode();
  shell.lastPairing = { id: c2.id, code: c2.code, expiresAt: c2.expiresAt };
  views.render();
  const codeVisibleBefore = Boolean(document.querySelector('.pairing-countdown, [data-expires]'));

  // Re-pair the SAME device (count unchanged).
  const start = Date.now();
  await pair(c2.code);
  let codeGoneMs = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!document.querySelector('.pairing-countdown, [data-expires]')) { codeGoneMs = Date.now() - start; break; }
    await new Promise((r) => setTimeout(r, 40));
  }
  return { codeVisibleBefore, codeGoneMs };
});

const result = {
  codeRenderedBeforeRepair: out.codeVisibleBefore,
  codeClearedMs: out.codeGoneMs,
  clearedFastEnough: out.codeGoneMs !== null && out.codeGoneMs < 3000,
};
result.pass = result.codeRenderedBeforeRepair && result.clearedFastEnough;
console.log('[verify] pair-repair-renders:', JSON.stringify(result, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (!result.pass) process.exitCode = 1;
