// Verify the Home dashboard renders REAL seeded data on the interactive node-graph
// CANVAS (not the empty state, and not the old nested list-tree). On loopback
// (bootstrap-admin, no token) we register an orchestrator and spawn a mock-executor
// lane via the read/write API, open Home, and assert the canvas paints the seeded
// forest: the #ov-canvas container (body.home-canvas), exactly the expected .ov-node
// count (1 orchestrator + 1 executor = 2), the orchestrator node card (.ov-node--
// orchestrator + title + its break-glass kill), the executor node card (title +
// status pill + "mock" CLI badge), a non-empty edges <path d>, and the three
// .ov-stat cards with sane numbers. Isolated .orca state (temp cwd) with
// ORCA_REPO_ROOTS pinned to it so registerOrchestrator's cwd check passes. A mock
// executor keeps the lane alive without a real agent process.
//
// NOTE: the mock lane may auto-complete quickly, so we assert only on structure
// that's true whether the lane is running or complete (not a hard "working" pill).
// For the non-terminal stop-affordance assertion we target the ORCHESTRATOR's
// .ov-menu-btn (the ⋯ menu that gates Stop) — it stays active while a lane can
// race to done. The actual Stop action lives inside that menu once opened.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
const realTemp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.chdir(realTemp);
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
// registerOrchestrator validates cwd against the approved repo roots; pin them to
// the isolated temp root so the seeded project folder is an approved root.
process.env.ORCA_REPO_ROOTS = realTemp;
// NO ORCA_API_TOKEN: loopback => bootstrap-admin, so the write endpoints succeed.
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;
const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
const b = await chromium.launch();
const results = {};
let failed = false;
const check = (name, cond) => { results[name] = Boolean(cond); if (!cond) { failed = true; console.error(`  FAIL ${name}`); } };
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// ---- Seed: a project (via its orchestrator) + a mock-executor lane under it ----
const projDir = await fs.realpath(await (async () => { const d = path.join(realTemp, 'Demo Project'); await fs.mkdir(d, { recursive: true }); return d; })());
const orch = await post('/api/orchestrators', { actor: 'demo', cwd: projDir, title: 'Demo orchestrator' });
check('seed.orchestrator', Boolean(orch && orch.id));
const lane = await post(`/api/orchestrators/${orch.id}/executors`, { actor: 'demo', approved: true, title: 'Demo lane', executorType: 'mock' });
check('seed.lane', Boolean(lane && lane.id));

const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
const p = await ctx.newPage();
await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
// Wait for the canvas to paint the seeded forest (orchestrator + lane = 2 nodes).
await p.waitForFunction(() => document.querySelectorAll('#ov-canvas .ov-node').length === 2, null, { timeout: 8000 })
  .catch(() => { /* asserted explicitly below with a clear failure */ });

const view = await p.evaluate(() => {
  const nodes = [...document.querySelectorAll('.ov-node')];
  const orchNode = document.querySelector('.ov-node--orchestrator');
  const execNode = nodes.find((n) => n.dataset.kind === 'executor');
  const pathEl = document.querySelector('#ov-edges path');
  const stats = [...document.querySelectorAll('.ov-statbar .ov-stat')];
  return {
    hasCanvas: Boolean(document.getElementById('ov-canvas')),
    hasScene: Boolean(document.getElementById('ov-scene')),
    homeCanvasClass: document.body.classList.contains('home-canvas'),
    notEmpty: !document.querySelector('.ov-empty'),
    nodeCount: nodes.length,
    orchIsOrch: Boolean(orchNode && orchNode.classList.contains('ov-node--orchestrator') && orchNode.dataset.kind === 'orchestrator'),
    orchTitle: orchNode?.querySelector('.ov-node-title')?.textContent || '',
    orchHasKill: Boolean(orchNode && orchNode.querySelector('.ov-menu-btn[data-menu]')),
    execKind: execNode?.dataset.kind || '',
    execTitle: execNode?.querySelector('.ov-node-title')?.textContent || '',
    execHasPill: Boolean(execNode && execNode.querySelector('.ov-pill')),
    execCli: (execNode?.querySelector('.ov-cli')?.textContent || '').trim(),
    edgeD: pathEl?.getAttribute('d') || '',
    statCount: stats.length,
    statNums: stats.map((s) => Number(s.querySelector('.ov-stat-n')?.textContent)),
    statLabels: stats.map((s) => (s.querySelector('.ov-stat-l')?.textContent || '').trim()),
  };
});

check('canvas.container', view.hasCanvas && view.hasScene);
check('canvas.homeClass', view.homeCanvasClass);
check('canvas.notEmptyState', view.notEmpty);
check('canvas.nodeCount', view.nodeCount === 2);
check('canvas.orchestratorNode', view.orchIsOrch);
check('canvas.orchestratorTitle', view.orchTitle === 'Demo orchestrator');
check('canvas.orchestratorKill', view.orchHasKill); // orchestrator is non-terminal → break-glass stop shows
check('canvas.executorNode', view.execKind === 'executor');
check('canvas.executorTitle', view.execTitle === 'Demo lane');
check('canvas.executorPill', view.execHasPill);
check('canvas.executorCli', view.execCli === 'mock');
check('canvas.edgesPath', view.edgeD.length > 0);
check('canvas.statCards', view.statCount === 3);
check('canvas.statNumbersSane', view.statNums.length === 3 && view.statNums.every((n) => Number.isFinite(n) && n >= 0) && view.statNums.reduce((a, c) => a + c, 0) === 2);
check('canvas.statLabels', JSON.stringify(view.statLabels) === JSON.stringify(['Active agents', 'Queued agents', 'Idle / complete']));

await p.screenshot({ path: path.join(outDir, 'home-seeded.png') });

console.log('[verify] home-seeded:', JSON.stringify({ ...results, _measured: { nodeCount: view.nodeCount, execCli: view.execCli, statNums: view.statNums, edgeDLen: view.edgeD.length } }, null, 2));
await ctx.close();
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] home-seeded FAILED'); process.exit(1); }
console.log('[verify] home-seeded OK');
