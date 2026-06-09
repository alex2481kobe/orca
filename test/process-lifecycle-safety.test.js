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
