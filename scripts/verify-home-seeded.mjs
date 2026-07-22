// Verify the Home dashboard tree renders REAL seeded data (not just the empty
// state). On loopback (bootstrap-admin, no token) we register an orchestrator and
// spawn a mock-executor lane via the read/write API, open Home, and assert the
// full projects → orchestrator → lane tree paints: the project card, the
// orchestrator row, the lane (executor) row with its status tag, and the
// break-glass stop control (the lane is non-terminal, so ⏹ shows). Isolated .orca
// state (temp cwd) with ORCA_REPO_ROOTS pinned to it so registerOrchestrator's cwd
// check passes. A mock executor keeps the lane alive without a real agent process.
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
const check = (name, cond) => { results[name] = cond; if (!cond) { failed = true; console.error(`  FAIL ${name}`); } };
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// ---- Seed: a project (via its orchestrator) + a mock-executor lane under it ----
const projDir = await fs.realpath(await (async () => { const d = path.join(realTemp, 'Demo Project'); await fs.mkdir(d, { recursive: true }); return d; })());
const orch = await post('/api/orchestrators', { actor: 'demo', cwd: projDir, title: 'Demo orchestrator' });
check('seed.orchestrator', Boolean(orch && orch.id));
const lane = await post(`/api/orchestrators/${orch.id}/lanes`, { actor: 'demo', approved: true, title: 'Demo lane', executorType: 'mock' });
check('seed.lane', Boolean(lane && lane.id));

const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
const p = await ctx.newPage();
await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(900); // let a poll fetch /api/overview and render Home

const tree = await p.evaluate(() => {
  const proj = document.querySelector('.ov-tree .ov-project');
  const exec = document.querySelector('.ov-project .ov-exec');
  return {
    hasTree: Boolean(document.querySelector('.ov-tree')),
    projectName: document.querySelector('.ov-project .ov-pname')?.textContent || '',
    projectOpen: proj instanceof HTMLDetailsElement ? proj.open : false,
    orchestratorTitle: document.querySelector('.ov-orch .ov-otitle')?.textContent || '',
    laneTitle: document.querySelector('.ov-exec .ov-etitle')?.textContent || '',
    tagText: (document.querySelector('.ov-exec .ov-tag')?.textContent || '').trim(),
    tagWorking: Boolean(document.querySelector('.ov-exec .ov-tag.working')),
    hasStop: Boolean(exec && exec.querySelector('.ov-stop')),
    notEmpty: !document.querySelector('.ov-empty'),
  };
});
check('home.treeRenders', tree.hasTree);
check('home.notEmptyState', tree.notEmpty);
check('home.projectName', tree.projectName === 'Demo Project');
check('home.projectOpen', tree.projectOpen);
check('home.orchestratorRow', tree.orchestratorTitle === 'Demo orchestrator');
check('home.laneRow', tree.laneTitle === 'Demo lane');
check('home.statusTag', tree.tagText.length > 0 && tree.tagWorking);
check('home.breakGlassStop', tree.hasStop);
await p.screenshot({ path: path.join(outDir, 'home-seeded.png') });

console.log('[verify] home-seeded:', JSON.stringify(results, null, 2));
await ctx.close();
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
if (failed) { console.error('[verify] home-seeded FAILED'); process.exit(1); }
console.log('[verify] home-seeded OK');
