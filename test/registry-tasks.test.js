import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

async function withRegistry(callback, options = {}) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tasks-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false, ...options });
  registry.stopScheduler();
  try {
    return await callback(registry, tempDir);
  } finally {
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') {
      await registry.drainPendingWrites();
    }
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

let projectCounter = 0;
function makeSession(registry, sessionBody = {}) {
  projectCounter += 1;
  const project = registry.createProject({ name: `Backlog Project ${projectCounter}` }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, { name: 'Backlog Session', leader: 'mock', ...sessionBody }, { actor: 'test', approved: true });
  return { project, session };
}

function makeLane(registry, sessionId, body = {}) {
  return registry.createLane(sessionId, { title: 'Lane', executorType: 'mock', ...body }, { actor: 'test', approved: true });
}

test('tasks: CRUD + priority/seq ordering', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    registry.addTask(session.id, { title: 'low', priority: 0 });
    registry.addTask(session.id, { title: 'high', priority: 5 });
    registry.addTask(session.id, { title: 'mid', priority: 5 });
    const list = registry.listTasks(session.id);
    // priority DESC, then seq ASC (insertion order) for ties.
    assert.deepEqual(list.map((t) => t.title), ['high', 'mid', 'low']);
    assert.equal(list[0].state, 'pending');
    assert.ok(list[0].seq < list[1].seq);
    // empty title rejected
    assert.throws(() => registry.addTask(session.id, { title: '   ' }), (e) => e.status === 422);
  });
});

test('tasks: persistence round-trips and forward-compat with pre-backlog state', async () => {
  await withRegistry(async (registry, tempDir) => {
    const { session } = makeSession(registry);
    registry.addTask(session.id, { title: 'persist me', priority: 2 });
    await registry.persistState();
    await registry.drainPendingWrites();
    registry.stopScheduler();
    await registry.drainPendingWrites();

    // Second registry over the same cwd reloads tasks.
    const reloaded = new OrcaRegistry({ autoAudit: false });
    reloaded.stopScheduler();
    try {
      const list = reloaded.listTasks(session.id);
      assert.equal(list.length, 1);
      assert.equal(list[0].title, 'persist me');
    } finally {
      reloaded.stopScheduler();
      await reloaded.drainPendingWrites();
    }

    // A state.json with NO tasks key loads cleanly as an empty backlog.
    const stateFile = path.join(tempDir, '.orca', 'state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    delete raw.tasks;
    await fs.writeFile(stateFile, JSON.stringify(raw));
    const fresh = new OrcaRegistry({ autoAudit: false });
    fresh.stopScheduler();
    try {
      assert.deepEqual(fresh.tasks, []);
    } finally {
      fresh.stopScheduler();
      await fresh.drainPendingWrites();
    }
  });
});

test('tasks: an assigned task with a dead lane recovers to pending on reload', async () => {
  await withRegistry(async (registry, tempDir) => {
    const { session } = makeSession(registry);
    const task = registry.addTask(session.id, { title: 'orphan' });
    // Simulate a crash mid-claim: assigned with no real lane.
    registry.getTask(task.id).state = 'assigned';
    await registry.persistState();
    await registry.drainPendingWrites();
    registry.stopScheduler();
    await registry.drainPendingWrites();

    const reloaded = new OrcaRegistry({ autoAudit: false });
    reloaded.stopScheduler();
    try {
      assert.equal(reloaded.getTask(task.id).state, 'pending');
    } finally {
      reloaded.stopScheduler();
      await reloaded.drainPendingWrites();
    }
  });
});

test('tasks: illegal state transition is refused', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const task = registry.addTask(session.id, { title: 't' });
    assert.throws(() => registry.updateTaskState(task.id, 'accepted'), (e) => e.status === 422);
    // pending -> blocked -> pending is legal
    registry.updateTaskState(task.id, 'blocked', { reason: 'hold' });
    assert.equal(registry.getTask(task.id).state, 'blocked');
    registry.updateTaskState(task.id, 'pending');
    assert.equal(registry.getTask(task.id).state, 'pending');
  });
});

