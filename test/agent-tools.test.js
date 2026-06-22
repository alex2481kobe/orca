import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  availableToolIdsForRole,
  buildAgentToolDiscovery,
  buildNextActionEnvelope,
  findTool,
} from '../src/agent-tools.js';
import { OrcaRegistry } from '../src/registry.js';

async function withIsolatedRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-agent-tools-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000 });
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
  assert.equal(discovery.contractVersion, 'orca.agent-tools.v1');
  assert.equal(discovery.publicSafe, true);
  const ids = new Set(discovery.tools.map((tool) => tool.id));
  for (const id of [
    'session.describe',
    'session.plan.update',
    'session.next_action',
    'executor.capabilities',
    'supervisor.overview',
    'lane.create',
    'lane.heartbeat',
    'lane.submit',
    'lane.shutdown',
    'lane.controls.update',
    'capacity.request',
    'capacity.approve',
    'capacity.reject',
    'capacity.set_policy',
    'session.worktree_policy.update',
    'critique.bundle.create',
    'critique.findings.record',
    'critique.waive',
    'audit.queue_one',
    'audit.queue_all_ready',
    'audit.findings.record',
    'audit.accept',
    'audit.request_fix',
    'audit.block',
    'evidence.capture_screenshot',
    'evidence.capture_video',
    'evidence.list',
    'evidence.latest',
    'evidence.cleanup_dry_run',
    'evidence.cleanup_apply',
    'provider.list',
    'provider.health',
    'provider.configure',
    'provider.secret.set',
    'provider.secret.delete',
    'project.list',
    'project.describe',
    'project.quick_link.upsert',
    'project.quick_link.delete',
    'project.quick_link.health',
    'project.archive',
    'project.restore',
    'settings.describe_effective',
    'settings.update',
    'settings.export',
    'settings.import_dry_run',
    'settings.import_apply',
    'orchestrator.message.send',
    'session.supervisor_audit',
  ]) {
    assert.equal(ids.has(id), true, `missing ${id}`);
  }
  assert.equal(JSON.stringify(discovery).includes(process.cwd()), false);
  assert.deepEqual(discovery.tools.filter((tool) => !tool.implemented || !tool.route).map((tool) => tool.id), []);
  assert.deepEqual(discovery.roles.flatMap((role) => role.plannedTools), []);
  assert.match(discovery.leasePolicy, /Scoped tool leases authenticate MCP and CLI agent calls/);
  assert.equal(discovery.leasePolicy.includes('future guarded'), false);
  assert.equal(discovery.leasePolicy.includes('normal dashboard auth today'), false);
  assert.equal(findTool('project.quick_link.upsert')?.method, 'POST');
  assert.equal(findTool('project.quick_link.upsert')?.route, '/api/projects/{projectId}/quick-links');
  assert.equal(findTool('project.quick_link.delete')?.route, '/api/projects/{projectId}/quick-links/{linkId}');
  assert.equal(findTool('project.quick_link.health')?.route, '/api/projects/{projectId}/quick-links/{linkId}/check');
  assert.equal(findTool('project.quick_link.health')?.implemented, true);
  assert.equal(findTool('project.archive')?.route, '/api/projects/{projectId}/archive');
  assert.equal(findTool('project.archive')?.implemented, true);
  assert.equal(findTool('project.restore')?.route, '/api/projects/{projectId}/restore');
  assert.equal(findTool('project.restore')?.implemented, true);
  assert.equal(availableToolIdsForRole('orchestrator').includes('project.archive'), false);
  assert.equal(availableToolIdsForRole('dashboard').includes('project.archive'), true);
  assert.equal(buildAgentToolDiscovery().roles.some((role) => role.role === 'supervisor'), true);
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
    assert.equal(planning.nextRequiredTool, 'orchestrator.enroll');
    assert.equal(planning.allowedTools.includes(planning.nextRequiredTool), true);
    assert.equal(findTool(planning.nextRequiredTool)?.implemented, true);
    registry.enrollOrchestrator(session.id, { leaseId: 'dashboard', actor: 'test-orchestrator' });
    const enrolledPlanning = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.equal(enrolledPlanning.nextRequiredTool, 'lane.create');

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

test('session nextAction picks the highest-priority actionable lane after orchestrator enrollment', async () => {
  await withIsolatedRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Multi Lane Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Multi Lane Session' }, { actor: 'test', approved: true });
    const acceptedLane = registry.createLane(session.id, {
      title: 'Already accepted',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const reviewLane = registry.createLane(session.id, {
      title: 'Needs audit',
      executorType: 'mock',
    }, { actor: 'test', approved: true });

    registry.markLaneCompleted(registry.getLane(acceptedLane.id));
    registry.acceptLaneAudit(acceptedLane.id, { actor: 'test-auditor' });
    registry.markLaneCompleted(registry.getLane(reviewLane.id));

    const beforeEnroll = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.equal(beforeEnroll.laneId, null);
    assert.equal(beforeEnroll.nextRequiredTool, 'orchestrator.enroll');

    registry.enrollOrchestrator(session.id, { leaseId: 'dashboard', actor: 'test-orchestrator', source: 'dashboard' });
    const afterEnroll = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.equal(afterEnroll.laneId, reviewLane.id);
    assert.equal(afterEnroll.nextRequiredTool, 'audit.queue_one');
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

test('Tailscale agent tools expose read-only setup and keep Serve configure admin-only', () => {
  const status = findTool('tailscale.status');
  assert.ok(status, 'tailscale.status tool exists');
  assert.equal(status.method, 'GET');
  assert.equal(status.route, '/api/private-access/tailnet');
  assert.equal(status.implemented, true);
  assert.equal(status.mutating, false);
  assert.ok(status.roles.includes('orchestrator'), 'orchestrator can read Tailscale status');

  const configure = findTool('tailscale.serve.configure');
  assert.ok(configure, 'tailscale.serve.configure tool exists');
  assert.equal(configure.method, 'POST');
  assert.equal(configure.route, '/api/private-access/serve');
  assert.equal(configure.implemented, true);
  assert.equal(configure.mutating, true);
  assert.deepEqual(configure.roles, ['dashboard']);
  assert.equal(availableToolIdsForRole('orchestrator').includes('tailscale.serve.configure'), false);

  const guide = findTool('orca.setup_guide');
  assert.ok(guide, 'orca.setup_guide tool exists');
  assert.equal(guide.route, '/api/private-access/setup-plan');
  assert.equal(guide.mutating, false);
  assert.ok(guide.roles.includes('orchestrator'), 'orchestrator can read setup guide');
});
