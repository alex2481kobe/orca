// The home screen's scoping rules, as pure functions so they can be tested at
// all. public/ui/overview.js touches `document` at import time and cannot be
// loaded under node, so the two decisions that decide WHAT HOME SHOWS live in
// public/ui/scope.js instead, and are covered here.
//
// The owner's complaint: "in home screen you see all the agents from all the
// projects, that is not right". Over the live shape that was 3 projects, 11
// orchestrators and 50 lanes on one screen. Home now opens on ONE project.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chooseProjectId, partitionProject, otherProjectCount, hasLiveWork } from '../public/ui/scope.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const project = (id, extra = {}) => ({
  id, name: id, orchestrators: [], orchestratorCount: 0, executorCount: 0, liveExecutorCount: 0, ...extra,
});

test('home opens on the project the projection nominated', () => {
  const data = { projects: [project('p1'), project('p2')], defaultProjectId: 'p2' };
  assert.equal(chooseProjectId(data), 'p2');
});

test('an explicit pick beats the nomination, and this browser remembers it', () => {
  const data = { projects: [project('p1'), project('p2')], defaultProjectId: 'p2' };
  assert.equal(chooseProjectId(data, { selected: 'p1' }), 'p1', 'switching projects is the user’s call, not the server’s');
  assert.equal(chooseProjectId(data, { remembered: 'p1' }), 'p1');
  assert.equal(chooseProjectId(data, { selected: 'p1', remembered: 'p2' }), 'p1', 'this session’s pick beats the remembered one');
});

test('a project id that no longer exists can never scope home to nothing', () => {
  const data = { projects: [project('p1'), project('p2')], defaultProjectId: 'p2' };
  // A remembered project that was archived or renamed away, and a nomination
  // that does not resolve, both fall through to something real. This is the
  // guard against re-creating the "state full of work renders as nothing" bug
  // from the other side: presentation.
  assert.equal(chooseProjectId(data, { remembered: 'gone' }), 'p2');
  assert.equal(chooseProjectId({ projects: [project('p1')], defaultProjectId: 'gone' }), 'p1');
  assert.equal(chooseProjectId({ projects: [project('p1')] }), 'p1', 'no nomination at all still picks a real project');
});

test('with no projects at all home scopes to nothing, and says so with null', () => {
  assert.equal(chooseProjectId({ projects: [] }), null);
  assert.equal(chooseProjectId({}), null);
  assert.equal(chooseProjectId(null), null);
});

test('otherProjectCount counts what switching would reach', () => {
  const data = { projects: [project('p1'), project('p2'), project('p3')] };
  assert.equal(otherProjectCount(data, 'p1'), 2);
  assert.equal(otherProjectCount(data, null), 3);
  assert.equal(otherProjectCount({ projects: [project('p1')] }, 'p1'), 0);
});

// ---------------------------------------------------------------------------
// Retired work inside the chosen project.
// ---------------------------------------------------------------------------

const live = { id: 'lane-live', terminal: false, recent: true };
const justDone = { id: 'lane-fresh', terminal: true, recent: true };
const longDone = { id: 'lane-old', terminal: true, recent: false };

test('retired lanes are collapsed behind a count, live ones are always drawn', () => {
  const p = project('p1', {
    liveExecutorCount: 1, liveOrchestratorCount: 1,
    orchestrators: [{
      id: 'o1', inactive: false, retired: false,
      executors: [live, justDone, longDone],
      executorCount: 3, liveExecutorCount: 1, retiredExecutorCount: 1, executorsOmitted: 0,
    }],
  });
  const collapsed = partitionProject(p);
  assert.deepEqual(collapsed.orchestrators[0].executors.map((e) => e.id), ['lane-live', 'lane-fresh']);
  assert.equal(collapsed.retiredExecutorCount, 1);
  assert.equal(collapsed.hiddenCount, 1, 'what is not drawn is counted, never silently dropped');

  const expanded = partitionProject(p, { showRetired: true });
  assert.equal(expanded.orchestrators[0].executors.length, 3);
  assert.equal(expanded.hiddenCount, 0);
});

test('a fully retired orchestrator collapses whole, with its lanes counted', () => {
  const p = project('p1', {
    liveExecutorCount: 1, liveOrchestratorCount: 1,
    orchestrators: [
      { id: 'live-orc', inactive: false, retired: false, executors: [live], executorCount: 1, liveExecutorCount: 1, retiredExecutorCount: 0, executorsOmitted: 0 },
      { id: 'dead-orc', inactive: true, retired: true, executors: [longDone, longDone], executorCount: 2, liveExecutorCount: 0, retiredExecutorCount: 2, executorsOmitted: 0 },
    ],
  });
  const collapsed = partitionProject(p);
  assert.deepEqual(collapsed.orchestrators.map((o) => o.id), ['live-orc']);
  assert.equal(collapsed.retiredOrchestratorCount, 1);
  assert.equal(collapsed.retiredExecutorCount, 2, 'the retired agent’s lanes are counted, not forgotten');
  assert.equal(collapsed.hiddenCount, 3);
  assert.deepEqual(partitionProject(p, { showRetired: true }).orchestrators.map((o) => o.id), ['live-orc', 'dead-orc']);
});

