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
// A later pass put a HEADER LINE in the canvas in the dropdown's place
// ("realm-shaper \u00b7 1 agent \u00b7 0 lanes") and the owner threw that out too:
// "get rid of this i already told you, its bloat, thats the whole point of whats
// below it and the panel already shows what project you are working in." So the
// panel and the topbar are now the only places a project is NAMED — and the name
// in the panel is where it is RENAMED ("the project name in the panel needs to be
// renamable").
//
// So this seeds TWO projects and asserts: `/` is a welcome with no graph; a
// project page draws its own work and none of the other project's; the sidebar
// lists both, marks the open one, and CROSSES OVER when you click the other; the
// scope is in the URL so a reload keeps it; a stale project id says so instead of
// silently showing a different project; the panel renames a project without
// moving its identity; every count agrees with its noun; and none of the three
// removed controls (dropdown, retired toggle, header line) exists anywhere.
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
  topbar: document.getElementById('topbar-title')?.textContent || '',
  sidebarSelected: [...document.querySelectorAll('.sidebar-project.is-selected')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
  // Neither removed control may exist, in any state.
  hasDropdown: Boolean(document.querySelector('[data-canvas="projects"], .ov-projects, .ov-project-row, .ov-scope-btn')),
  hasRetiredToggle: Boolean(document.querySelector('[data-canvas="retired"], .ov-retired-btn')),
  // Nor the header line that replaced the dropdown. The owner, with a
  // screenshot of "realm-shaper \u00b7 1 agent \u00b7 0 lanes": "get rid of this i
  // already told you, its bloat, thats the whole point of whats below it and the
  // panel already shows what project you are working in."
  hasCanvasHeader: Boolean(document.querySelector('.ov-scope, .ov-scope-name, .ov-scope-note')),
}));
check('project.showsItsOwnWork', view.nodeTitles.some((t) => t.toLowerCase().includes(first.name)), view.nodeTitles);
check('project.hidesTheOtherProject', !view.nodeTitles.some((t) => t.toLowerCase().includes(other.name)), view.nodeTitles);
check('project.namedByTheTopbar', view.topbar === first.name, view.topbar);
check('project.noCanvasHeaderLine', !view.hasCanvasHeader);
check('project.noDropdownPicker', !view.hasDropdown);
check('project.noRetiredToggle', !view.hasRetiredToggle);
check('sidebar.marksTheOpenProject', view.sidebarSelected.length === 1 && view.sidebarSelected[0].includes(first.name), view.sidebarSelected);

