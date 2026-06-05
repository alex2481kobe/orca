// Visual + behavioral verification for the pairing UX fixes:
//   1. Light-mode revoke-confirmation dialog: the Cancel button must not turn
//      dark on hover (it used a hardcoded dark rgba; now var(--hover)).
//   2. "Device paired ✓" accepted state shown in place of a consumed code.
//   3. The "Paired devices" disclosure keeps its open state across a re-render
//      that changes the device count (stable data-uikey), so revoking a device
//      no longer collapses the panel.
// Not part of the smoke suite. Screenshots land in artifacts/verify/.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// CRITICAL: AuthSessionStore persists to <cwd>/.orca/auth-sessions.json. Running
// from the project dir would pair test devices into the REAL state file (the
// source of recurring phantom "verify"/"v" paired devices). chdir into a throwaway
// dir BEFORE importing the server so all .orca state is isolated. Output paths are
// resolved against the original cwd, captured here first.
const projectCwd = process.cwd();
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-'));
process.chdir(stateDir);

process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1'; process.env.ORCA_API_TOKEN = 'verify-token';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;
const token = process.env.ORCA_API_TOKEN;
const pc = await fetch(base + '/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-orca-token': token }, body: JSON.stringify({ actor: 'verify', label: 'v', ttlMs: 60000 }) }).then((r) => r.json());
const pr = await fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pc.pairing.code, label: 'v', deviceId: 'verify-dev' }) });
const setCookie = pr.headers.get('set-cookie') || '';

const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const b = await chromium.launch();
const results = {};

async function withTheme(colorScheme) {
  const ctx = await b.newContext({ viewport: { width: 1000, height: 860 }, colorScheme });
  if (setCookie) { const [cp] = setCookie.split(';'); const [n, ...v] = cp.split('='); await ctx.addCookies([{ name: n.trim(), value: v.join('=').trim(), url: base, httpOnly: true, sameSite: 'Lax' }]); }
  const p = await ctx.newPage();
  await p.goto(base, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  return { ctx, p };
}

// Inject a tailnet-ready private-access state + a couple of paired devices, then
// render the Pair panel. Returns synchronously-read facts about the DOM.
const seed = (p, { pairingAccepted = false, lastPairing = null, devices = 2 } = {}) => p.evaluate(async (opts) => {
  const mod = await import('./ui/state.js');
  const views = await import('./ui/render-views.js');
  mod.shell.privateAccess = { settings: { preferredMode: 'tailnet-http' }, targets: [], tailnet: { binaryAvailable: true, loggedIn: true, servedUrl: 'http://alexs-mac-mini.tailf87abc.ts.net' } };
  mod.shell.authSessions = Array.from({ length: opts.devices }, (_, i) => ({
    id: `dev-${i}`, label: i === 0 ? 'Alex iPhone (app)' : `Paired device ${i}`,
    paired: true, pairedFromId: `pc-${i}`, active: true,
    createdAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    userAgent: 'Mozilla/5.0 iPhone',
  }));
  mod.shell.lastPairing = opts.lastPairing;
  mod.shell.pairingAccepted = opts.pairingAccepted ? { at: Date.now() } : null;
  window.location.hash = '#pair';
  views.render();
}, { pairingAccepted, lastPairing, devices });

// ---- Check 2: "Device paired" accepted box (light) ----
{
  const { ctx, p } = await withTheme('light');
  await seed(p, { pairingAccepted: true });
  await p.waitForTimeout(150);
  const accepted = await p.evaluate(() => {
    const box = document.querySelector('.pairing-code-box.pairing-accepted');
    return { present: Boolean(box), text: box ? box.textContent.replace(/\s+/g, ' ').trim() : '' };
  });
  results.acceptedBox = accepted;
  await p.screenshot({ path: path.join(outDir, 'pairing-accepted-light.png') });
  await ctx.close();
}

// ---- Check 1: revoke-confirm dialog cancel button (light) ----
{
  const { ctx, p } = await withTheme('light');
  await seed(p, { devices: 2 });
  await p.waitForTimeout(150);
  // Open the Paired devices disclosure, then click the first Revoke button.
  await p.evaluate(() => {
    const d = document.querySelector('details[data-uikey="paired-devices"]');
    if (d) d.open = true;
  });
  await p.waitForTimeout(100);
  const clicked = await p.evaluate(() => {
    const btn = document.querySelector('[data-action="revokeBrowserSession"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await p.waitForTimeout(250);
  const dialog = await p.evaluate(() => {
    const cancel = document.querySelector('.modal-cancel');
    if (!cancel) return { present: false };
    const cs = getComputedStyle(cancel);
    return { present: true, background: cs.backgroundColor, color: cs.color, padding: cs.padding };
  });
  results.revokeDialog = { clicked, ...dialog };
  await p.screenshot({ path: path.join(outDir, 'revoke-confirm-light.png') });
  await ctx.close();
}

// ---- Check 3: disclosure stays open across a count-changing re-render ----
{
  const { ctx, p } = await withTheme('dark');
  await seed(p, { devices: 3 });
  await p.waitForTimeout(150);
  const persisted = await p.evaluate(async () => {
    const frag = await import('./ui/render-fragments.js');
    const views = await import('./ui/render-views.js');
    const mod = await import('./ui/state.js');
    // Open ONLY the pair-panel disclosure; leave the sibling token/access ones
    // closed. Each must persist its OWN state across a re-render (unique uikeys).
    const target = document.querySelector('details[data-uikey="pair-paired-devices"]');
    target.open = true;
    const sibling = document.querySelector('details[data-uikey="access-paired-devices"]');
    if (sibling) sibling.open = false;
    const uiState = frag.captureContentUiState();
    // Simulate a revoke: drop one device, then re-render + restore (what refresh does).
    mod.shell.authSessions = mod.shell.authSessions.slice(0, 2);
    views.render();
    frag.restoreContentUiState(uiState);
    const afterTarget = document.querySelector('details[data-uikey="pair-paired-devices"]');
    const afterSibling = document.querySelector('details[data-uikey="access-paired-devices"]');
    return {
      uniqueKeys: ['pair-paired-devices', 'token-paired-devices', 'access-paired-devices']
        .filter((k) => document.querySelector(`details[data-uikey="${k}"]`)).length,
      targetStillOpen: Boolean(afterTarget && afterTarget.open),
      siblingStayedClosed: Boolean(afterSibling && !afterSibling.open),
    };
  });
  results.disclosurePersistence = persisted;
  await p.screenshot({ path: path.join(outDir, 'paired-disclosure-open.png') });
  await ctx.close();
}

console.log('[verify] pairing-ux:', JSON.stringify(results, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
