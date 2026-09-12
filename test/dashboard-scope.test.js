// What a PROJECT page draws, as pure functions so they can be tested at all.
// public/ui/overview.js touches `document` at import time and cannot be loaded
// under node, so the decisions live in public/ui/scope.js instead.
//
// The owner's first complaint: "in home screen you see all the agents from all
// the projects, that is not right" — over the live shape that was 3 projects,
// 11 orchestrators and 50 lanes on one screen. The fix for that added an
// in-canvas project dropdown and a "hide retired agents" collapse, and the owner
// threw both out the same day: "the home page should just show the welcome
// essentially, and then the projects themselves can show what is running, get
// rid of that hide retired agents and the dropdown picker thing you made, thats
// why we have the panel on the left".
//
// So the tests below cover a DIFFERENT contract from the one that stood this
// morning. `chooseProjectId`, `partitionProject`, `otherProjectCount` and
// `hasLiveWork` are gone with the two controls they existed to drive — a test
// left asserting a collapse the screen can no longer perform would be asserting
// nothing about the product. What replaces them: a project page is an ADDRESS,
// and it draws EVERY agent it has.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProject, projectView, PROJECT_LANE_WINDOW } from '../public/ui/scope.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const project = (id, extra = {}) => ({
  id, name: id, orchestrators: [], orchestratorCount: 0, executorCount: 0, liveExecutorCount: 0, ...extra,
});
const agent = (id, executors, extra = {}) => ({
  id, inactive: false, retired: false, executorsOmitted: 0, executors, ...extra,
});
const live = (id) => ({ id, terminal: false, recent: true });
const justDone = (id) => ({ id, terminal: true, recent: true });
const longDone = (id) => ({ id, terminal: true, recent: false });

// ---------------------------------------------------------------------------
// resolveProject: the URL is the scope.
// ---------------------------------------------------------------------------

test('a project route resolves to exactly the project it names', () => {
  const data = { projects: [project('p1'), project('p2')] };
  assert.equal(resolveProject(data, 'p2').project.id, 'p2');
  assert.equal(resolveProject(data, 'p2').missing, false);
});

test('a route naming a project that is gone says so — it never shows a different one', () => {
  // Home is a welcome now, so there is nothing to "fall back" to, and quietly
  // serving project p1 under p2's URL would be worse than saying the id is gone.
  const data = { projects: [project('p1'), project('p2')] };
  const gone = resolveProject(data, 'archived-yesterday');
  assert.equal(gone.project, null);
  assert.equal(gone.missing, true);
});

test('no project in the route, and no projects at all, are different things', () => {
  assert.deepEqual(resolveProject({ projects: [project('p1')] }, ''), { project: null, missing: false });
  assert.deepEqual(resolveProject({ projects: [] }, 'p1'), { project: null, missing: true });
  assert.deepEqual(resolveProject(null, 'p1'), { project: null, missing: true });
  assert.deepEqual(resolveProject(null, null), { project: null, missing: false });
});

// ---------------------------------------------------------------------------
// projectView: what a project page draws.
//
// The governing property, and the reason there is no toggle: NO AGENT IS EVER
// DROPPED. Only older FINISHED lanes are bounded, per agent, and counted.
// ---------------------------------------------------------------------------

test('every agent of the project is drawn — retired ones included', () => {
  const p = project('p1', {
    orchestrators: [
      agent('busy', [live('l1')], { liveExecutorCount: 1 }),
      agent('finished', [longDone('l2'), longDone('l3')], { inactive: true, retired: true }),
      agent('stale-but-working', [live('l4')], { inactive: true, retired: false }),
    ],
  });
  const view = projectView(p);
  assert.deepEqual(view.orchestrators.map((o) => o.id), ['busy', 'finished', 'stale-but-working']);
  assert.equal(view.retiredOrchestratorCount, 1, 'retired is counted, never a reason to remove a row');
  assert.equal(view.olderExecutorCount, 0, 'and nothing is claimed to be hidden');
  assert.equal(view.shownExecutorCount, 4);
});

