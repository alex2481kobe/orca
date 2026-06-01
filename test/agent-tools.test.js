import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildAgentToolDiscovery,
  buildNextActionEnvelope,
  findTool,
} from '../src/agent-tools.js';
import { CommandDeckRegistry } from '../src/registry.js';

async function withIsolatedRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-agent-tools-'));
  process.chdir(tempDir);
  const registry = new CommandDeckRegistry({ autoCompleteMs: 60 * 60 * 1000 });
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

test('agent tool discovery is public-safe and includes stable required tool ids', () => {
  const discovery = buildAgentToolDiscovery();
  assert.equal(discovery.contractVersion, 'command-deck.agent-tools.v1');
  assert.equal(discovery.publicSafe, true);
  const ids = new Set(discovery.tools.map((tool) => tool.id));
  for (const id of [
    'session.describe',
    'session.plan.update',
    'session.next_action',
    'executor.capabilities',
    'lane.create',
    'lane.claim',
    'lane.heartbeat',
    'lane.submit',
    'lane.block',
    'lane.shutdown',
    'lane.archive',
    'capacity.request',
    'capacity.approve',
    'capacity.reject',
    'capacity.set_policy',
    'critique.bundle.create',
    'critique.findings.record',
    'critique.waive',
    'audit.queue_one',
    'audit.queue_all_ready',
    'audit.claim',
    'audit.findings.record',
    'audit.accept',
    'audit.request_fix',
    'audit.block',
    'evidence.capture_screenshot',
    'evidence.capture_video',
    'evidence.attach_artifact',
    'evidence.list',
    'evidence.latest',
    'evidence.cleanup_dry_run',
    'evidence.cleanup_apply',
    'provider.list',
    'provider.health',
    'provider.configure',
    'provider.secret.set',
    'provider.secret.delete',
    'provider.install_plan',
    'provider.update_plan',
    'project.list',
    'project.describe',
    'project.quick_link.upsert',
    'project.quick_link.delete',
    'project.quick_link.health',
    'project.archive',
    'project.restore',
    'project.reorder',
    'settings.describe_effective',
    'settings.update',
    'settings.export',
    'settings.import_dry_run',
    'settings.import_apply',
  ]) {
    assert.equal(ids.has(id), true, `missing ${id}`);
  }
  assert.equal(JSON.stringify(discovery).includes(process.cwd()), false);
  assert.equal(findTool('project.quick_link.upsert')?.route, '/api/projects/{projectId}/quick-links');
  assert.equal(findTool('project.quick_link.delete')?.route, '/api/projects/{projectId}/quick-links/{linkId}');
  assert.equal(findTool('project.quick_link.health')?.route, '/api/projects/{projectId}/quick-links/{linkId}/check');
  assert.equal(findTool('project.quick_link.health')?.implemented, true);
});

test('nextAction envelope only advertises an implemented nextRequiredTool', async () => {
  await withIsolatedRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Agent Tools Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Agent Tools Session' }, { actor: 'test', approved: true });
    const planning = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.equal(planning.nextRequiredTool, 'lane.create');
    assert.equal(planning.allowedTools.includes(planning.nextRequiredTool), true);
    assert.equal(findTool(planning.nextRequiredTool)?.implemented, true);

    const lane = registry.createLane(session.id, {
      title: 'Visual lane',
      executorType: 'mock',
      targetUrl: 'http://127.0.0.1:3000',
    }, { actor: 'test', approved: true });
    const active = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
    });
    assert.equal(active.nextRequiredTool, 'session.next_action');
    assert.equal(active.nextToolImplemented, true);
    assert.equal(active.evidenceRequired, true);
    assert.equal(active.evidenceFresh, false);

    registry.markLaneCompleted(registry.getLane(lane.id));
    const critique = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
    });
    assert.equal(critique.nextRequiredTool, 'evidence.capture_screenshot');
    assert.equal(critique.critiqueRequired, true);
    assert.equal(critique.critiqueSatisfied, false);
    const target = registry.getLane(lane.id);
    target.lastEvidenceCaptureAt = new Date(Date.now() + 1000).toISOString();
    target.lastEvidence = {
      status: 'captured',
      requested: ['screenshot'],
      produced: ['evidence-screenshot.png'],
    };
    const bundle = registry.createCritiqueBundle(lane.id, { actor: 'test' });
    registry.recordCritiqueFindings(lane.id, {
      actor: 'test',
      critiqueNonce: bundle.critiqueNonce,
      checksRun: ['reviewed screenshot'],
      visualEvidenceReviewed: true,
      ready: true,
    });
    const audit = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
    });
    assert.equal(audit.nextRequiredTool, 'audit.queue_one');
    assert.equal(audit.allowedTools.includes('audit.queue_one'), true);
    assert.equal(audit.auditRequired, true);
  });
});

test('tool leases are scoped, hashed at rest, and enforce allowed tools', async () => {
  await withIsolatedRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Lease Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Lease Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'Lease Lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const nextAction = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
    });
    const issued = registry.createToolLease({
      role: nextAction.role,
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
      allowedTools: nextAction.allowedTools,
      actor: 'test',
      ttlMs: 60000,
    });
    assert.equal(Boolean(issued.leaseToken), true);
    assert.equal(issued.lease.allowedTools.includes('session.next_action'), true);
    assert.equal(JSON.stringify(registry.toolLeases).includes(issued.leaseToken), false);

    const validated = registry.validateToolLease(issued.leaseToken, {
      role: 'orchestrator',
      toolId: 'session.next_action',
      sessionId: session.id,
      laneId: lane.id,
    });
    assert.equal(validated.id, issued.lease.id);
    assert.throws(() => registry.validateToolLease(issued.leaseToken, {
      role: 'orchestrator',
      toolId: 'provider.secret.set',
    }), (error) => error.status === 403);
  });
});
