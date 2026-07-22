import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-lifecycle-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  try { return await callback(registry); } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

// v2: the orchestrator RECORD is the lane container (no session records). It is
// registered against the (approved) temp cwd; lanes hang off its orc_ id and
// carry sessionId === orchestrator.id through the getSession() container bridge.
async function setup(registry, { actor = 'test', title = 'Lifecycle' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
}
const makeLane = (registry, orchestratorId) => registry.createLane(orchestratorId, { title: 'L', executorType: 'mock' }, { actor: 'test', approved: true });

test('terminal handlers are idempotent (stop racing complete cannot double-fire)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    registry.markLaneCompleted(registry.getLane(lane.id));
    assert.equal(registry.getLane(lane.id).state, 'done');
    // A late stop must NOT re-terminalize the already-done lane.
    registry.markLaneStopped(registry.getLane(lane.id), { actor: 'test' });
    assert.equal(registry.getLane(lane.id).state, 'done');
    assert.equal(registry.auditEvents.filter((e) => e.type === 'lane_stopped' && e.laneId === lane.id).length, 0);
  });
});

test('stopAllExecutors kills every live executor child (shutdown sweep)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    await registry.getExecutorForType('mock').start(registry.getLane(lane.id));
    assert.equal(registry.getRunningCountForSession(orchestrator.id), 1);
    await registry.stopAllExecutors('test');
    assert.equal(registry.getRunningCountForSession(orchestrator.id), 0);
  });
});

test('acceptLaneAudit refuses a still-running lane (dashboard path)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    await registry.getExecutorForType('mock').start(registry.getLane(lane.id));
    registry.getLane(lane.id).state = 'running';
    assert.throws(() => registry.acceptLaneAudit(lane.id, { actor: 'dashboard' }), (e) => e.status === 409);
    // A terminal lane accepts fine.
    registry.getLane(lane.id).state = 'done';
    const r = registry.acceptLaneAudit(lane.id, { actor: 'dashboard' });
    assert.equal(r.lane.state, 'accepted');
  });
});

test('pruneInMemoryRecords caps terminal lanes per orchestrator container (bounds growth)', async () => {
  const prev = process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
  process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = '2';
  try {
    await withRegistry(async (registry) => {
      const { orchestrator } = await setup(registry);
      for (let i = 0; i < 5; i += 1) {
        const lane = makeLane(registry, orchestrator.id);
        registry.markLaneCompleted(registry.getLane(lane.id)); // -> done (terminal)
      }
      assert.equal(registry.lanes.filter((l) => l.sessionId === orchestrator.id).length, 5);
      assert.equal(registry.pruneInMemoryRecords(), true);
      assert.equal(registry.lanes.filter((l) => l.sessionId === orchestrator.id).length, 2);
    });
  } finally {
    if (prev === undefined) delete process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
    else process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = prev;
  }
});

test('deleteLane removes a terminal lane (and refuses a live one)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    // Live lane cannot be deleted.
    const live = makeLane(registry, orchestrator.id);
    await registry.getExecutorForType('mock').start(registry.getLane(live.id));
    registry.getLane(live.id).state = 'running';
    await assert.rejects(() => registry.deleteLane(live.id, { actor: 'test' }), (e) => e.status === 422);
    // Terminal lane can be deleted; runtime maps cleared.
    const done = makeLane(registry, orchestrator.id);
    registry.ensureLaneToolLease(registry.getLane(done.id));
    registry.markLaneCompleted(registry.getLane(done.id)); // -> done
    const result = await registry.deleteLane(done.id, { actor: 'test' });
    assert.equal(result.deleted, true);
    assert.equal(registry.getLane(done.id), undefined);
    assert.equal(registry.laneRuntimeEnv.has(String(done.id)), false);
  });
});

test('acceptLaneAudit overrides an escalated audit (clears the dead end)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    registry.markLaneCompleted(registry.getLane(lane.id));
    registry.queueLaneAudit(lane.id, { actor: 'auditor', approved: true });
    // Exhaust the loop budget -> escalated.
    registry.requestLaneFix(lane.id, { actor: 'auditor', findings: ['x'] });
    registry.requestLaneFix(lane.id, { actor: 'auditor', findings: ['still'] });
    assert.equal(registry.getLane(lane.id).auditState, 'escalated');
    // Operator override accepts it.
    registry.acceptLaneAudit(lane.id, { actor: 'dashboard', findings: ['override'] });
    assert.equal(registry.getLane(lane.id).state, 'accepted');
    assert.equal(registry.getLane(lane.id).auditState, 'accepted');
  });
});

test('deleting an orchestrator-container project stops a running lane and clears its runtime maps (no orphan)', async () => {
  await withRegistry(async (registry) => {
    // v2 has no deleteSession; the orchestrator container is torn down when its
    // (archived) project is permanently deleted. deleteProject sweeps every
    // container lane: it kills the live child, drops the record, and reclaims the
    // managed worktree — the orchestrator-native replacement for deleteSession.
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    registry.ensureLaneToolLease(registry.getLane(lane.id));
    await registry.getExecutorForType('mock').start(registry.getLane(lane.id));
    assert.equal(registry.laneRuntimeEnv.has(String(lane.id)), true);
    assert.equal(registry.getRunningCountForSession(orchestrator.id), 1);

    registry.updateProject(orchestrator.projectId, { state: 'archived' }, { actor: 'test', approved: true });
    await registry.deleteProject(orchestrator.projectId, { actor: 'test', approved: true });

    assert.equal(registry.getRunningCountForSession(orchestrator.id), 0);
    assert.equal(registry.laneRuntimeEnv.has(String(lane.id)), false);
    assert.equal(registry.lanes.filter((l) => l.sessionId === orchestrator.id).length, 0);
  });
});
