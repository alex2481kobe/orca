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

function seed(registry, sessionBody = {}) {
  const project = registry.createProject({ name: 'Auto Audit Project' }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, { name: 'Auto Audit Session', ...sessionBody }, { actor: 'test', approved: true });
  const lane = registry.createLane(session.id, { title: 'Work lane', executorType: 'mock' }, { actor: 'test', approved: true });
  return { project, session, lane };
}

test('auto-audit: a finished executor lane auto-queues an audit when required', async () => {
  await withAutoAuditRegistry(async (registry) => {
    const { lane } = seed(registry);
    const laneObj = registry.getLane(lane.id);
    registry.markLaneCompleted(laneObj);
    // require-audit-pass is on by default, so completion queues the audit.
    assert.equal(registry.getLane(lane.id).auditState, 'queued');
  });
});

test('auto-audit: separate-auditor tier spawns a dedicated auditor lane', async () => {
  await withAutoAuditRegistry(async (registry) => {
    const { session, lane } = seed(registry, {
      settingsOverrides: { flow: { auditTier: 'separate-auditor', requireAuditPass: true } },
    });
    registry.markLaneCompleted(registry.getLane(lane.id));
    assert.equal(registry.getLane(lane.id).auditState, 'queued');

    await registry.dispatchPendingAudits();

    const auditor = registry.lanes.find((l) => l.owner === 'auditor' && l.auditTargetLaneId === lane.id);
    assert.ok(auditor, 'a dedicated auditor lane should be spawned for the executor lane');
    assert.equal(auditor.sessionId, session.id);
    // The executor lane is marked auditing so it is not dispatched again.
    assert.equal(registry.getLane(lane.id).auditState, 'auditing');

    // Idempotent: a second pass must not spawn a second auditor.
    await registry.dispatchPendingAudits();
    const auditorCount = registry.lanes.filter((l) => l.owner === 'auditor' && l.auditTargetLaneId === lane.id).length;
    assert.equal(auditorCount, 1);
  });
});

test('auto-audit: the spawned auditor lane gets the auditor tool role', async () => {
  await withAutoAuditRegistry(async (registry) => {
    const { lane } = seed(registry, {
      settingsOverrides: { flow: { auditTier: 'separate-auditor', requireAuditPass: true } },
    });
    registry.markLaneCompleted(registry.getLane(lane.id));
    await registry.dispatchPendingAudits();
    const auditor = registry.lanes.find((l) => l.owner === 'auditor');
    const env = registry.ensureLaneToolLease(auditor);
    assert.equal(env.ORCA_ROLE, 'auditor');
  });
});

test('auto-audit: orchestrator tier nudges the orchestrator (creates an orchestrator turn)', async () => {
  await withAutoAuditRegistry(async (registry) => {
    const { session, lane } = seed(registry, {
      settingsOverrides: { flow: { auditTier: 'orchestrator', requireAuditPass: true } },
    });
    registry.markLaneCompleted(registry.getLane(lane.id));
    await registry.dispatchPendingAudits();
    const orchestratorLane = registry.lanes.find((l) => l.owner === 'orchestrator' && l.sessionId === session.id);
    assert.ok(orchestratorLane, 'an orchestrator turn should be created to run the audit');
    assert.equal(registry.getLane(lane.id).auditState, 'auditing');
  });
});

test('auto-audit: auditor lanes do not recursively audit themselves', async () => {
  await withAutoAuditRegistry(async (registry) => {
    const { session } = seed(registry, {
      settingsOverrides: { flow: { auditTier: 'separate-auditor', requireAuditPass: true } },
    });
    const auditorLane = registry.createLane(session.id, {
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
    const { lane } = seed(registry, {
      settingsOverrides: { flow: { auditTier: 'separate-auditor', requireAuditPass: true } },
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
