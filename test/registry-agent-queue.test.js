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

let projectCounter = 0;
function makeSession(registry, sessionBody = {}) {
  projectCounter += 1;
  const project = registry.createProject({ name: `Queue Project ${projectCounter}` }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, { name: 'Queue Session', leader: 'mock', ...sessionBody }, { actor: 'test', approved: true });
  return { project, session };
}

function makeLane(registry, sessionId, body = {}) {
  return registry.createLane(sessionId, { title: 'Queue Lane', executorType: 'mock', ...body }, { actor: 'test', approved: true });
}

test('agent queue: drain, replay, and ack are ordered and per consumer', async () => {
  await withRegistry(async (registry) => {
    const { project, session } = makeSession(registry);
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
    registry.enqueueAgentEvent({
      type: 'supervisor_only',
      targetRole: 'supervisor',
      title: 'Supervisor',
      projectId: project.id,
      sessionId: session.id,
    });

    const orchA = registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-a' });
    assert.deepEqual(orchA.events.map((event) => event.seq), [first.seq, second.seq]);
    assert.equal(orchA.events[0].ackedAt, null);
    assert.equal(orchA.events[0].acks, undefined);
    assert.deepEqual(orchA.events[0].metadata, { safe: 'kept' });

    registry.ackAgentEvents(session.id, {
      role: 'orchestrator',
      actor: 'orch-a',
      eventIds: [first.id],
    });

    const orchAAfterAck = registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-a' });
    assert.deepEqual(orchAAfterAck.events.map((event) => event.id), [second.id]);

    const orchB = registry.drainAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-b' });
    assert.deepEqual(orchB.events.map((event) => event.id), [first.id, second.id]);

    const replay = registry.replayAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-a', afterSeq: first.seq });
    assert.deepEqual(replay.events.map((event) => event.id), [second.id]);
    const fullReplay = registry.replayAgentEvents(session.id, { role: 'orchestrator', actor: 'orch-a' });
    assert.equal(fullReplay.events[0].ackedBy, 'orch-a');
    assert.ok(fullReplay.events[0].ackedAt);

    const supervisor = registry.drainAgentEvents(session.id, { role: 'supervisor', actor: 'sup-a' });
    assert.deepEqual(supervisor.events.map((event) => event.type), [
      'backlog_completed',
      'loop_paused',
      'supervisor_only',
    ]);
  });
});

test('agent queue: dedupe preserves ack state and caps per-event consumers', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
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

test('agent queue: ack state persists and remains scoped per consumer after reload', async () => {
  await withRegistry(async (registry, tempDir) => {
    const { session } = makeSession(registry);
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