// ---- The LEFT PANEL is the switcher, and it actually crosses over -----------
await page.click(`.sidebar-project[data-pid="${other.id}"]`);
await page.waitForFunction(
  (name) => document.getElementById('topbar-title')?.textContent === name,
  other.name,
  { timeout: 5000 },
).catch(() => { /* asserted below */ });
const after = await page.evaluate(() => ({
  nodeTitles: [...document.querySelectorAll('.ov-node-title')].map((n) => n.textContent),
  topbar: document.getElementById('topbar-title')?.textContent || '',
  hash: location.hash,
  sidebarSelected: [...document.querySelectorAll('.sidebar-project.is-selected')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
}));
check('switch.scopeFollows', after.topbar === other.name, after.topbar);
check('switch.treeFollows', !after.nodeTitles.some((t) => t.toLowerCase().includes(first.name)), after.nodeTitles);
check('switch.sidebarFollows', after.sidebarSelected.length === 1 && after.sidebarSelected[0].includes(other.name), after.sidebarSelected);
// The URL IS the scope: bookmarkable, shareable, and it survives a reload. There
// is no remembered id in localStorage that could drift out of sync with it.
check('switch.urlIsTheScope', after.hash === `#/project/${encodeURIComponent(other.id)}`, after.hash);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction((name) => document.getElementById('topbar-title')?.textContent === name, other.name, { timeout: 5000 }).catch(() => {});
const reloaded = await page.evaluate(() => ({
  topbar: document.getElementById('topbar-title')?.textContent || '',
  remembered: (() => { try { return localStorage.getItem('orca.project'); } catch { return null; } })(),
}));
check('reload.keepsTheProject', reloaded.topbar === other.name, reloaded.topbar);
check('reload.noSecondSourceOfTruth', reloaded.remembered === null, reloaded.remembered);

// ---- The project name in the PANEL is renameable ----------------------------
// The owner: "the project name in the panel needs to be renamable" \u2014 and,
// separately, "i think in orca we should be able to rename the projects, and so
// can the orch agents, like for example since you know we are working on truss
// engine you could name it truss engine". A project was called whatever its
// folder was called, with no way to say otherwise. This is the operator's half;
// an orchestrator agent reaches the same capability over MCP as project.rename.
//
// It must change the DISPLAY NAME and nothing else: identity is realpath(cwd),
// so the id, the folder and the lanes all stay where they were.
const RENAMED = 'Truss Engine';
const beforeRename = await page.evaluate((id) => ({
  hasRenameControl: Boolean(document.querySelector(`[data-rename="${id}"]`)),
  editorOpen: Boolean(document.querySelector('.sidebar-project-edit')),
  onEveryRow: document.querySelectorAll('.sidebar-rename-btn').length,
  rows: document.querySelectorAll('.sidebar-project').length,
}), other.id);
check('rename.controlIsInThePanel', beforeRename.hasRenameControl);
check('rename.onEveryProjectRow', beforeRename.onEveryRow === beforeRename.rows, beforeRename);
check('rename.startsClosed', !beforeRename.editorOpen);

await page.click(`[data-rename="${other.id}"]`);
await page.waitForSelector('#sidebar-rename-input', { timeout: 5000 }).catch(() => { /* asserted below */ });
const opened = await page.evaluate(() => ({
  value: document.getElementById('sidebar-rename-input')?.value ?? null,
  focused: document.activeElement?.id === 'sidebar-rename-input',
  hash: location.hash,
}));
check('rename.opensWithTheCurrentName', opened.value === other.name, opened.value);
check('rename.focusesTheField', opened.focused);
// Opening the editor is not navigation: the pencil must not double as the switcher.
check('rename.openingIsNotASwitch', opened.hash === `#/project/${encodeURIComponent(other.id)}`, opened.hash);

await page.fill('#sidebar-rename-input', RENAMED);
await page.click(`[data-rename-save="${other.id}"]`);
// No reload: the 2s poll picks the new name up from /api/overview, which it can
// only do if the write reached the registry AND bumped what the dashboard diffs.
await page.waitForFunction(
  (name) => [...document.querySelectorAll('.sidebar-project')].some((n) => n.textContent.includes(name)),
  RENAMED,
  { timeout: 8000 },
).catch(() => { /* asserted below */ });
const renamed = await page.evaluate(() => ({
  sidebar: [...document.querySelectorAll('.sidebar-project')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
  topbar: document.getElementById('topbar-title')?.textContent || '',
  editorOpen: Boolean(document.querySelector('.sidebar-project-edit')),
  nodes: document.querySelectorAll('.ov-node').length,
}));
check('rename.panelShowsTheNewName', renamed.sidebar.some((row) => row.includes(RENAMED)), renamed.sidebar);
check('rename.topbarFollowsWithoutAReload', renamed.topbar === RENAMED, renamed.topbar);
check('rename.editorClosesOnSave', !renamed.editorOpen);
check('rename.keepsTheAgentsItHad', renamed.nodes > 0, renamed.nodes);

// Identity did NOT move: same id, same cwd, same lanes, one project \u2014 and the
// OTHER project is untouched.
const afterRename = await fetch(`${base}/api/overview`).then((r) => r.json());
const renamedProject = afterRename.projects.find((p) => p.id === other.id);
check('rename.sameProjectId', Boolean(renamedProject), afterRename.projects.map((p) => p.id));
check('rename.identityIsStillTheCwd', renamedProject?.cwd === other.cwd, { was: other.cwd, now: renamedProject?.cwd });
check('rename.didNotSplitTheProject', afterRename.projects.length === 2, afterRename.projects.length);
check('rename.keptItsLanes', renamedProject?.executorCount === 1, renamedProject?.executorCount);
check(
  'rename.leftTheOtherProjectAlone',
  afterRename.projects.find((p) => p.id === first.id)?.name === first.name,
  afterRename.projects.find((p) => p.id === first.id)?.name,
);
check('rename.didNotNavigate', (await page.evaluate(() => location.hash)) === `#/project/${encodeURIComponent(other.id)}`);

// Escape abandons an edit rather than committing it.
await page.click(`[data-rename="${other.id}"]`);
await page.waitForSelector('#sidebar-rename-input', { timeout: 5000 }).catch(() => {});
await page.fill('#sidebar-rename-input', 'Discarded');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.getElementById('sidebar-rename-input'), null, { timeout: 5000 }).catch(() => {});
const cancelled = await page.evaluate(() => [...document.querySelectorAll('.sidebar-project')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
check('rename.escapeDiscardsTheEdit', cancelled.some((row) => row.includes(RENAMED)) && !cancelled.some((row) => row.includes('Discarded')), cancelled);

// ---- Counts agree with their nouns ("if there is 1 it needs to be agent") ----
// Every project here holds exactly one lane and one agent, which is the case that
// used to read "1 lanes" / "1 agents".
const singulars = await page.evaluate(() => ({
  sidebarTitles: [...document.querySelectorAll('.sidebar-count')].map((n) => n.getAttribute('title') || ''),
  nodeSubs: [...document.querySelectorAll('.ov-node-sub')].map((n) => n.textContent || ''),
  bodyText: document.body.innerText,
}));
const plurals = /\b1 (agents|lanes|projects|devices|mins|hours|days)\b/;
check('plural.noOneAgents', !plurals.test(singulars.bodyText), (singulars.bodyText.match(plurals) || [])[0]);
check('plural.noOneAgentsInTooltips', !singulars.sidebarTitles.some((t) => plurals.test(t)), singulars.sidebarTitles);
check('plural.noOneAgentsOnNodes', !singulars.nodeSubs.some((t) => plurals.test(t)), singulars.nodeSubs);
check('plural.sidebarTooltipReadsSingular', singulars.sidebarTitles.some((t) => /\b1 lane\b/.test(t)), singulars.sidebarTitles);

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

console.log(`[verify] project-scope: ${JSON.stringify({ ...results, _measured: { first: first.name, other: other.name, renamedTo: RENAMED, nodesOnProject: view.nodeTitles.length } }, null, 2)}`);
await browser.close();
server.close();
if (failed) { console.error('[verify] project-scope FAILED'); process.exit(1); }
console.log('[verify] project-scope OK');
process.exit(0);
