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
    'lane.terminal.tail',
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
    'orchestrator.thread.get',
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
  const supervisorRole = buildAgentToolDiscovery().roles.find((role) => role.role === 'supervisor');
  assert.ok(supervisorRole);
  const supervisorTools = new Set(supervisorRole.allowedImplementedTools);
  for (const id of [
    'supervisor.overview',
    'supervisor.resign',
    'orchestrator.thread.get',
    'orchestrator.status',
    'lane.list',
    'lane.get',
    'lane.terminal.tail',
    'approval.list',
    'evidence.list',
    'evidence.latest',
    'session.supervisor_audit',
    'tailscale.status',
    'orca.setup_guide',
  ]) {
    assert.equal(supervisorTools.has(id), true, `supervisor missing ${id}`);
  }
  for (const id of [
    'session.plan.update',
    'session.create',
    'capacity.set_policy',
    'session.worktree_policy.update',
    'settings.update',
    'task.add',
    'task.bulk_add',
    'task.update',
    'task.delete',
    'lane.create',
    'orchestrator.enroll',
  ]) {
    assert.equal(supervisorTools.has(id), false, `supervisor must not get ${id}`);
  }
  const supervisorMutatingTools = [...supervisorTools].filter((id) => findTool(id)?.mutating);
  assert.deepEqual(supervisorMutatingTools, ['supervisor.resign', 'session.supervisor_audit']);
});

test('supervisor docs match the bounded read/audit role contract', async () => {
  const doc = await fs.readFile(new URL('../docs/agent-supervisor-skill.md', import.meta.url), 'utf8');
  assert.match(doc, /does not mutate session plans, backlog tasks, capacity, worktree\s+policy, settings, lanes, or orchestrator ownership/i);
  assert.doesNotMatch(doc, /session\.plan\.update/);
  assert.doesNotMatch(doc, /task\.add|task\.bulk_add|task\.update/);
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

test('session nextAction ignores accepted lanes when backlog still has pending work', async () => {
  await withIsolatedRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Pending Backlog Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Pending Backlog Session' }, { actor: 'test', approved: true });
    const acceptedLane = registry.createLane(session.id, {
      title: 'Accepted history',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    registry.markLaneCompleted(registry.getLane(acceptedLane.id));
    registry.acceptLaneAudit(acceptedLane.id, { actor: 'test-auditor' });
    registry.addTask(session.id, { title: 'Pending next item', executorType: 'mock' });
    registry.enrollOrchestrator(session.id, { leaseId: 'dashboard', actor: 'test-orchestrator', source: 'dashboard' });

    const next = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.equal(next.laneId, null);
    assert.equal(next.nextRequiredTool, 'lane.create');
  });
});

test('session nextAction prefers manual backlog lane creation when live lanes leave idle capacity', async () => {
  await withIsolatedRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Idle Capacity Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Idle Capacity Session',
      approvedCapacity: 2,
      spawnPolicy: 'within_capacity',
    }, { actor: 'test', approved: true });
    registry.createLane(session.id, {
      title: 'Already running',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    registry.addTask(session.id, { title: 'Pending parallel item', executorType: 'mock' });
    registry.enrollOrchestrator(session.id, { leaseId: 'dashboard', actor: 'test-orchestrator', source: 'dashboard' });

    const next = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.equal(next.laneId, null);
    assert.equal(next.nextRequiredTool, 'lane.create');
    assert.equal(next.capacity.idleSlots, 1);
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
    assert.equal(issued.lease.lastUsedAt, null);
    assert.equal(JSON.stringify(registry.toolLeases).includes(issued.leaseToken), false);

    const validated = registry.validateToolLease(issued.leaseToken, {
      role: 'orchestrator',
      toolId: 'session.next_action',
      sessionId: session.id,
      laneId: lane.id,
    });
    assert.equal(validated.id, issued.lease.id);
    assert.ok(Date.parse(validated.lastUsedAt));
    assert.ok(Date.parse(registry.toolLeases.find((lease) => lease.id === issued.lease.id).lastUsedAt));
    assert.throws(() => registry.validateToolLease(issued.leaseToken, {
      role: 'orchestrator',
      toolId: 'provider.secret.set',
    }), (error) => error.status === 403);
    registry.toolLeases.find((lease) => lease.id === issued.lease.id).expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.throws(() => registry.validateToolLease(issued.leaseToken, {
      role: 'orchestrator',
      toolId: 'session.next_action',
    }), (error) => error.status === 401 && /expired/.test(error.message));

    assert.throws(() => registry.createToolLease({
      role: 'god',
      allowedTools: ['session.next_action'],
    }), (error) => error.status === 422 && /role must be/i.test(error.message));

    assert.throws(() => registry.createToolLease({
      role: 'executor',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
      allowedTools: ['provider.secret.set'],
    }), (error) => error.status === 422 && /cannot grant/i.test(error.message));

    const otherProject = registry.createProject({ name: 'Other Lease Project' }, { actor: 'test', approved: true });
    assert.throws(() => registry.createToolLease({
      role: 'executor',
      projectId: otherProject.id,
      laneId: lane.id,
      allowedTools: ['lane.get'],
    }), (error) => error.status === 422 && /lane does not belong to the requested project/.test(error.message));
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
