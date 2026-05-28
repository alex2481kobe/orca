import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandDeckRegistry } from '../src/registry.js';
import { buildNextActionEnvelope } from '../src/agent-tools.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-capacity-'));
  process.chdir(tempDir);
  const registry = new CommandDeckRegistry({ autoCompleteMs: 60 * 60 * 1000 });
  registry.stopScheduler();
  try {
    return await callback(registry);
  } finally {
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') {
      await registry.drainPendingWrites();
    }
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('sessions default to within-capacity policy with two approved slots', async () => {
  await withRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Capacity Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Capacity Session' }, { actor: 'test', approved: true });
    const capacity = registry.getSessionCapacity(session.id);
    assert.equal(capacity.spawnPolicy, 'within_capacity');
    assert.equal(capacity.approvedCapacity, 2);
    assert.equal(capacity.activeAgents, 0);
    assert.equal(capacity.idleSlots, 2);
    assert.equal(capacity.soloMode, true);
    assert.equal(capacity.idleShutdownMode, 'immediate');
  });
});

test('capacity requests are structured, idempotent, and approval-gated', async () => {
  await withRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Request Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Request Session' }, { actor: 'test', approved: true });
    const requested = registry.requestCapacity(session.id, {
      actor: 'orchestrator',
      requestedCapacity: 4,
      reason: 'Parallel audit and executor lanes',
      tasksUnlocked: ['audit lane A', 'start lane B'],
      costRisk: 'more RAM',
    });
    assert.equal(requested.request.status, 'pending');
    assert.equal(requested.request.requestedCapacity, 4);
    assert.equal(requested.capacity.approvedCapacity, 2);

    const duplicate = registry.requestCapacity(session.id, {
      actor: 'orchestrator',
      requestedCapacity: 4,
      reason: 'same ask',
    });
    assert.equal(duplicate.alreadyPending, true);
    assert.equal(duplicate.request.id, requested.request.id);

    assert.throws(() => registry.approveCapacityRequest(session.id, requested.request.id, {
      actor: 'dashboard',
      approved: false,
    }), (error) => error.status === 409);

    const approved = registry.approveCapacityRequest(session.id, requested.request.id, {
      actor: 'dashboard',
      approved: true,
      reason: 'Approved for current plan',
    });
    assert.equal(approved.request.status, 'approved');
    assert.equal(approved.capacity.approvedCapacity, 4);
    assert.equal(approved.capacity.idleSlots, 4);
  });
});

test('spawn policy never prevents queued lanes from starting', async () => {
  await withRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Never Spawn Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Never Spawn Session' }, { actor: 'test', approved: true });
    registry.setCapacityPolicy(session.id, {
      actor: 'dashboard',
      approved: true,
      spawnPolicy: 'never',
      approvedCapacity: 2,
      soloMode: true,
    });
    const lane = registry.createLane(session.id, {
      title: 'Should stay queued',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    await registry.advanceLanes();
    assert.equal(registry.getLane(lane.id).state, 'queued');

    const envelope = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
    });
    assert.equal(envelope.capacity.spawnPolicy, 'never');
    assert.equal(envelope.capacity.approvedCapacity, 2);
    assert.equal(envelope.allowedTools.includes('capacity.request'), true);
  });
});
