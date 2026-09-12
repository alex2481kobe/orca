#!/usr/bin/env node
// A project page shows ONE project's work, and the LEFT PANEL is the only way
// between projects — in a real browser.
//
// The owner's first complaint was "in home screen you see all the agents from
// all the projects, that is not right" — over the live state that is 3 projects,
// 11 orchestrators and 50 lanes in one flat tree. The first fix scoped home to
// one project behind an in-canvas dropdown, with a "hide retired agents" toggle
// beside it. The owner threw both controls out: "get rid of that hide retired
// agents and the dropdown picker thing you made, thats why we have the panel on
// the left".
//
// So this seeds TWO projects and asserts: `/` is a welcome with no graph; a
// project page draws its own work and none of the other project's; the sidebar
// lists both, marks the open one, and CROSSES OVER when you click the other; the
// scope is in the URL so a reload keeps it; a stale project id says so instead of
// silently showing a different project; and neither removed control exists
// anywhere on the page.
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

// ---- The projection still carries BOTH, and says where its state is ---------
const overview = await fetch(`${base}/api/overview`).then((response) => response.json());
check('projection.bothProjects', overview.projects.length === 2, overview.projects.map((p) => p.name));
// counts stay honest: what exists, beside what the projection carries.
check('projection.countsHonest', overview.counts.projects === 2 && overview.counts.shownProjects === 2, overview.counts);
// The welcome cannot say where the daemon's state is unless the projection does.
check('projection.namesItsStateDir', typeof overview.daemon?.stateDir === 'string' && overview.daemon.stateDir.length > 0, overview.daemon);

const first = overview.projects[0];
const other = overview.projects[1];

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })).newPage();

// ---- `/` is a welcome: both projects reachable, neither one drawn -----------
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(document.querySelector('.wel-wrap')), null, { timeout: 8000 }).catch(() => { /* asserted below */ });
const home = await page.evaluate(() => ({
  isWelcome: Boolean(document.querySelector('.wel-wrap')),
  nodes: document.querySelectorAll('.ov-node').length,
  sidebar: [...document.querySelectorAll('.sidebar-project')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
  sidebarSelected: document.querySelectorAll('.sidebar-project.is-selected').length,
}));
check('home.isTheWelcome', home.isWelcome);
check('home.drawsNoAgents', home.nodes === 0, home.nodes);
check('home.sidebarListsAll', home.sidebar.length === 2, home.sidebar);
check('home.nothingMarkedOpen', home.sidebarSelected === 0, home.sidebarSelected);

// ---- A project page: its own work, and only its -----------------------------
await page.goto(`${base}/#/project/${encodeURIComponent(first.id)}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('#ov-canvas .ov-node').length > 0, null, { timeout: 8000 })
  .catch(() => { /* asserted explicitly below */ });
const view = await page.evaluate(() => ({
  nodeTitles: [...document.querySelectorAll('.ov-node-title')].map((n) => n.textContent),
  scopeName: document.querySelector('.ov-scope-name')?.textContent || '',
  scopeNote: document.querySelector('.ov-scope-note')?.textContent || '',
  sidebarSelected: [...document.querySelectorAll('.sidebar-project.is-selected')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
  // Neither removed control may exist, in any state.
  hasDropdown: Boolean(document.querySelector('[data-canvas="projects"], .ov-projects, .ov-project-row, .ov-scope-btn')),
  hasRetiredToggle: Boolean(document.querySelector('[data-canvas="retired"], .ov-retired-btn')),
}));
check('project.showsItsOwnWork', view.nodeTitles.some((t) => t.toLowerCase().includes(first.name)), view.nodeTitles);
check('project.hidesTheOtherProject', !view.nodeTitles.some((t) => t.toLowerCase().includes(other.name)), view.nodeTitles);
check('project.namesItself', view.scopeName === first.name, view.scopeName);
check('project.reportsItsSize', /agent/.test(view.scopeNote) && /lane/.test(view.scopeNote), view.scopeNote);
check('project.noDropdownPicker', !view.hasDropdown);
check('project.noRetiredToggle', !view.hasRetiredToggle);
check('sidebar.marksTheOpenProject', view.sidebarSelected.length === 1 && view.sidebarSelected[0].includes(first.name), view.sidebarSelected);

// ---- The LEFT PANEL is the switcher, and it actually crosses over -----------
await page.click(`.sidebar-project[data-pid="${other.id}"]`);
await page.waitForFunction(
  (name) => document.querySelector('.ov-scope-name')?.textContent === name,
  other.name,
  { timeout: 5000 },
).catch(() => { /* asserted below */ });
const after = await page.evaluate(() => ({
  nodeTitles: [...document.querySelectorAll('.ov-node-title')].map((n) => n.textContent),
  scopeName: document.querySelector('.ov-scope-name')?.textContent || '',
  hash: location.hash,
  sidebarSelected: [...document.querySelectorAll('.sidebar-project.is-selected')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
}));
check('switch.scopeFollows', after.scopeName === other.name, after.scopeName);
check('switch.treeFollows', !after.nodeTitles.some((t) => t.toLowerCase().includes(first.name)), after.nodeTitles);
check('switch.sidebarFollows', after.sidebarSelected.length === 1 && after.sidebarSelected[0].includes(other.name), after.sidebarSelected);
// The URL IS the scope: bookmarkable, shareable, and it survives a reload. There
// is no remembered id in localStorage that could drift out of sync with it.
check('switch.urlIsTheScope', after.hash === `#/project/${encodeURIComponent(other.id)}`, after.hash);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction((name) => document.querySelector('.ov-scope-name')?.textContent === name, other.name, { timeout: 5000 }).catch(() => {});
const reloaded = await page.evaluate(() => ({
  scopeName: document.querySelector('.ov-scope-name')?.textContent || '',
  remembered: (() => { try { return localStorage.getItem('orca.project'); } catch { return null; } })(),
}));
check('reload.keepsTheProject', reloaded.scopeName === other.name, reloaded.scopeName);
check('reload.noSecondSourceOfTruth', reloaded.remembered === null, reloaded.remembered);

// ---- A stale link says so; it never shows a different project ---------------
await page.goto(`${base}/#/project/does-not-exist`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(document.querySelector('.ov-empty-title')), null, { timeout: 5000 }).catch(() => {});
const missing = await page.evaluate(() => ({
  title: document.querySelector('.ov-empty-title')?.textContent || '',
  sub: document.querySelector('.ov-empty-sub')?.textContent || '',
  nodes: document.querySelectorAll('.ov-node').length,
}));
check('stale.saysTheProjectIsGone', /not in Orca/i.test(missing.title), missing.title);
check('stale.pointsAtThePanel', /panel on the left/i.test(missing.sub), missing.sub);
check('stale.showsNoOtherProject', missing.nodes === 0, missing.nodes);

console.log(`[verify] project-scope: ${JSON.stringify({ ...results, _measured: { first: first.name, other: other.name, nodesOnProject: view.nodeTitles.length, note: view.scopeNote } }, null, 2)}`);
await browser.close();
server.close();
if (failed) { console.error('[verify] project-scope FAILED'); process.exit(1); }
console.log('[verify] project-scope OK');
process.exit(0);