test('tasks: lane accept syncs the linked task to accepted', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const task = registry.addTask(session.id, { title: 'do work' });
    const lane = makeLane(registry, session.id, { owner: 'executor' });
    registry.claimNextPendingTask(session.id);
    registry.linkTaskToLane(task.id, lane.id);
    assert.equal(registry.getTask(task.id).state, 'in_lane');
    assert.equal(registry.getTask(task.id).attempts, 1);
    registry.acceptLaneAudit(lane.id, { actor: 'auditor' });
    assert.equal(registry.getTask(task.id).state, 'accepted');
    assert.ok(registry.getTask(task.id).terminatedAt);
  });
});

test('tasks: lane failure requeues within budget, then fails', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const task = registry.addTask(session.id, { title: 'flaky', maxAttempts: 2 });
    const lane1 = makeLane(registry, session.id, { owner: 'executor' });
    registry.claimNextPendingTask(session.id);
    registry.linkTaskToLane(task.id, lane1.id);
    registry.markLaneFailed(registry.getLane(lane1.id), 'boom', 'scheduler');
    // attempts(1) < maxAttempts(2) -> requeued
    assert.equal(registry.getTask(task.id).state, 'pending');
    assert.equal(registry.getTask(task.id).laneId, null);

    const lane2 = makeLane(registry, session.id, { owner: 'executor' });
    registry.claimNextPendingTask(session.id);
    registry.linkTaskToLane(task.id, lane2.id);
    assert.equal(registry.getTask(task.id).attempts, 2);
    registry.markLaneFailed(registry.getLane(lane2.id), 'boom again', 'scheduler');
    // attempts(2) == maxAttempts(2) -> failed
    assert.equal(registry.getTask(task.id).state, 'failed');
  });
});

test('tasks: auto-spawn fans out up to capacity and only under spawnPolicy auto', async () => {
  await withRegistry(async (registry) => {
    // within_capacity: auto-spawn does nothing.
    const manual = makeSession(registry, { spawnPolicy: 'within_capacity', approvedCapacity: 2 });
    registry.addTask(manual.session.id, { title: 'a', executorType: 'mock' });
    await registry.dispatchPendingTasks();
    assert.equal(registry.listTasks(manual.session.id, { state: 'in_lane' }).length, 0);

    // auto: spawns up to approvedCapacity (2), leaving the 3rd pending.
    const auto = makeSession(registry, { spawnPolicy: 'auto', approvedCapacity: 2 });
    registry.addTask(auto.session.id, { title: 't1', executorType: 'mock', priority: 1 });
    registry.addTask(auto.session.id, { title: 't2', executorType: 'mock', priority: 1 });
    registry.addTask(auto.session.id, { title: 't3', executorType: 'mock', priority: 1 });
    await registry.dispatchPendingTasks();
    assert.equal(registry.listTasks(auto.session.id, { state: 'in_lane' }).length, 2);
    assert.equal(registry.listTasks(auto.session.id, { state: 'pending' }).length, 1);
    const spawnedLanes = registry.lanes.filter((l) => l.sessionId === auto.session.id);
    assert.equal(spawnedLanes.length, 2);

    // Accept one -> a capacity slot frees -> next tick refills the 3rd task.
    registry.acceptLaneAudit(spawnedLanes[0].id, { actor: 'auditor' });
    await registry.dispatchPendingTasks();
    assert.equal(registry.listTasks(auto.session.id, { state: 'in_lane' }).length, 2);
    assert.equal(registry.listTasks(auto.session.id, { state: 'pending' }).length, 0);
  });
});

test('tasks: recovery keeps done/awaiting-audit work, syncs accepted, requeues only real failures', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const tDone = registry.addTask(session.id, { title: 'done' });
    const tAcc = registry.addTask(session.id, { title: 'acc' });
    const tFail = registry.addTask(session.id, { title: 'fail', maxAttempts: 1 });
    const lDone = makeLane(registry, session.id, { owner: 'executor' });
    const lAcc = makeLane(registry, session.id, { owner: 'executor' });
    const lFail = makeLane(registry, session.id, { owner: 'executor' });
    registry.linkTaskToLane(tDone.id, lDone.id);
    registry.linkTaskToLane(tAcc.id, lAcc.id);
    registry.linkTaskToLane(tFail.id, lFail.id);
    registry.getLane(lDone.id).state = 'done';
    registry.getLane(lAcc.id).state = 'accepted';
    registry.getLane(lFail.id).state = 'failed';
    registry.recoverInterruptedTasks();
    assert.equal(registry.getTask(tDone.id).state, 'in_lane'); // preserved (would be re-run before the fix)
    assert.equal(registry.getTask(tAcc.id).state, 'accepted'); // synced
    assert.equal(registry.getTask(tFail.id).state, 'failed');  // out of budget
  });
});

