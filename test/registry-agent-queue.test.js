import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

async function withRegistry(callback, options = {}) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-agent-queue-'));
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

// v2 orchestrator-native container: the orchestrator RECORD is the container the
// agent queue is keyed by (getSession resolves the orc_ id via the seam). It has
// `.id` and `.projectId`, so callers can keep using `session.id`/`session.projectId`.
let orchCounter = 0;
async function makeSession(registry) {
  orchCounter += 1;
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor: `queue-orch-${orchCounter}` });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor: `queue-orch-${orchCounter}`, title: 'Queue Orch' },
    { leaseId: lease.id },
  );
  const project = registry.projects.find((entry) => entry.id === orchestrator.projectId);
  return { project, session: orchestrator, lease };
}

function makeLane(registry, sessionId, body = {}) {
  return registry.createLane(sessionId, { title: 'Queue Lane', executorType: 'mock', ...body }, { actor: 'test', approved: true });
}

test('agent queue: drain, replay, and ack are ordered and per consumer', async () => {
  await withRegistry(async (registry) => {
    const { project, session } = await makeSession(registry);
    const first = registry.enqueueAgentEvent({
      type: 'backlog_completed',
      targetRole: 'orchestrator',
      title: 'First',
      projectId: project.id,
      sessionId: session.id,
      metadata: { token: 'secret-token', safe: 'kept' },
    });
    const second = registry.enqueueAgentEvent({
      type: 'loop_paused',
      targetRole: 'orchestrator',
      title: 'Second',
      projectId: project.id,
      sessionId: session.id,
    });
    // A targetRole:'any' broadcast is visible to every orchestrator consumer
    // (supervisor was removed in v2; 'any' is the broad-reach target now).
    const third = registry.enqueueAgentEvent({
      type: 'broadcast_any',
      targetRole: 'any',
      title: 'Broadcast',
      projectId: project.id,
      sessionId: session.id,
    });

    const orchA = registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-a' });
    assert.deepEqual(orchA.events.map((event) => event.seq), [first.seq, second.seq, third.seq]);
    assert.equal(orchA.events[0].ackedAt, null);
    assert.equal(orchA.events[0].acks, undefined);
    assert.deepEqual(orchA.events[0].metadata, { safe: 'kept' });

    registry.ackAgentEvents(session.id, {
      role: 'orchestrator',
      actor: 'orch-a',
      eventIds: [first.id],
    });

    const orchAAfterAck = registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-a' });
    assert.deepEqual(orchAAfterAck.events.map((event) => event.id), [second.id, third.id]);

    const orchB = registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-b' });
    assert.deepEqual(orchB.events.map((event) => event.id), [first.id, second.id, third.id]);

    const replay = registry.replayAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-a', afterSeq: first.seq });
    assert.deepEqual(replay.events.map((event) => event.id), [second.id, third.id]);
    const fullReplay = registry.replayAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-a' });
    assert.equal(fullReplay.events[0].ackedBy, 'orch-a');
    assert.ok(fullReplay.events[0].ackedAt);

    // A fresh orchestrator consumer sees all three unacked events, including the
    // targetRole:'any' broadcast (which any role can drain).
    const anyConsumer = registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-c' });
    assert.deepEqual(anyConsumer.events.map((event) => event.type), [
      'backlog_completed',
      'loop_paused',
      'broadcast_any',
    ]);
  });
});

test('agent queue: dedupe preserves ack state and caps per-event consumers', async () => {
  await withRegistry(async (registry) => {
    const { session } = await makeSession(registry);
    const event = registry.enqueueAgentEvent({
      type: 'loop_paused',
      targetRole: 'orchestrator',
      title: 'Pause once',
      projectId: session.projectId,
      sessionId: session.id,
      dedupeKey: 'loop-paused:test',
      metadata: {
        apiKey: 'sk-should-not-persist',
        api_key: 'sk-should-not-persist',
        accessToken: 'Bearer should-not-persist',
        bearer_token: 'ghp_should_not_persist',
        safe: 'kept',
      },
    });
    assert.deepEqual(event.metadata, { safe: 'kept' });

    registry.ackAgentEvents(session.id, {
      role: 'orchestrator',
      actor: 'orch-a',
      eventIds: [event.id],
    });
    const deduped = registry.enqueueAgentEvent({
      type: 'loop_paused',
      targetRole: 'orchestrator',
      title: 'Pause again',
      projectId: session.projectId,
      sessionId: session.id,
      dedupeKey: 'loop-paused:test',
    });
    assert.equal(deduped.id, event.id);
    assert.equal(deduped.occurrences, 2);
    assert.deepEqual(registry.drainAgentEvents(session.id, {
      role: 'orchestrator',
      actor: 'orch-a',
    }).events, [], 'dedupe must not make already handled work unacked again');

    for (let index = 0; index < 80; index += 1) {
      registry.ackAgentEvents(session.id, {
        role: 'orchestrator',
        actor: `orch-${index}`,
        eventIds: [event.id],
      });
    }
    const stored = registry.agentQueue.find((entry) => entry.id === event.id);
    assert.equal(Object.keys(stored.acks).length <= 64, true, 'ack map should be bounded per event');
    assert.ok(stored.acks['orchestrator:orch-79'], 'newest ack should be preserved when trimming');
  });
});

