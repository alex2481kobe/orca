#!/usr/bin/env node
// Home is scoped to ONE project, in a real browser.
//
// The owner's complaint was "in home screen you see all the agents from all the
// projects, that is not right" — over the live state that is 3 projects, 11
// orchestrators and 50 lanes in one flat tree. verify-home-seeded.mjs proves the
// canvas paints a seeded forest; it seeds ONE project, so it cannot see this.
// This seeds TWO and asserts the screen shows one of them, names it, says how
// many others there are, lists them all in the switcher and the sidebar, and
// actually crosses over when you pick one.
//
// Isolated .orca state (temp cwd), ephemeral port, bootstrap-admin on loopback —
// the same harness shape as the other verify-* screens.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const realTemp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-scope-')));
process.chdir(realTemp);
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
process.env.ORCA_REPO_ROOTS = realTemp;
const sm = await import('../src/server.js');
const server = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${server.address().port}`;

const results = {};
let failed = false;
const check = (name, cond, detail) => {
  results[name] = Boolean(cond);
  if (!cond) { failed = true; console.error(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); }
};
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// ---- Seed TWO projects, each with an orchestrator and a lane ----------------
const projectDir = async (name) => {
  const dir = path.join(realTemp, name);
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
};
for (const [name, title] of [['alpha', 'Alpha orchestrator'], ['beta', 'Beta orchestrator']]) {
  const orchestrator = await post('/api/orchestrators', { actor: 'demo', cwd: await projectDir(name), title });
  check(`seed.${name}`, Boolean(orchestrator && orchestrator.id));
  await post(`/api/orchestrators/${orchestrator.id}/executors`, { actor: 'demo', approved: true, title: `${name} lane`, executorType: 'mock' });
}

// ---- The projection still carries BOTH, and nominates one -------------------
const overview = await fetch(`${base}/api/overview`).then((response) => response.json());
check('projection.bothProjects', overview.projects.length === 2, overview.projects.map((p) => p.name));
check('projection.nominates', overview.projects.some((p) => p.id === overview.defaultProjectId), overview.defaultProjectId);
check('projection.saysWhy', typeof overview.defaultProjectReason === 'string' && overview.defaultProjectReason !== 'none', overview.defaultProjectReason);
// counts stay honest: what exists, beside what the projection carries.
check('projection.countsHonest', overview.counts.projects === 2 && overview.counts.shownProjects === 2, overview.counts);

const scoped = overview.projects.find((p) => p.id === overview.defaultProjectId);
const other = overview.projects.find((p) => p.id !== overview.defaultProjectId);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })).newPage();
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('#ov-canvas .ov-node').length > 0, null, { timeout: 8000 })
  .catch(() => { /* asserted explicitly below */ });

const view = await page.evaluate(() => ({
  nodeTitles: [...document.querySelectorAll('.ov-node-title')].map((n) => n.textContent),
  scopeName: document.querySelector('.ov-scope-name')?.textContent || '',
  scopeNote: document.querySelector('.ov-scope-note')?.textContent || '',
  sidebar: [...document.querySelectorAll('.sidebar-project')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
  sidebarSelected: document.querySelectorAll('.sidebar-project.is-selected').length,
  hasSwitcher: Boolean(document.querySelector('[data-canvas="projects"]')),
}));

// ONE project on screen: its orchestrator and its lane, and nothing from the other.
check('home.showsScopedProject', view.nodeTitles.includes(`${scoped.name} lane`) || view.nodeTitles.some((t) => t.toLowerCase().startsWith(scoped.name)), view.nodeTitles);
check('home.hidesOtherProject', !view.nodeTitles.some((t) => t.toLowerCase().includes(other.name)), view.nodeTitles);
check('home.namesTheScope', view.scopeName === scoped.name, view.scopeName);
check('home.countsTheOthers', /1 other project/.test(view.scopeNote), view.scopeNote);
check('home.hasSwitcher', view.hasSwitcher);
// ...and the others stay REACHABLE, marked, never merged into the tree.
check('sidebar.listsAll', view.sidebar.length === 2, view.sidebar);
check('sidebar.marksScoped', view.sidebarSelected === 1, view.sidebarSelected);

// ---- Switching is explicit, listed, and actually crosses over ---------------
await page.click('[data-canvas="projects"]');
const picker = await page.evaluate(() => [...document.querySelectorAll('.ov-project-row')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
check('switcher.listsEveryProject', picker.length === 2, picker);

await page.click(`[data-pick-project="${other.id}"]`);
await page.waitForFunction(
  (name) => document.querySelector('.ov-scope-name')?.textContent === name,
  other.name,
  { timeout: 5000 },
).catch(() => { /* asserted below */ });
const after = await page.evaluate(() => ({
  nodeTitles: [...document.querySelectorAll('.ov-node-title')].map((n) => n.textContent),
  scopeName: document.querySelector('.ov-scope-name')?.textContent || '',
  remembered: (() => { try { return localStorage.getItem('orca.project'); } catch { return null; } })(),
}));
check('switch.scopeFollows', after.scopeName === other.name, after.scopeName);
check('switch.treeFollows', !after.nodeTitles.some((t) => t.toLowerCase().includes(scoped.name)), after.nodeTitles);
check('switch.remembered', after.remembered === other.id, after.remembered);

console.log(`[verify] project-scope: ${JSON.stringify({ ...results, _measured: { scoped: scoped.name, other: other.name, reason: overview.defaultProjectReason, nodesOnHome: view.nodeTitles.length } }, null, 2)}`);
await browser.close();
server.close();
if (failed) { console.error('[verify] project-scope FAILED'); process.exit(1); }
console.log('[verify] project-scope OK');
process.exit(0);