test('tasks: requeue after a failed lane re-arms the batch signal', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const t = registry.addTask(session.id, { title: 'x', maxAttempts: 2 });
    const lane = makeLane(registry, session.id, { owner: 'executor' });
    registry.linkTaskToLane(t.id, lane.id);
    registry.getSession(session.id).backlogCompletedAt = '2026-06-08T00:00:00.000Z';
    registry.markLaneFailed(registry.getLane(lane.id), 'boom', 'scheduler');
    assert.equal(registry.getTask(t.id).state, 'pending');
    assert.equal(registry.getSession(session.id).backlogCompletedAt, null);
  });
});

test('tasks: auto-spawn counts ALL live session lanes (incl. orchestrator) against capacity', async () => {
  await withRegistry(async (registry) => {
    const auto = makeSession(registry, { spawnPolicy: 'auto', approvedCapacity: 2 });
    makeLane(registry, auto.session.id, { owner: 'orchestrator', title: 'orch turn' }); // occupies a slot
    registry.addTask(auto.session.id, { title: 't1', executorType: 'mock' });
    registry.addTask(auto.session.id, { title: 't2', executorType: 'mock' });
    await registry.dispatchPendingTasks();
    const live = registry.lanes.filter((l) => l.sessionId === auto.session.id && ['queued', 'starting', 'running'].includes(l.state));
    assert.ok(live.length <= 2, `expected <=2 live lanes (cap), got ${live.length}`);
  });
});

test('tasks: a session-scoped lease cannot mutate another session\'s task', async () => {
  await withRegistry(async (registry) => {
    const a = makeSession(registry);
    const b = makeSession(registry);
    const taskB = registry.addTask(b.session.id, { title: 'B task' });
    const { leaseToken } = registry.createToolLease({ role: 'orchestrator', projectId: a.session.projectId, sessionId: a.session.id, allowedTools: ['task.update'] });
    // The task route validates the lease against the TASK's session (not the URL).
    assert.throws(
      () => registry.validateToolLease(leaseToken, { toolId: 'task.update', sessionId: taskB.sessionId }),
      (e) => e.status === 403,
    );
  });
});

test('tasks: batch-completion signal latches once when all tasks accepted', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const t1 = registry.addTask(session.id, { title: 'one' });
    const t2 = registry.addTask(session.id, { title: 'two' });
    const lane1 = makeLane(registry, session.id, { owner: 'executor' });
    const lane2 = makeLane(registry, session.id, { owner: 'executor' });
    registry.linkTaskToLane(t1.id, lane1.id);
    registry.linkTaskToLane(t2.id, lane2.id);

    registry.acceptLaneAudit(lane1.id, { actor: 'auditor' });
    assert.equal(registry.sessionBacklogStatus(session.id).complete, false);
    assert.equal(registry.getSession(session.id).backlogCompletedAt, undefined);

    registry.acceptLaneAudit(lane2.id, { actor: 'auditor' });
    const status = registry.sessionBacklogStatus(session.id);
    assert.equal(status.allAccepted, true);
    assert.equal(status.complete, true);
    assert.ok(registry.getSession(session.id).backlogCompletedAt);
    const completedEvents = registry.auditEvents.filter((e) => e.type === 'session_backlog_completed' && e.sessionId === session.id);
    assert.equal(completedEvents.length, 1);

    // Re-evaluating doesn't double-fire.
    registry.evaluateBacklogCompletion(session.id);
    assert.equal(registry.auditEvents.filter((e) => e.type === 'session_backlog_completed' && e.sessionId === session.id).length, 1);
  });
});
