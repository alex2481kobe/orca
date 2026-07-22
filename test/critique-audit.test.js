import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildNextActionEnvelope } from '../src/agent-tools.js';
import { OrcaRegistry } from '../src/registry.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-critique-audit-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000 });
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

// v2: the orchestrator RECORD is the lane container (no session records). Register
// it against the (approved) temp cwd; createLane takes the orc_ id as first arg.
async function makeOrchestrator(registry, { actor = 'test', title = 'Orch' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
}

// The configurable agent-flow (template/fixRouting/maxAuditLoops/requireAuditPass)
// now rides on the lane's settingsOverrides (the deleted session container used to
// carry it).
async function createOrchestratorLane(registry, laneBody = {}) {
  const { orchestrator } = await makeOrchestrator(registry);
  const lane = registry.createLane(orchestrator.id, {
    title: 'Critique Audit Lane',
    executorType: 'mock',
    ...laneBody,
  }, { actor: 'test', approved: true });
  return { orchestrator, lane };
}

test('agent-flow: audit mandatory + fix loop budget + routing per config', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await makeOrchestrator(registry);

    // Default flow: audit is required (require-audit-pass is on by default).
    const plain = registry.createLane(orchestrator.id, {
      title: 'Plain Lane', executorType: 'mock',
    }, { actor: 'test', approved: true });
    assert.equal(registry.auditRequiredForLane(registry.getLane(plain.id)), true);

    // Configure an audit flow with a loop budget and new-agent fix routing on the
    // lane itself (lane-scoped effective settings).
    const lane = registry.createLane(orchestrator.id, {
      title: 'Flow Lane',
      executorType: 'mock',
      settingsOverrides: { flow: { template: 'orchestrator-executor-audit', fixRouting: 'new-agent', maxAuditLoops: 2, requireAuditPass: true } },
    }, { actor: 'test', approved: true });
    const laneObj = registry.getLane(lane.id);
    assert.equal(registry.auditRequiredForLane(laneObj), true);

    // Drive the lane to ready_for_audit, then request a fix (loop 1 of budget 2).
    registry.markLaneCompleted(laneObj);
    registry.queueLaneAudit(lane.id, { actor: 'auditor', approved: true });
    const fix1 = registry.requestLaneFix(lane.id, { actor: 'auditor', findings: ['lint'], nextTask: 'fix lint' });
    assert.equal(fix1.lane.auditLoopCount, 1);
    assert.equal(fix1.lane.auditState, 'fix_requested');
    assert.equal(fix1.audit.fixRouting, 'new-agent');
    assert.equal(fix1.audit.loopsRemaining, 1);

    // nextAction reflects the flow: fix routed to a new agent => lane.create.
    const env = buildNextActionEnvelope(registry, { role: 'orchestrator', projectId: orchestrator.projectId, sessionId: orchestrator.id, laneId: lane.id });
    assert.equal(env.nextRequiredTool, 'lane.create');
    assert.equal(env.flow.template, 'orchestrator-executor-audit');
    assert.equal(env.flow.requireAuditPass, true);
    assert.equal(env.flow.returnToOrchestratorAllowed, false); // can't return to orch until audit passes

    // Second fix exhausts the budget -> escalation.
    const fix2 = registry.requestLaneFix(lane.id, { actor: 'auditor', findings: ['still broken'] });
    assert.equal(fix2.lane.auditState, 'escalated');
    assert.equal(fix2.audit.escalated, true);

    // Accepting the audit resets the loop budget and allows return to orchestrator.
    registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });
    const accepted = registry.getLane(lane.id);
    assert.equal(accepted.auditLoopCount, 0);
    const envAfter = buildNextActionEnvelope(registry, { role: 'orchestrator', projectId: orchestrator.projectId, sessionId: orchestrator.id, laneId: lane.id });
    assert.equal(envAfter.flow.returnToOrchestratorAllowed, true);
  });
});

test('audit fix and block transitions are explicit and retryable where safe', async () => {
  await withRegistry(async (registry) => {
    const { lane } = await createOrchestratorLane(registry);
    registry.markLaneCompleted(registry.getLane(lane.id));
    registry.queueLaneAudit(lane.id, { actor: 'auditor', approved: true });

    const fix = registry.requestLaneFix(lane.id, {
      actor: 'auditor',
      findings: ['missing evidence'],
      nextTask: 'Capture evidence and update handoff.',
    });
    assert.equal(fix.lane.state, 'fix_requested');
    assert.equal(fix.lane.auditState, 'fix_requested');
    const retried = registry.retryLane(lane.id, { actor: 'orchestrator' });
    assert.equal(retried.state, 'queued');
    assert.equal(retried.auditState, 'not_queued');

    registry.markLaneCompleted(registry.getLane(lane.id));
    registry.queueLaneAudit(lane.id, { actor: 'auditor', approved: true });
    assert.throws(
      () => registry.blockLaneAudit(lane.id, { actor: 'auditor' }),
      (error) => error.status === 422,
    );
    const blocked = registry.blockLaneAudit(lane.id, {
      actor: 'auditor',
      reason: 'The lane cannot be audited because required evidence is unavailable.',
      findings: ['evidence unavailable'],
    });
    assert.equal(blocked.lane.state, 'blocked');
    assert.equal(blocked.lane.auditState, 'blocked');
  });
});

test('a blocked lane can be reset and retried (no dead end)', async () => {
  await withRegistry(async (registry) => {
    const { lane } = await createOrchestratorLane(registry);
    registry.markLaneCompleted(registry.getLane(lane.id));
    registry.blockLaneAudit(lane.id, { actor: 'auditor', reason: 'Out of scope; needs human direction.' });
    assert.equal(registry.getLane(lane.id).state, 'blocked');
    // Previously blocked was not retryable -> a true dead end. Now it resets.
    const retried = registry.retryLane(lane.id, { actor: 'dashboard', approved: true });
    assert.equal(retried.state, 'queued');
    assert.equal(retried.auditState, 'not_queued');
  });
});