test('live lanes are never bounded, however many an agent is running', () => {
  const many = Array.from({ length: PROJECT_LANE_WINDOW + 12 }, (_, i) => live(`live-${i}`));
  const view = projectView(project('p1', { orchestrators: [agent('o1', many)] }));
  assert.equal(view.orchestrators[0].executors.length, many.length);
  assert.equal(view.olderExecutorCount, 0);
});

test('older FINISHED lanes past the per-agent window are counted, on the agent and on the project', () => {
  const finished = Array.from({ length: 20 }, (_, i) => longDone(`old-${i}`));
  const p = project('p1', { orchestrators: [agent('o1', [live('running'), ...finished])] });
  const view = projectView(p, { laneWindow: 5 });

  assert.deepEqual(
    view.orchestrators[0].executors.map((e) => e.id),
    ['running', 'old-0', 'old-1', 'old-2', 'old-3', 'old-4'],
    'every live lane, then the newest finished ones — the projection already sorted them',
  );
  assert.equal(view.orchestrators[0].olderExecutorCount, 15, 'the agent node can say how much it is not showing');
  assert.equal(view.olderExecutorCount, 15);
  assert.equal(view.shownExecutorCount, 6);
  assert.equal(view.totalExecutorCount, 21);
});

test('the bound is PER AGENT, so one noisy agent cannot crowd out the one beside it', () => {
  // This is the whole answer to "retired work must not swamp a project page".
  const noisy = agent('noisy', Array.from({ length: 40 }, (_, i) => longDone(`n-${i}`)));
  const quiet = agent('quiet', [longDone('q-0'), longDone('q-1')]);
  const view = projectView(project('p1', { orchestrators: [noisy, quiet] }), { laneWindow: 4 });
  assert.equal(view.orchestrators[0].executors.length, 4);
  assert.equal(view.orchestrators[1].executors.length, 2, 'the quiet agent still shows everything it has');
  assert.equal(view.olderExecutorCount, 36);
});

test('the projection’s own executorsOmitted is folded into the same number', () => {
  // src/registry-overview.js already bounds what it SENDS per orchestrator.
  // Counting it separately would under-report what the canvas is not drawing.
  const p = project('p1', {
    orchestrators: [agent('o1', [live('l1'), longDone('l2')], { executorsOmitted: 15 })],
  });
  const view = projectView(p, { laneWindow: 8 });
  assert.equal(view.orchestrators[0].olderExecutorCount, 15);
  assert.equal(view.olderExecutorCount, 15);
  assert.equal(view.totalExecutorCount, 17);
});

// This is the guard against fixing one complaint by re-creating yesterday's bug.
// Over the live state nothing had run for hours, so every agent and every lane
// was retired; the collapse this replaces had to special-case that or it drew an
// empty canvas over a project holding 11 finished lanes. A window has no such
// failure mode: it is filled with the most recent lanes whether or not anything
// is running.
test('a project where nothing has run for hours still draws its finished work', () => {
  const dead = project('p1', {
    liveExecutorCount: 0,
    orchestrators: [
      agent('o1', [longDone('a'), longDone('b')], { inactive: true, retired: true }),
      agent('o2', [longDone('c')], { inactive: true, retired: true }),
    ],
  });
  const view = projectView(dead);
  assert.deepEqual(view.orchestrators.map((o) => o.id), ['o1', 'o2'], 'the finished work IS the work; it must be drawn');
  assert.equal(view.shownExecutorCount, 3);
  assert.equal(view.olderExecutorCount, 0, 'and nothing is claimed to be hidden');
  assert.equal(view.retiredOrchestratorCount, 2, 'while the counts still describe the project truthfully');
});

test('a mix of fresh and long-finished lanes is not treated as two different things', () => {
  // The old collapse split on `recent`; the window does not care how old a
  // finished lane is, only how many an agent has. One rule, not two.
  const p = project('p1', { orchestrators: [agent('o1', [live('x'), justDone('y'), longDone('z')])] });
  const view = projectView(p);
  assert.deepEqual(view.orchestrators[0].executors.map((e) => e.id), ['x', 'y', 'z']);
  assert.equal(view.olderExecutorCount, 0);
});

