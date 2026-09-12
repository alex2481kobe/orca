// REGISTRATION MUST SURVIVE A RESTART.
//
// Reproduced by hand on the live daemon (main @ 5e4f9d1, freshly wiped state):
//
//   POST /api/orchestrators {cwd, actor, title, focus, laneConcurrencyLimit}
//     -> 200, orc_fa2c4976-…, source "dashboard", leaseId "dashboard"
//   GET  /api/health              -> {"projects":1,"orchestrators":1,…}
//   .orca/state.json (2s later)   -> projects: 0, orchestrators: 0
//
// The record existed in memory, /api/health counted it, and it was gone on the
// next restart. `toolLeases` in the SAME file had persisted, so the state store
// was fine — the register path simply never asked it to write.
//
// The cause is that registerOrchestrator (and _findOrCreateProject under it)
// returns without calling persistState, so nothing is ever scheduled. That makes
// the loss INTERMITTENT rather than total: a write another call scheduled a
// moment earlier snapshots at FLUSH time, so it happens to carry the brand-new
// orchestrator to disk. On the live daemon the lease write had long since
// settled, so the registration had no ride and was lost.
//
// Every fixture below therefore QUIESCES the store (drains every pending write)
// before it registers. Without that, this file would pass over the bug.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OrcaRegistry } from '../src/registry.js';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';

async function tempRoot(label) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `orca-reg-persist-${label}-`)));
}

function openRegistry(stateDir) {
  return new OrcaRegistry({
    stateDir,
    autoAudit: false,
    // Keep the heartbeat out of the way: nothing here runs a lane, and a tick
    // that persisted on its own would mask exactly what is under test.
    heartbeatIntervalMs: 60_000,
  });
}

async function closeRegistry(registry) {
  registry.stopScheduler();
  await registry.drainPendingWrites();
}

// A fixture that is honest about the bug: the store is empty of pending writes
// at the moment the registration happens, so the ONLY thing that can put the
// registration on disk is the registration itself.
async function quiesce(registry) {
  registry.stopScheduler();
  await registry.drainPendingWrites();
  assert.equal(registry._persistTimer, null, 'fixture precondition: no write is pending before the registration');
}

