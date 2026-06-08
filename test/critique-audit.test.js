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

function createProjectSessionLane(registry, laneBody = {}, sessionBody = {}) {
  const project = registry.createProject({ name: 'Critique Audit Project' }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, {
    name: 'Critique Audit Session',
    ...sessionBody,
  }, { actor: 'test', approved: true });
  const lane = registry.createLane(session.id, {
    title: 'Critique Audit Lane',
    executorType: 'mock',
    ...laneBody,
  }, { actor: 'test', approved: true });
  return { project, session, lane };
}

test('agent-flow: audit mandatory + fix loop budget + routing per config', async () => {
  await withRegistry(async (registry) => {
    // Default flow: audit is required (require-audit-pass is on by default).
    const plain = createProjectSessionLane(registry);
    assert.equal(registry.auditRequiredForLane(registry.getLane(plain.lane.id)), true);

    // Configure an audit flow with a small loop budget and new-agent fix routing.
    const project = registry.createProject({ name: 'Flow Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Flow Session',
      settingsOverrides: { flow: { template: 'orchestrator-executor-audit', fixRouting: 'new-agent', maxAuditLoops: 1, requireAuditPass: true } },
    }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, { title: 'Flow Lane', executorType: 'mock' }, { actor: 'test', approved: true });
    const laneObj = registry.getLane(lane.id);
    assert.equal(registry.auditRequiredForLane(laneObj), true);

    // Drive the lane to ready_for_audit, then request a fix (loop 1, budget left 0 -> escalate next).
    registry.markLaneCompleted(laneObj);
    registry.queueLaneAudit(lane.id, { actor: 'auditor', approved: true });
    const fix1 = registry.requestLaneFix(lane.id, { actor: 'auditor', findings: ['lint'], nextTask: 'fix lint' });
    assert.equal(fix1.lane.auditLoopCount, 1);
    assert.equal(fix1.audit.fixRouting, 'new-agent');
    assert.equal(fix1.audit.loopsRemaining, 0);

    // nextAction reflects the flow: fix routed to a new agent => lane.create.
    const env = buildNextActionEnvelope(registry, { role: 'orchestrator', projectId: project.id, sessionId: session.id, laneId: lane.id });
    assert.equal(env.nextRequiredTool, 'lane.create');
    assert.equal(env.flow.template, 'orchestrator-executor-audit');
    assert.equal(env.flow.requireAuditPass, true);
    assert.equal(env.flow.returnToOrchestratorAllowed, false); // can't return to orch until audit passes

    // Second fix exhausts the budget -> escalation.
    const fix2 = registry.requestLaneFix(lane.id, { actor: 'auditor', findings: ['still broken'] });
    assert.equal(fix2.lane.auditState, 'escalated');
    assert.equal(fix2.audit.escalated, true);

    // Accepting the audit resets the loop budget and allows return to orchestrator.
    registry.acceptLaneAudit(lane.id, { actor: 'auditor' });
    const accepted = registry.getLane(lane.id);
    assert.equal(accepted.auditLoopCount, 0);
    const envAfter = buildNextActionEnvelope(registry, { role: 'orchestrator', projectId: project.id, sessionId: session.id, laneId: lane.id });
    assert.equal(envAfter.flow.returnToOrchestratorAllowed, true);
  });
});

test('required critique blocks audit until current findings are recorded', async () => {
  await withRegistry(async (registry) => {
    const { project, session, lane } = createProjectSessionLane(registry, {
      critiqueMode: 'required',
    });
    registry.markLaneCompleted(registry.getLane(lane.id));
    assert.equal(registry.getLane(lane.id).state, 'needs_critique');
    assert.throws(
      () => registry.queueLaneAudit(lane.id, { actor: 'test', approved: true }),
      (error) => error.status === 409,
    );

    const before = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
    });
    assert.equal(before.loopState, 'needs_self_verification');
    assert.equal(before.nextRequiredTool, 'critique.bundle.create');
    assert.equal(before.critiqueRequired, true);
    assert.equal(before.critiqueSatisfied, false);

    const bundle = registry.createCritiqueBundle(lane.id, { actor: 'executor' });
    assert.equal(typeof bundle.critiqueNonce, 'string');
    const recorded = registry.recordCritiqueFindings(lane.id, {
      actor: 'executor',
      critiqueNonce: bundle.critiqueNonce,
      checksRun: ['npm test'],
      issues: [],
      fixes: [],
      risks: [],
      ready: true,
    });
    assert.equal(recorded.lane.state, 'ready_for_audit');
    assert.equal(recorded.lane.critiqueState, 'satisfied');

    const after = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
    });
    assert.equal(after.nextRequiredTool, 'audit.queue_one');
    assert.equal(after.critiqueSatisfied, true);

    const queued = registry.queueLaneAudit(lane.id, { actor: 'auditor', approved: true });
    assert.equal(queued.event.status, 'pending');
    const accepted = registry.acceptLaneAudit(lane.id, {
      actor: 'auditor',
      findings: ['reviewed handoff'],
      reviewedFiles: ['src/example.js'],
    });
    assert.equal(accepted.lane.state, 'accepted');
    assert.equal(accepted.lane.auditState, 'accepted');
    const pending = registry.listAuditEvents({ status: 'pending' }).filter((event) => event.laneId === lane.id);
    assert.equal(pending.some((event) => event.type === 'lane_audit_queued'), false);
  });
});

