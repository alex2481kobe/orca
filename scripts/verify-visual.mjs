// Visual-capture harness: screenshots the LIVE screens (seeded Home tree + the
// Settings screen) across desktop/mobile and dark/light, to a caller-chosen dir.
// Purpose: before/after regression proof for CSS/markup pruning — the dead
// selectors being removed (.lane-detail-shell / .cfg / .dd / composer /
// operator-terminal) render nothing today, so every live screen MUST be
// pixel-identical after removal; a diff means a torn comment cut a LIVE
// .sidebar-* / settings rule (the [[css-prune-hazard]] failure mode).
//
// Usage: node scripts/verify-visual.mjs [outDir]   (default: artifacts/visual)
// Loopback bootstrap-admin (no token), isolated .orca state in a temp cwd.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
const outDir = path.resolve(projectCwd, process.argv[2] || 'artifacts/visual');
const realTemp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-visual-state-')));
process.chdir(realTemp);
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
process.env.ORCA_REPO_ROOTS = realTemp; // registerOrchestrator cwd check
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;
await fs.mkdir(outDir, { recursive: true });
const b = await chromium.launch();
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const shots = [];

// ---- Seed a project (via its orchestrator) + a mock-executor lane ----
const projDir = path.join(realTemp, 'Demo Project');
await fs.mkdir(projDir, { recursive: true });
const orch = await post('/api/orchestrators', { actor: 'demo', cwd: await fs.realpath(projDir), title: 'Demo orchestrator' });
await post(`/api/orchestrators/${orch.id}/executors`, { actor: 'demo', approved: true, title: 'Build the thing', executorType: 'mock' });

async function capture(label, { width, height, colorScheme, nav }) {
  const ctx = await b.newContext({ viewport: { width, height }, colorScheme });
  const p = await ctx.newPage();
  await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900); // let the poll fetch /api/overview + render
  if (nav) {
    // On mobile the drawer is closed; open it first if a reopen control shows.
    const opener = await p.evaluate(() => {
      const vis = (el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
      if (vis(document.getElementById('sidebar-reopen'))) return '#sidebar-reopen';
      return null;
    });
    if (opener) { await p.click(opener); await p.waitForTimeout(300); }
    await p.click(`[data-nav="${nav}"]`, { timeout: 4000 }).catch(() => {});
    await p.waitForTimeout(500);
  }
  const file = path.join(outDir, `${label}.png`);
  await p.screenshot({ path: file, fullPage: false });
  shots.push(label);
  await ctx.close();
}

// Regression-diff screens (where the dead selectors live: home tree + sidebar + settings).
await capture('home-desktop-dark', { width: 1280, height: 900, colorScheme: 'dark' });
await capture('home-desktop-light', { width: 1280, height: 900, colorScheme: 'light' });
await capture('home-mobile-dark', { width: 390, height: 844, colorScheme: 'dark' });
await capture('settings-desktop-dark', { width: 1280, height: 900, colorScheme: 'dark', nav: 'settings' });
await capture('settings-desktop-light', { width: 1280, height: 900, colorScheme: 'light', nav: 'settings' });

console.log(`[visual] captured ${shots.length} → ${outDir}:`, shots.join(', '));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