test('an orchestrator registration survives a restart', { timeout: 30_000 }, async () => {
  const tmp = await tempRoot('restart');
  const project = path.join(tmp, 'project');
  const stateDir = path.join(tmp, 'state');
  await fs.mkdir(project);
  approveFixtureRoot(project);

  const registry = openRegistry(stateDir);
  let reloaded = null;
  try {
    const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'claude-code' });
    await quiesce(registry);

    const orchestrator = await registry.registerOrchestrator(
      { cwd: project, actor: 'claude-code', title: 'Truss engine', focus: 'persistence', laneConcurrencyLimit: 3 },
      { leaseId: lease.id },
    );

    // Exactly what a clean shutdown does: flush a PENDING persist, then wait for
    // the write. It flushes nothing when nothing was scheduled.
    await closeRegistry(registry);

    const onDisk = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'));
    assert.equal(
      onDisk.orchestrators?.length,
      1,
      'the registration reached state.json — /api/health counting it in memory is not the same as it existing',
    );
    assert.equal(onDisk.projects?.length, 1, 'the project the registration created reached state.json too');

    // The restart. A second registry over the SAME state directory is what the
    // daemon does when it comes back up.
    reloaded = openRegistry(stateDir);
    const restored = reloaded.orchestrators.find((item) => item.id === orchestrator.id);
    assert.ok(restored, 'the orchestrator is there after a restart');
    assert.equal(restored.title, 'Truss engine');
    assert.equal(restored.focus, 'persistence');
    assert.equal(restored.leaseId, lease.id);
    assert.equal(restored.approvedCapacity, 3, 'the capacity it registered with is restored, not the default');

    const restoredProject = reloaded.projects.find((item) => item.id === orchestrator.projectId);
    assert.ok(restoredProject, 'the implicitly created project is there after a restart');
    assert.equal(restoredProject.cwd, project, 'the project is still keyed by realpath(cwd)');

    // The dashboard reads /api/overview, and a restart it cannot see is the
    // symptom the owner actually hit: he registered, restarted, and the
    // dashboard was empty.
    const overview = reloaded.buildOverview();
    assert.equal(overview.counts.projects, 1);
    assert.equal(overview.counts.orchestrators, 1);
    assert.equal(overview.projects[0].orchestrators[0].title, 'Truss engine');
  } finally {
    await closeRegistry(registry);
    if (reloaded) await closeRegistry(reloaded);
    restoreFixtureRoot();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('a registration over the operator API (no lease) persists too — it is not a throwaway record', { timeout: 30_000 }, async () => {
  // The live repro registered with leaseId "dashboard" and source "dashboard":
  // the pseudo-lease every token/operator-authed caller gets over loopback. If
  // that were DELIBERATELY ephemeral the API would have to say so instead of
  // answering a clean 200 — nothing in the tree says it is, so it must stick.
  const tmp = await tempRoot('dashboard');
  const project = path.join(tmp, 'project');
  const stateDir = path.join(tmp, 'state');
  await fs.mkdir(project);
  approveFixtureRoot(project);

  const registry = openRegistry(stateDir);
  let reloaded = null;
  try {
    await quiesce(registry);
    const orchestrator = await registry.registerOrchestrator(
      { cwd: project, actor: 'operator', title: 'From the dashboard' },
      { leaseId: 'dashboard', source: 'dashboard' },
    );
    await closeRegistry(registry);

    reloaded = openRegistry(stateDir);
    const restored = reloaded.orchestrators.find((item) => item.id === orchestrator.id);
    assert.ok(restored, 'a source:"dashboard" registration survives a restart like any other');
    assert.equal(restored.source, 'dashboard');
  } finally {
    await closeRegistry(registry);
    if (reloaded) await closeRegistry(reloaded);
    restoreFixtureRoot();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('the register path leaves an audit trail, and the refresh/takeover/resign paths persist as well', { timeout: 30_000 }, async () => {
  const tmp = await tempRoot('lifecycle');
  const project = path.join(tmp, 'project');
  const stateDir = path.join(tmp, 'state');
  await fs.mkdir(project);
  approveFixtureRoot(project);

  const registry = openRegistry(stateDir);
  let reloaded = null;
  try {
    const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'claude-code' });
    await quiesce(registry);
    const first = await registry.registerOrchestrator(
      { cwd: project, actor: 'claude-code', title: 'First title' },
      { leaseId: lease.id },
    );
    assert.ok(
      registry.auditEvents.some((event) => event.type === 'orchestrator_registered' && event.evidence?.orchestratorId === first.id),
      'a registration is an audited event: without one there is no record that the container was ever created',
    );

    // The idempotent refresh (same cwd, same lease) is the documented way to
    // change a title. A title change that only lives in memory is the same bug.
    await quiesce(registry);
    await registry.registerOrchestrator(
      { cwd: project, actor: 'claude-code', title: 'Second title', focus: 'renaming' },
      { leaseId: lease.id },
    );
    await closeRegistry(registry);

    reloaded = openRegistry(stateDir);
    const restored = reloaded.orchestrators.find((item) => item.id === first.id);
    assert.equal(reloaded.orchestrators.length, 1, 'the refresh did not fork a second container');
    assert.equal(restored.title, 'Second title', 'the refreshed title is on disk');
    assert.equal(restored.focus, 'renaming');

    // Resigning is what hands the container to the next agent. If it is lost on
    // restart, a resigned orchestrator comes back owning work it walked away from.
    await quiesce(reloaded);
    reloaded.resignOrchestrator(first.id, { reason: 'done' }, { leaseId: lease.id });
    await closeRegistry(reloaded);

    const third = openRegistry(stateDir);
    try {
      assert.ok(third.orchestrators.find((item) => item.id === first.id)?.resignedAt, 'the resignation is on disk');
    } finally {
      await closeRegistry(third);
    }
  } finally {
    await closeRegistry(registry);
    if (reloaded) await closeRegistry(reloaded);
    restoreFixtureRoot();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('the register path creates the orchestrator workspace and artifact directories', { timeout: 30_000 }, async () => {
  // ensureSessionWorkspaces() only runs on RESTORE, so before the fix these
  // directories appeared on the next restart — for a record that never survived
  // one. They are the container's own storage; a registration that returns 200
  // has to have them.
  const tmp = await tempRoot('workspaces');
  const project = path.join(tmp, 'project');
  const stateDir = path.join(tmp, 'state');
  await fs.mkdir(project);
  approveFixtureRoot(project);

  const registry = openRegistry(stateDir);
  try {
    const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'claude-code' });
    const orchestrator = await registry.registerOrchestrator(
      { cwd: project, actor: 'claude-code', title: 'Workspaces' },
      { leaseId: lease.id },
    );
    assert.ok(fsSync.existsSync(path.join(stateDir, 'workspaces', orchestrator.id)), 'the container workspace exists');
    assert.ok(fsSync.existsSync(path.join(stateDir, 'artifacts', orchestrator.id)), 'the container artifact directory exists');
  } finally {
    await closeRegistry(registry);
    restoreFixtureRoot();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