test('visual-required critique refuses stale or missing screenshot evidence', async () => {
  await withRegistry(async (registry) => {
    const { project, session, lane } = createProjectSessionLane(registry, {
      targetUrl: 'http://127.0.0.1:4173',
    });
    registry.markLaneCompleted(registry.getLane(lane.id));
    assert.equal(registry.getLane(lane.id).critiqueMode, 'visual-required');

    const before = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
    });
    assert.equal(before.nextRequiredTool, 'evidence.capture_screenshot');
    assert.equal(before.evidenceRequired, true);
    assert.equal(before.evidenceFresh, false);

    const staleBundle = registry.createCritiqueBundle(lane.id, { actor: 'executor' });
    assert.throws(
      () => registry.recordCritiqueFindings(lane.id, {
        actor: 'executor',
        critiqueNonce: staleBundle.critiqueNonce,
        visualEvidenceReviewed: true,
        ready: true,
      }),
      (error) => error.status === 409,
    );

    const target = registry.getLane(lane.id);
    target.lastEvidenceCaptureAt = new Date(Date.now() + 1000).toISOString();
    target.lastEvidence = {
      status: 'captured',
      requested: ['screenshot'],
      produced: ['evidence-screenshot.png'],
    };
    const bundle = registry.createCritiqueBundle(lane.id, { actor: 'executor' });
    const recorded = registry.recordCritiqueFindings(lane.id, {
      actor: 'executor',
      critiqueNonce: bundle.critiqueNonce,
      checksRun: ['inspected screenshot'],
      visualEvidenceReviewed: true,
      ready: true,
    });
    assert.equal(recorded.lane.state, 'ready_for_audit');
    assert.equal(recorded.lane.critiqueState, 'satisfied');
  });
});

test('critique waiver is approval-gated, reasoned, and unlocks audit handoff', async () => {
  await withRegistry(async (registry) => {
    const { lane } = createProjectSessionLane(registry, {
      critiqueMode: 'required',
    });
    registry.markLaneCompleted(registry.getLane(lane.id));
    assert.throws(
      () => registry.waiveCritique(lane.id, {
        actor: 'orchestrator',
        reason: 'low-risk follow-up',
        approved: false,
      }),
      (error) => error.status === 409,
    );
    assert.throws(
      () => registry.waiveCritique(lane.id, {
        actor: 'orchestrator',
        approved: true,
      }),
      (error) => error.status === 422,
    );

    const waived = registry.waiveCritique(lane.id, {
      actor: 'orchestrator',
      reason: 'The user accepted the risk for this local-only docs lane.',
      approved: true,
    });
    assert.equal(waived.lane.critiqueState, 'waived');
    assert.equal(waived.lane.state, 'ready_for_audit');
    const queued = registry.queueLaneAudit(lane.id, { actor: 'orchestrator', approved: true });
    assert.equal(queued.event.status, 'pending');
  });
});

test('audit fix and block transitions are explicit and retryable where safe', async () => {
  await withRegistry(async (registry) => {
    const { lane } = createProjectSessionLane(registry);
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
    const { lane } = createProjectSessionLane(registry);
    registry.markLaneCompleted(registry.getLane(lane.id));
    registry.blockLaneAudit(lane.id, { actor: 'auditor', reason: 'Out of scope; needs human direction.' });
    assert.equal(registry.getLane(lane.id).state, 'blocked');
    // Previously blocked was not retryable -> a true dead end. Now it resets.
    const retried = registry.retryLane(lane.id, { actor: 'dashboard', approved: true });
    assert.equal(retried.state, 'queued');
    assert.equal(retried.auditState, 'not_queued');
  });
});
