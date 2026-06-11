import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orch-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  try {
    return await callback(registry);
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function makeSession(registry) {
  const project = registry.createProject({ name: 'Orch Project' }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, { name: 'Orch Session', leader: 'mock' }, { actor: 'test', approved: true });
  return { project, session };
}

function makeLease(registry, session, actor) {
  const { lease } = registry.createToolLease({
    role: 'orchestrator',
    projectId: session.projectId,
    sessionId: session.id,
    allowedTools: ['orchestrator.enroll', 'orchestrator.resign', 'orchestrator.status'],
    actor,
  });
  return lease;
}

test('orchestrator: enroll claims ownership; status reflects the active owner', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const lease = makeLease(registry, session, 'claude-cli');
    assert.equal(registry.getActiveOrchestrator(session.id).active, false);
    const res = registry.enrollOrchestrator(session.id, { leaseId: lease.id, actor: lease.actor, source: 'mcp' });
    assert.equal(res.enrolled, true);
    const active = registry.getActiveOrchestrator(session.id);
    assert.equal(active.active, true);
    assert.equal(active.actor, 'claude-cli');
    assert.equal(active.leaseId, lease.id);
    const status = registry.orchestratorStatus(session.id);
    assert.equal(status.activeOrchestrator.active, true);
    assert.ok(typeof status.tree === 'string' && status.tree.includes('Orch Session'));
  });
});

test('orchestrator: a second chat is refused without takeover, then takes over', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const leaseA = makeLease(registry, session, 'chat-a');
    const leaseB = makeLease(registry, session, 'chat-b');
    registry.enrollOrchestrator(session.id, { leaseId: leaseA.id, actor: 'chat-a' });
    assert.throws(
      () => registry.enrollOrchestrator(session.id, { leaseId: leaseB.id, actor: 'chat-b' }),
      (e) => e.status === 409 && e.current && e.current.actor === 'chat-a',
    );
    const res = registry.enrollOrchestrator(session.id, { leaseId: leaseB.id, actor: 'chat-b', takeover: true });
    assert.equal(res.activeOrchestrator.actor, 'chat-b');
  });
});

test('orchestrator: resign requires being the holder and is idempotent', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const leaseA = makeLease(registry, session, 'chat-a');
    const leaseB = makeLease(registry, session, 'chat-b');
    registry.enrollOrchestrator(session.id, { leaseId: leaseA.id, actor: 'chat-a' });
    assert.throws(
      () => registry.resignOrchestrator(session.id, { leaseId: leaseB.id }),
      (e) => e.status === 403,
    );
    assert.equal(registry.resignOrchestrator(session.id, { leaseId: leaseA.id }).released, true);
    assert.equal(registry.getActiveOrchestrator(session.id).active, false);
    // Idempotent: resigning when none is held returns released:false.
    assert.equal(registry.resignOrchestrator(session.id, { leaseId: leaseA.id }).released, false);
  });
});

test('orchestrator: exclusive ownership refuses a non-owner mutating call', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const owner = makeLease(registry, session, 'owner-chat');
    const other = makeLease(registry, session, 'other-chat');
    // Give both leases the mutating tool so the refusal is about OWNERSHIP, not scope.
    registry.toolLeases.find((l) => l.id === owner.id).allowedTools.push('lane.create', 'task.list');
    registry.toolLeases.find((l) => l.id === other.id).allowedTools.push('lane.create', 'task.list');

    // No owner yet -> the external orchestrator must register before mutating.
    assert.throws(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: other }),
      (e) => e.status === 409 && /No active orchestrator/.test(e.message),
    );

    registry.enrollOrchestrator(session.id, { leaseId: owner.id, actor: 'owner-chat' });
    // Owner may mutate; non-owner is refused; reads + exempt tools always allowed.
    registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: owner });
    assert.throws(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: other }),
      (e) => e.status === 409 && /not the active orchestrator/.test(e.message),
    );
    registry.assertOrchestratorOwnership({ toolId: 'task.list', sessionId: session.id, lease: other }); // read ok
    registry.assertOrchestratorOwnership({ toolId: 'orchestrator.enroll', sessionId: session.id, lease: other }); // exempt

    // After the owner resigns, the other lease still has to enroll before mutating.
    registry.resignOrchestrator(session.id, { leaseId: owner.id });
    assert.throws(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: other }),
      (e) => e.status === 409 && /No active orchestrator/.test(e.message),
    );
    registry.enrollOrchestrator(session.id, { leaseId: other.id, actor: 'other-chat' });
    registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: other });
  });
});

test('orchestrator: a stale active orchestrator does not block a fresh enroll', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const leaseA = makeLease(registry, session, 'chat-a');
    const leaseB = makeLease(registry, session, 'chat-b');
    registry.enrollOrchestrator(session.id, { leaseId: leaseA.id, actor: 'chat-a' });
    // Force staleness on the LIVE session record (createSession returns a clone).
    registry.getSession(session.id).orchestratorThread.activeOrchestrator.lastSeenAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.equal(registry.getActiveOrchestrator(session.id).stale, true);
    // Fresh enroll succeeds WITHOUT takeover because the holder is stale.
    const res = registry.enrollOrchestrator(session.id, { leaseId: leaseB.id, actor: 'chat-b' });
    assert.equal(res.activeOrchestrator.actor, 'chat-b');
  });
});