test('an empty project stays an empty project, not an empty dashboard', () => {
  const view = projectView(project('p1'));
  assert.deepEqual(view.orchestrators, []);
  assert.equal(view.olderExecutorCount, 0);
  assert.equal(view.totalExecutorCount, 0);
  assert.equal(view.orchestratorCount, 0);
});

test('projectView tolerates a missing/malformed project without throwing', () => {
  for (const bad of [null, undefined, {}, { orchestrators: null }, { orchestrators: [{ id: 'o' }] }]) {
    const view = projectView(bad);
    assert.ok(Array.isArray(view.orchestrators));
    assert.equal(view.olderExecutorCount, 0);
  }
  // A nonsense window is clamped, never NaN'd into slicing nothing away.
  assert.equal(
    projectView(project('p1', { orchestrators: [agent('o', [longDone('a')])] }), { laneWindow: 'x' })
      .orchestrators[0].executors.length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Source guards: the dashboard must actually USE these rules, the service worker
// must precache the module (a missed entry poisons offline install —
// scripts/pwa-cache-smoke.mjs checks the same coupling), and the two controls
// the owner removed must not creep back in.
// ---------------------------------------------------------------------------

const ui = () => fs.readFileSync(path.join(here, '..', 'public', 'ui', 'overview.js'), 'utf8');

test('the dashboard draws a project through scope.js rather than inventing its own rules', () => {
  const source = ui();
  assert.match(source, /from '\.\/scope\.js'/, 'overview.js imports the scope rules');
  assert.match(source, /resolveProject\(/, 'and resolves the routed project with them');
  assert.match(source, /projectView\(/, 'and lays the project out with them');
});

test('home is a WELCOME and a project is its own route', () => {
  const source = ui();
  assert.match(source, /function renderWelcome\(/, 'home renders a welcome');
  assert.match(source, /function renderProject\(/, 'a project page is its own screen');
  assert.doesNotMatch(source, /function renderHome\(/, 'the old "home is a project graph" screen is gone');
  assert.match(source, /const PROJECT_ROUTE = 'project\//, 'the project page has a real address');
});

test('the project dropdown and the hide-retired toggle are gone, not just unstyled', () => {
  const source = ui();
  const css = fs.readFileSync(path.join(here, '..', 'public', 'ui', 'overview.css'), 'utf8');
  for (const dead of ['data-pick-project', 'ov-project-row', 'data-canvas="projects"', 'ov-retired-btn', 'showRetired', 'ov-scope-btn']) {
    assert.equal(source.includes(dead), false, `overview.js still references the removed control ${dead}`);
    assert.equal(css.includes(dead), false, `overview.css still styles the removed control ${dead}`);
  }
  assert.equal(
    source.includes("localStorage.getItem('orca.project')"),
    false,
    'the URL is the scope now; a remembered project id would be a second source of truth',
  );
});

test('the welcome does not smuggle the agent graph back in', () => {
  // "it must not become a dashboard by another name": the welcome may not build
  // the canvas or draw nodes. It reports counts and points at the left panel.
  const source = ui();
  const welcome = source.slice(source.indexOf('function renderWelcome('), source.indexOf('function renderProject('));
  assert.ok(welcome.length > 200, 'the slice must actually contain the welcome');
  for (const dashboardish of ['buildCanvas(', 'buildForest(', 'renderStats(', 'nodeCard(', 'layoutForest(']) {
    assert.equal(welcome.includes(dashboardish), false, `the welcome must not call ${dashboardish}`);
  }
  assert.match(welcome, /panel on the left/, 'and it must point at the one switcher');
});

test('service-worker precaches the scope module', () => {
  const sw = fs.readFileSync(path.join(here, '..', 'public', 'service-worker.js'), 'utf8');
  assert.match(sw, /'\/ui\/scope\.js'/, 'a public/ui module missing from STATIC_ASSETS breaks offline install');
});