test('agent queue: stopping an executor lane enqueues a drainable lane_stopped for the orchestrator', async () => {
  await withRegistry(async (registry) => {
    const { session } = await makeSession(registry);
    const created = makeLane(registry, session.id);
    const lane = registry.getLane(created.id);

    // No spurious terminal events before the lane reaches a terminal state.
    assert.deepEqual(
      registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-owner' })
        .events.filter((event) => event.type === 'lane_stopped' || event.type === 'lane_failed'),
      [],
    );

    registry.markLaneStopped(lane, { actor: 'orch-owner', reason: 'Stopped by orch-owner' });

    const drained = registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-owner' });
    const stopEvent = drained.events.find((event) => event.type === 'lane_stopped');
    assert.ok(stopEvent, 'orchestrator must see a lane_stopped event on its next drain');
    assert.equal(stopEvent.laneId, lane.id);
    assert.equal(stopEvent.severity, 'warning');
    assert.equal(stopEvent.body, 'Stopped by orch-owner');

    // Re-terminalizing an already-stopped lane must not enqueue a second event
    // (markLaneStopped no-ops on terminal state; the dedupeKey also collapses).
    registry.markLaneStopped(lane, { actor: 'orch-owner', reason: 'Stopped again' });
    const stopEvents = registry.agentQueue.filter((event) => event.type === 'lane_stopped');
    assert.equal(stopEvents.length, 1, 'a stopped lane must not enqueue lane_stopped twice');
  });
});

test('agent queue: failing an executor lane enqueues a drainable lane_failed for the orchestrator', async () => {
  await withRegistry(async (registry) => {
    const { session } = await makeSession(registry);
    const created = makeLane(registry, session.id);
    const lane = registry.getLane(created.id);

    registry.markLaneFailed(lane, 'Executor crashed', 'scheduler');

    const drained = registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-owner' });
    const failEvent = drained.events.find((event) => event.type === 'lane_failed');
    assert.ok(failEvent, 'orchestrator must see a lane_failed event on its next drain');
    assert.equal(failEvent.laneId, lane.id);
    assert.equal(failEvent.severity, 'error');
    assert.equal(failEvent.body, 'Executor crashed');

    // Idempotent: re-failing a terminal lane does not duplicate the event.
    registry.markLaneFailed(lane, 'Executor crashed again', 'scheduler');
    const failEvents = registry.agentQueue.filter((event) => event.type === 'lane_failed');
    assert.equal(failEvents.length, 1, 'a failed lane must not enqueue lane_failed twice');
  });
});

test('agent queue: a cleanly completed lane enqueues no lane_stopped/lane_failed', async () => {
  await withRegistry(async (registry) => {
    const { session } = await makeSession(registry);
    const created = makeLane(registry, session.id);
    const lane = registry.getLane(created.id);

    registry.markLaneCompleted(lane);

    const terminalFailures = registry.agentQueue.filter(
      (event) => event.type === 'lane_stopped' || event.type === 'lane_failed',
    );
    assert.deepEqual(terminalFailures, [], 'a clean completion must not enqueue stop/fail events');
  });
});

test('agent queue: ack state persists and remains scoped per consumer after reload', async () => {
  await withRegistry(async (registry, tempDir) => {
    const { session } = await makeSession(registry);
    const event = registry.enqueueAgentEvent({
      type: 'loop_paused',
      targetRole: 'orchestrator',
      title: 'Persist me',
      sessionId: session.id,
      projectId: session.projectId,
    });
    registry.ackAgentEvents(session.id, {
      role: 'orchestrator',
      actor: 'orch-a',
      eventIds: [event.id],
    });
    await registry.persistState();
    await registry.drainPendingWrites();
    registry.stopScheduler();
    await registry.drainPendingWrites();

    process.chdir(tempDir);
    const reloaded = new OrcaRegistry({ autoAudit: false });
    reloaded.stopScheduler();
    try {
      assert.deepEqual(reloaded.drainAgentEvents(session.id, {
        role: 'orchestrator',
        actor: 'orch-a',
      }).events, []);
      assert.deepEqual(reloaded.drainAgentEvents(session.id, {
        role: 'orchestrator',
        actor: 'orch-b',
      }).events.map((entry) => entry.id), [event.id]);
    } finally {
      reloaded.stopScheduler();
      await reloaded.drainPendingWrites();
    }
  });
});
