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

function setup(registry) {
  const project = registry.createProject({ name: 'Lifecycle' }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, { name: 'S', leader: 'mock' }, { actor: 'test', approved: true });
  return { project, session };
}
const makeLane = (registry, sessionId) => registry.createLane(sessionId, { title: 'L', executorType: 'mock' }, { actor: 'test', approved: true });

test('terminal handlers are idempotent (stop racing complete cannot double-fire)', async () => {
  await withRegistry(async (registry) => {
    const { session } = setup(registry);
    const lane = makeLane(registry, session.id);
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
    const { session } = setup(registry);
    const lane = makeLane(registry, session.id);
    await registry.getExecutorForType('mock').start(registry.getLane(lane.id));
    assert.equal(registry.getRunningCountForSession(session.id), 1);
    await registry.stopAllExecutors('test');
    assert.equal(registry.getRunningCountForSession(session.id), 0);
  });
});

test('acceptLaneAudit refuses a still-running lane (dashboard path)', async () => {
  await withRegistry(async (registry) => {
    const { session } = setup(registry);
    const lane = makeLane(registry, session.id);
    await registry.getExecutorForType('mock').start(registry.getLane(lane.id));
    registry.getLane(lane.id).state = 'running';
    assert.throws(() => registry.acceptLaneAudit(lane.id, { actor: 'dashboard' }), (e) => e.status === 409);
    // A terminal lane accepts fine.
    registry.getLane(lane.id).state = 'done';
    const r = registry.acceptLaneAudit(lane.id, { actor: 'dashboard' });
    assert.equal(r.lane.state, 'accepted');
  });
});

test('pruneInMemoryRecords caps terminal lanes per session (bounds growth)', async () => {
  const prev = process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
  process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = '2';
  try {
    await withRegistry(async (registry) => {
      const { session } = setup(registry);
      for (let i = 0; i < 5; i += 1) {
        const lane = makeLane(registry, session.id);
        registry.markLaneCompleted(registry.getLane(lane.id)); // -> done (terminal)
      }
      assert.equal(registry.lanes.filter((l) => l.sessionId === session.id).length, 5);
      assert.equal(registry.pruneInMemoryRecords(), true);
      assert.equal(registry.lanes.filter((l) => l.sessionId === session.id).length, 2);
    });
  } finally {
    if (prev === undefined) delete process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
    else process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = prev;
  }
});

test('pruneInMemoryRecords removes stale orchestrator turn references', async () => {
  const prev = process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
  process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = '1';
  try {
    await withRegistry(async (registry) => {
      const { session } = setup(registry);
      const turns = [];
      for (let i = 1; i <= 3; i += 1) {
        const turn = await registry.sendOrchestratorMessage(session.id, {
          message: `Plan step ${i}.`,
          executorType: 'mock',
          baseUrl: 'http://127.0.0.1:1',
        }, { actor: 'dashboard', approved: true });
        registry.markLaneCompleted(registry.getLane(turn.lane.id));
        turns.push(turn);
      }

      assert.equal(registry.getOrchestratorThread(session.id).activeLaneId, turns[2].lane.id);
      assert.equal(registry.pruneInMemoryRecords(), true);

      const thread = registry.getOrchestratorThread(session.id);
      assert.deepEqual(thread.laneIds, [turns[2].lane.id]);
      assert.equal(thread.activeLaneId, turns[2].lane.id);
      assert.equal(thread.activeLane?.id, turns[2].lane.id);
      assert.equal(registry.getLane(turns[0].lane.id), undefined);
      assert.equal(registry.getLane(turns[1].lane.id), undefined);
    });
  } finally {
    if (prev === undefined) delete process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
    else process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = prev;
  }
});

test('deleteLane removes a terminal lane (and refuses a live one)', async () => {
  await withRegistry(async (registry) => {
    const { session } = setup(registry);
    // Live lane cannot be deleted.
    const live = makeLane(registry, session.id);
    await registry.getExecutorForType('mock').start(registry.getLane(live.id));
    registry.getLane(live.id).state = 'running';
    await assert.rejects(() => registry.deleteLane(live.id, { actor: 'test' }), (e) => e.status === 422);
    // Terminal lane can be deleted; runtime maps cleared; linked task unlinked.
    const done = makeLane(registry, session.id);
    registry.ensureLaneToolLease(registry.getLane(done.id));
    registry.markLaneCompleted(registry.getLane(done.id)); // -> done
    const task = registry.addTask(session.id, { title: 'x' });
    registry.linkTaskToLane(task.id, done.id);
    const result = await registry.deleteLane(done.id, { actor: 'test' });
    assert.equal(result.deleted, true);
    assert.equal(registry.getLane(done.id), undefined);
    assert.equal(registry.laneRuntimeEnv.has(String(done.id)), false);
    assert.equal(registry.getTask(task.id).laneId, null);
  });
});

