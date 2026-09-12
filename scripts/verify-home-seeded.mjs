// Verify the two screens that replaced the old single "Home", in a real browser.
//
// `/` is a WELCOME — the owner: "the home page should just show the welcome
// essentially, and then the projects themselves can show what is running". So it
// must carry the daemon's state directory and the honest counts, point at the
// panel on the left, and draw NO agent graph at all.
//
// `#/project/<id>` is where the graph lives, and it must paint REAL seeded data
// on the interactive node-graph CANVAS (not the empty state, and not the old
// nested list-tree): the #ov-canvas container (body.home-canvas), exactly the
// expected .ov-node count (1 orchestrator + 1 executor = 2), the orchestrator
// node card (.ov-node--orchestrator + title + its break-glass kill), the executor
// node card (title + status pill + "mock" CLI badge), a non-empty edges <path d>,
// and the three .ov-stat cards with sane numbers.
//
// On loopback (bootstrap-admin, no token) we register an orchestrator and spawn a
// mock-executor lane via the read/write API. Isolated .orca state (temp cwd) with
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

// ---- `/` is the WELCOME: orienting facts, no agent graph ---------------------
await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => Boolean(document.querySelector('.wel-wrap')), null, { timeout: 8000 })
  .catch(() => { /* asserted explicitly below */ });
const welcome = await p.evaluate(() => ({
  hasWelcome: Boolean(document.querySelector('.wel-wrap')),
  title: document.querySelector('.wel-title')?.textContent || '',
  stats: [...document.querySelectorAll('.wel-stat')].map((n) => `${n.querySelector('.wel-stat-n')?.textContent} ${n.querySelector('.wel-stat-l')?.textContent}`),
  facts: [...document.querySelectorAll('.wel-facts dd')].map((n) => n.textContent.trim()),
  text: document.getElementById('content')?.textContent || '',
  // The two things a welcome must NOT be.
  nodes: document.querySelectorAll('.ov-node').length,
  hasCanvas: Boolean(document.getElementById('ov-canvas')),
  canvasClass: document.body.classList.contains('home-canvas'),
  // And the panel on the left is still the switcher.
  sidebarProjects: document.querySelectorAll('.sidebar-project').length,
}));
check('welcome.rendered', welcome.hasWelcome);
check('welcome.saysOrcaIsRunning', /running/i.test(welcome.title));
check('welcome.hasCounts', welcome.stats.length === 4 && welcome.stats.some((t) => /project/.test(t)) && welcome.stats.some((t) => /lane/.test(t)));
check('welcome.saysWhereStateIs', welcome.facts.some((t) => t.includes(realTemp) || /\.orca/.test(t)));
check('welcome.pointsAtThePanel', /panel on the left/i.test(welcome.text));
check('welcome.hasNoAgentGraph', welcome.nodes === 0 && !welcome.hasCanvas && !welcome.canvasClass);
check('welcome.sidebarStillLists', welcome.sidebarProjects === 1);

// ---- `#/project/<id>` is where the work is -----------------------------------
const projectId = (await fetch(`${base}/api/overview`).then((r) => r.json())).projects[0].id;
await p.goto(`${base}/#/project/${encodeURIComponent(projectId)}`, { waitUntil: 'domcontentloaded' });
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

// The project page names itself and reports its size, with no switcher on it.
const header = await p.evaluate(() => ({
  name: document.querySelector('.ov-scope-name')?.textContent || '',
  note: document.querySelector('.ov-scope-note')?.textContent || '',
  hasDropdown: Boolean(document.querySelector('[data-canvas="projects"], .ov-project-row')),
  hasRetiredToggle: Boolean(document.querySelector('[data-canvas="retired"]')),
}));
check('project.namesItself', header.name === 'Demo Project');
check('project.reportsItsSize', /agent/.test(header.note) && /lane/.test(header.note));
check('project.hasNoDropdownPicker', !header.hasDropdown);
check('project.hasNoRetiredToggle', !header.hasRetiredToggle);

await p.screenshot({ path: path.join(outDir, 'project-seeded.png') });
await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => Boolean(document.querySelector('.wel-wrap')), null, { timeout: 8000 }).catch(() => {});
await p.screenshot({ path: path.join(outDir, 'home-welcome.png') });

console.log('[verify] home-seeded:', JSON.stringify({ ...results, _measured: { nodeCount: view.nodeCount, execCli: view.execCli, statNums: view.statNums, edgeDLen: view.edgeD.length, welcomeStats: welcome.stats } }, null, 2));
await ctx.close();
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] home-seeded FAILED'); process.exit(1); }
console.log('[verify] home-seeded OK');