test('an inactive orchestrator that still runs a live lane is never collapsed', () => {
  // `retired` is inactive AND nothing live left. A stale orchestrator whose lane
  // is still running is exactly the case the old projection used to delete.
  const p = project('p1', {
    liveExecutorCount: 1,
    orchestrators: [{
      id: 'o1', inactive: true, retired: false,
      executors: [live], executorCount: 1, liveExecutorCount: 1, retiredExecutorCount: 0, executorsOmitted: 0,
    }],
  });
  assert.deepEqual(partitionProject(p).orchestrators.map((o) => o.id), ['o1']);
  assert.equal(partitionProject(p).hiddenCount, 0);
});

test('the projection’s own executorsOmitted is folded into what is not shown', () => {
  const p = project('p1', {
    liveExecutorCount: 1, liveOrchestratorCount: 1,
    orchestrators: [{
      id: 'o1', inactive: false, retired: false,
      executors: [live], executorCount: 40, liveExecutorCount: 1, retiredExecutorCount: 0, executorsOmitted: 15,
    }],
  });
  const out = partitionProject(p);
  assert.equal(out.omittedExecutorCount, 15);
  assert.equal(out.hiddenCount, 15, 'the per-orchestrator window and the retired collapse count together');
});

test('an empty project stays an empty project, not an empty dashboard', () => {
  const out = partitionProject(project('p1'));
  assert.deepEqual(out.orchestrators, []);
  assert.equal(out.hiddenCount, 0);
  assert.equal(out.retiredOrchestratorCount, 0);
  // A project with agents that are ALL retired must not read the same as a
  // project with no agents: the count is what tells them apart.
  const allRetired = partitionProject(project('p2', {
    orchestrators: [{ id: 'o1', inactive: true, retired: true, executors: [], executorCount: 0, liveExecutorCount: 0, retiredExecutorCount: 0, executorsOmitted: 0 }],
  }), { showRetired: false });
  assert.deepEqual(allRetired.orchestrators, []);
  assert.equal(allRetired.retiredOrchestratorCount, 1);
  assert.equal(allRetired.hiddenCount, 1);
});

// This is the guard against fixing the owner's complaint by re-creating
// yesterday's bug. Over the live state NOTHING has run for hours, so every agent
// and every lane is retired; an unconditional collapse would draw an empty canvas
// over a project holding 11 finished lanes.
test('with no live work the collapse turns itself off rather than emptying the screen', () => {
  const deadProject = project('p1', {
    liveExecutorCount: 0, liveOrchestratorCount: 0, orchestratorCount: 2, executorCount: 3,
    orchestrators: [
      { id: 'o1', inactive: true, retired: true, executors: [longDone, longDone], executorCount: 2, liveExecutorCount: 0, retiredExecutorCount: 2, executorsOmitted: 0 },
      { id: 'o2', inactive: true, retired: true, executors: [longDone], executorCount: 1, liveExecutorCount: 0, retiredExecutorCount: 1, executorsOmitted: 0 },
    ],
  });
  assert.equal(hasLiveWork(deadProject), false);
  const auto = partitionProject(deadProject);
  assert.equal(auto.collapsingRetired, false, 'nothing live means nothing for the collapse to protect');
  assert.deepEqual(auto.orchestrators.map((o) => o.id), ['o1', 'o2'], 'the finished work IS the work; it must be drawn');
  assert.equal(auto.hiddenCount, 0, 'and nothing is claimed to be hidden');
  // The counts still describe the project truthfully while it is expanded.
  assert.equal(auto.retiredOrchestratorCount, 2);

  // One live lane appears: now retired work has something to crowd out, so it
  // collapses of its own accord.
  const busy = { ...deadProject, liveExecutorCount: 1 };
  const collapsed = partitionProject(busy);
  assert.equal(collapsed.collapsingRetired, true);
  assert.deepEqual(collapsed.orchestrators, []);
  assert.equal(collapsed.hiddenCount, 5);

  // The viewer's explicit toggle still wins over AUTO in both directions.
  assert.equal(partitionProject(deadProject, { showRetired: false }).collapsingRetired, true);
  assert.equal(partitionProject(busy, { showRetired: true }).collapsingRetired, false);
});

test('partitionProject tolerates a missing/!malformed project without throwing', () => {
  for (const bad of [null, undefined, {}, { orchestrators: null }]) {
    const out = partitionProject(bad);
    assert.deepEqual(out.orchestrators, []);
    assert.equal(out.hiddenCount, 0);
  }
});

// ---------------------------------------------------------------------------
// Source guards: the dashboard must actually USE these rules, and the service
// worker must precache the new module (a missed entry poisons offline install —
// scripts/pwa-cache-smoke.mjs checks the same coupling).
// ---------------------------------------------------------------------------

test('the dashboard scopes home through scope.js rather than showing every project', () => {
  const ui = fs.readFileSync(path.join(here, '..', 'public', 'ui', 'overview.js'), 'utf8');
  assert.match(ui, /from '\.\/scope\.js'/, 'overview.js imports the scope rules');
  assert.match(ui, /chooseProjectId\(/, 'and picks its project with them');
  assert.match(ui, /partitionProject\(/, 'and collapses retired work with them');
});

test('service-worker precaches the scope module', () => {
  const sw = fs.readFileSync(path.join(here, '..', 'public', 'service-worker.js'), 'utf8');
  assert.match(sw, /'\/ui\/scope\.js'/, 'a public/ui module missing from STATIC_ASSETS breaks offline install');
});