test('deleteLane removes terminal orchestrator turn references', async () => {
  await withRegistry(async (registry) => {
    const { session } = setup(registry);
    const first = await registry.sendOrchestratorMessage(session.id, {
      message: 'Plan the first step.',
      executorType: 'mock',
      baseUrl: 'http://127.0.0.1:1',
    }, { actor: 'dashboard', approved: true });
    const second = await registry.sendOrchestratorMessage(session.id, {
      message: 'Plan the second step.',
      executorType: 'mock',
      baseUrl: 'http://127.0.0.1:1',
    }, { actor: 'dashboard', approved: true });
    registry.markLaneCompleted(registry.getLane(first.lane.id));
    registry.markLaneCompleted(registry.getLane(second.lane.id));
    assert.equal(registry.getOrchestratorThread(session.id).activeLaneId, second.lane.id);

    await registry.deleteLane(second.lane.id, { actor: 'test' });
    const afterSecondDelete = registry.getOrchestratorThread(session.id);
    assert.equal(afterSecondDelete.activeLaneId, first.lane.id);
    assert.equal(afterSecondDelete.activeLane?.id, first.lane.id);
    assert.deepEqual(afterSecondDelete.laneIds, [first.lane.id]);

    await registry.deleteLane(first.lane.id, { actor: 'test' });
    const afterFirstDelete = registry.getOrchestratorThread(session.id);
    assert.equal(afterFirstDelete.activeLaneId, null);
    assert.equal(afterFirstDelete.activeLane, null);
    assert.deepEqual(afterFirstDelete.laneIds, []);
  });
});

test('deleteLane requeues an in_lane task instead of stranding it', async () => {
  await withRegistry(async (registry) => {
    const { session } = setup(registry);
    const done = makeLane(registry, session.id);
    registry.markLaneCompleted(registry.getLane(done.id)); // -> done (deletable, awaiting audit)
    const task = registry.addTask(session.id, { title: 'x', maxAttempts: 2 });
    registry.linkTaskToLane(task.id, done.id); // -> in_lane, attempts=1
    await registry.deleteLane(done.id, { actor: 'test' });
    // Task must not be stranded in_lane with a dead link — it should requeue.
    assert.equal(registry.getTask(task.id).state, 'pending');
    assert.equal(registry.getTask(task.id).laneId, null);
  });
});

test('deleteLane fails an out-of-budget in_lane task and completes the backlog', async () => {
  await withRegistry(async (registry) => {
    const { session } = setup(registry);
    const done = makeLane(registry, session.id);
    registry.markLaneCompleted(registry.getLane(done.id));
    const task = registry.addTask(session.id, { title: 'x', maxAttempts: 1 });
    registry.linkTaskToLane(task.id, done.id); // -> in_lane, attempts=1 (== maxAttempts)
    await registry.deleteLane(done.id, { actor: 'test' });
    assert.equal(registry.getTask(task.id).state, 'failed');
    // All tasks terminal -> backlog completion latches even via the delete path.
    assert.ok(registry.getSession(session.id).backlogCompletedAt);
  });
});

test('pruneInMemoryRecords never drops a done lane still linked to an in_lane task', async () => {
  const prev = process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
  process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = '2';
  try {
    await withRegistry(async (registry) => {
      const { session } = setup(registry);
      // One done lane awaiting audit, linked to an in_lane task (the protected one).
      const awaiting = makeLane(registry, session.id);
      registry.markLaneCompleted(registry.getLane(awaiting.id)); // -> done
      const task = registry.addTask(session.id, { title: 'awaiting' });
      registry.linkTaskToLane(task.id, awaiting.id); // -> in_lane, laneId = awaiting
      // Pile on more terminal lanes so the cap (2) is exceeded and prune fires.
      for (let i = 0; i < 5; i += 1) {
        const l = makeLane(registry, session.id);
        registry.markLaneCompleted(registry.getLane(l.id));
      }
      registry.pruneInMemoryRecords();
      // The linked done lane must survive even though it's among the oldest terminal lanes.
      assert.ok(registry.getLane(awaiting.id), 'linked-to-in_lane-task lane must not be pruned');
      assert.equal(registry.getTask(task.id).laneId, String(awaiting.id));
    });
  } finally {
    if (prev === undefined) delete process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
    else process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = prev;
  }
});

test('acceptLaneAudit overrides an escalated audit (clears the dead end)', async () => {
  await withRegistry(async (registry) => {
    const { session } = setup(registry);
    const lane = makeLane(registry, session.id);
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

test('deleteSession stops a running lane and clears its runtime maps (no orphan)', async () => {
  await withRegistry(async (registry) => {
    const { session } = setup(registry);
    const lane = makeLane(registry, session.id);
    registry.ensureLaneToolLease(registry.getLane(lane.id));
    await registry.getExecutorForType('mock').start(registry.getLane(lane.id));
    assert.equal(registry.laneRuntimeEnv.has(String(lane.id)), true);
    assert.equal(registry.getRunningCountForSession(session.id), 1);

    registry.updateSession(session.id, { state: 'archived' }, { actor: 'test', approved: true });
    await registry.deleteSession(session.id, { actor: 'test' });

    assert.equal(registry.getRunningCountForSession(session.id), 0);
    assert.equal(registry.laneRuntimeEnv.has(String(lane.id)), false);
    assert.equal(registry.lanes.filter((l) => l.sessionId === session.id).length, 0);
  });
});
