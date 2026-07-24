import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

// Auto-audit is opt-in via autoAudit:true (production defaults it on; the test
// suite runs with ORCA_AUTO_AUDIT=false). These tests exercise it explicitly.
async function withAutoAuditRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-auto-audit-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: true });
  registry.stopScheduler();
  try {
    return await callback(registry);
  } finally {
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

// v2: the orchestrator RECORD is the container. Register it against the (approved)
// temp cwd; its executor lanes run through the getSession() container bridge.
async function makeOrchestrator(registry, { actor = 'test', title = 'Orch' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
}

// Seed an orchestrator container plus one executor lane under it. Per-lane flow
// config (auditTier/requireAuditPass/…) now rides on the lane's `flow` field
// (the deleted session container used to carry it); spawnPolicy lives on the
// orchestrator record.
async function seed(registry, { flow, spawnPolicy } = {}) {
  const { orchestrator } = await makeOrchestrator(registry);
  if (spawnPolicy) orchestrator.spawnPolicy = spawnPolicy;
  const lane = registry.createLane(
    orchestrator.id,
    { title: 'Work lane', executorType: 'mock', ...(flow ? { flow } : {}) },
    { actor: 'test', approved: true },
  );
  return { orchestrator, lane };
}

test('auto-audit: a finished executor lane auto-queues an audit when required', async () => {
  await withAutoAuditRegistry(async (registry) => {
    const { lane } = await seed(registry);
    const laneObj = registry.getLane(lane.id);
    registry.markLaneCompleted(laneObj);
    // require-audit-pass is on by default, so completion queues the audit.
    assert.equal(registry.getLane(lane.id).auditState, 'queued');
  });
});

test('auto-audit: an orchestrator-tier lane is left queued for the orchestrator (no auto-auditor, no escalation)', async () => {
  await withAutoAuditRegistry(async (registry) => {
    const { lane } = await seed(registry, {
      flow: { auditTier: 'orchestrator', requireAuditPass: true },
    });
    registry.markLaneCompleted(registry.getLane(lane.id));
    await registry.dispatchPendingAudits();
    // v2 contract: the owning orchestrator audits its executor. Orca never
    // auto-spawns a separate auditor and leaves the lane 'queued' for the
    // orchestrator to accept or bounce.
    assert.equal(registry.getLane(lane.id).auditState, 'queued');
    assert.equal(registry.lanes.filter((l) => l.owner === 'auditor').length, 0);
    // Re-ticking must not escalate it out from under the orchestrator.
    await registry.dispatchPendingAudits();
    assert.equal(registry.getLane(lane.id).auditState, 'queued');
  });
});

test('auto-audit: an orchestrator-container lane notifies its orchestrator and stays queued (never spawns an auditor)', async () => {
  await withAutoAuditRegistry(async (registry) => {
    // A real v2 orchestrator registered for the (approved) temp cwd; its
    // executor lanes run in the getSession orchestrator-container bridge.
    const orch = await registry.registerOrchestrator(
      { cwd: process.cwd(), actor: 'claude', title: 'v2' },
      { leaseId: 'L1' },
    );
    const lane = await registry.createLane(
      orch.id, { title: 'Work', executorType: 'mock' }, { actor: 'test', approved: true },
    );
    registry.markLaneCompleted(registry.getLane(lane.id));
    assert.equal(registry.getLane(lane.id).auditState, 'queued');

    await registry.dispatchPendingAudits();
    // Left queued for the orchestrator; NO separate auditor lane spawned.
    assert.equal(registry.getLane(lane.id).auditState, 'queued');
    assert.equal(registry.lanes.filter((l) => l.owner === 'auditor').length, 0);
    // A durable wakeup event was queued for the orchestrator to drain.
    const { events } = registry.drainAgentEvents(orch.id, { role: 'orchestrator' });
    const nudge = events.find((e) => e.type === 'audit_required' && e.laneId === lane.id);
    assert.ok(nudge, 'an audit_required event should be enqueued for the orchestrator');

    // Idempotent: a second tick must not duplicate the event or escalate.
    await registry.dispatchPendingAudits();
    assert.equal(registry.getLane(lane.id).auditState, 'queued');
    // (replayAgentEvents is gone with the event.replay tool — read the durable
    // queue itself, which is what drain projects from.)
    const again = registry.agentQueue
      .filter((e) => e.sessionId === orch.id && e.type === 'audit_required' && e.laneId === lane.id);
    assert.equal(again.length, 1, 'exactly one audit_required event per completion');
  });
});

test('auto-audit: auditor lanes do not recursively audit themselves', async () => {
  await withAutoAuditRegistry(async (registry) => {
    const { orchestrator } = await seed(registry);
    const auditorLane = registry.createLane(orchestrator.id, {
      title: 'Audit · Work lane', executorType: 'mock', owner: 'auditor', auditTargetLaneId: 'x',
    }, { actor: 'test', approved: true });
    registry.markLaneCompleted(registry.getLane(auditorLane.id));
    // An auditor lane completing must NOT queue an audit of itself.
    assert.notEqual(registry.getLane(auditorLane.id).auditState, 'queued');
    await registry.dispatchPendingAudits();
    const nested = registry.lanes.filter((l) => l.owner === 'auditor' && l.auditTargetLaneId === auditorLane.id);
    assert.equal(nested.length, 0);
  });
});

test('auto-audit: disabled when autoAudit is off', async () => {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-no-auto-audit-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  try {
    const { lane } = await seed(registry, {
      flow: { auditTier: 'orchestrator', requireAuditPass: true },
    });
    registry.markLaneCompleted(registry.getLane(lane.id));
    assert.notEqual(registry.getLane(lane.id).auditState, 'queued');
    await registry.dispatchPendingAudits();
    assert.equal(registry.lanes.filter((l) => l.owner === 'auditor').length, 0);
  } finally {
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
