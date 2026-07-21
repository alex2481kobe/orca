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
  ROLE_INSTRUCTIONS,
  TOOL_DEFINITIONS,
} from '../src/agent-tools.js';
import { chooseNextTool } from '../src/agent-tools/next-action.js';
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
    'session.next_action',
    'executor.capabilities',
    'lane.create',
    'lane.terminal.tail',
    'lane.heartbeat',
    'lane.submit',
    'lane.shutdown',
    'lane.controls.update',
    'session.worktree_policy.update',
    'audit.queue_one',
    'audit.queue_all_ready',
    'audit.findings.record',
    'audit.accept',
    'audit.request_fix',
    'audit.block',
    'project.list',
    'project.create',
    'project.describe',
    'project.quick_link.upsert',
    'project.quick_link.delete',
    'project.quick_link.health',
    'project.archive',
    'project.restore',
    'event.drain',
    'event.replay',
    'event.ack',
  ]) {
    assert.equal(ids.has(id), true, `missing ${id}`);
  }
  assert.equal(JSON.stringify(discovery).includes(process.cwd()), false);
  assert.deepEqual(discovery.tools.filter((tool) => !tool.implemented || !tool.route).map((tool) => tool.id), []);
  assert.deepEqual(discovery.roles.flatMap((role) => role.plannedTools), []);
  assert.match(discovery.leasePolicy, /Scoped tool leases authenticate MCP and CLI agent calls/);
  assert.equal(discovery.leasePolicy.includes('future guarded'), false);
  assert.equal(discovery.leasePolicy.includes('normal dashboard auth today'), false);
  assert.equal(findTool('project.create')?.method, 'POST');
  assert.equal(findTool('project.create')?.route, '/api/projects');
  assert.equal(availableToolIdsForRole('orchestrator').includes('project.create'), true);
  assert.equal(availableToolIdsForRole('supervisor').includes('project.create'), false);
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
});

test('supervisor docs match the bounded read/audit role contract', async () => {
  const doc = await fs.readFile(new URL('../docs/agent-supervisor-skill.md', import.meta.url), 'utf8');
  assert.match(doc, /does not mutate session plans, backlog tasks, capacity, worktree\s+policy, settings, lanes, or orchestrator ownership/i);
  assert.doesNotMatch(doc, /session\.plan\.update/);
  assert.doesNotMatch(doc, /task\.add|task\.bulk_add|task\.update/);
});

test('role instructions and next-action only reference live tool ids (v2 coherence guard)', () => {
  const liveIds = new Set(TOOL_DEFINITIONS.map((tool) => tool.id));
  // Dotted tokens that appear in the rulebook prose but are NOT tool ids. Kept
  // empty on purpose so the rulebook can only name real tools — add here only if a
  // non-tool dotted token is genuinely unavoidable.
  const NON_TOOL_WHITELIST = new Set([]);

  // 1. Every dotted-tool-shaped token in every role's rulebook must be a live tool
  // (mcp-server.js rewrites each id to its "__" MCP name, so a dead id would ship a
  // broken instruction to every agent on `initialize`).
  const TOOL_ID_SHAPE = /[a-z_]+\.[a-z_.]+/g;
  for (const [role, text] of Object.entries(ROLE_INSTRUCTIONS)) {
    for (const raw of text.match(TOOL_ID_SHAPE) || []) {
      const token = raw.replace(/\.+$/, ''); // strip trailing sentence periods
      if (NON_TOOL_WHITELIST.has(token)) continue;
      assert.equal(liveIds.has(token), true, `role "${role}" instructions reference dead tool id "${token}"`);
    }
  }
  // Explicitly prove the deleted-v1 tools are gone from the rulebook.
  const rulebook = Object.values(ROLE_INSTRUCTIONS).join('\n');
  for (const dead of [
    'supervisor.overview', 'supervisor.resign', 'session.memory', 'task.bulk_add',
    'loop.create', 'evidence.', 'critique.bundle', 'critique.findings', 'orchestrator.thread',
  ]) {
    assert.equal(rulebook.includes(dead), false, `rulebook still references deleted v1 tool "${dead}"`);
  }

  // 2. Drive chooseNextTool across every role x lane-state x flow branch it has and
  // assert each returned nextRequiredTool is live (or null). A mock registry
  // exercises both the enrolled and un-enrolled orchestrator gates.
  const roles = ['supervisor', 'orchestrator', 'executor', 'auditor', 'critique', 'dashboard'];
  const laneStates = [
    null, 'queued', 'starting', 'running', 'needs_critique', 'done', 'ready_for_audit',
    'auditing', 'fix_requested', 'accepted', 'failed', 'stopped', 'blocked', 'unknown-state',
  ];
  const flows = [
    { template: 'orchestrator-executor', fixRouting: 'same-agent' },
    { template: 'orchestrator-only', fixRouting: 'new-agent' },
  ];
  const registries = [
    { getActiveOrchestrator: () => ({ active: true, stale: false }) },
    { getActiveOrchestrator: () => ({ active: false, stale: true }) },
  ];
  const project = { id: 'p1', slug: 'p1', name: 'P' };
  const session = { id: 's1', name: 'S' };
  const scopes = [[null, null], [project, null], [project, session]];

  let returned = new Set();
  for (const role of roles) {
    for (const registry of registries) {
      for (const [proj, sess] of scopes) {
        for (const flow of flows) {
          for (const laneState of laneStates) {
            const lane = laneState === null ? null : { id: 'l1', state: laneState };
            for (const auditQueued of [false, true]) {
              const next = chooseNextTool({ registry, role, project: proj, session: sess, lane, auditQueued, flow });
              returned.add(next);
              assert.ok(
                next === null || liveIds.has(next),
                `chooseNextTool returned dead tool "${next}" (role=${role}, lane=${laneState}, auditQueued=${auditQueued}, flow=${flow.template})`,
              );
            }
          }
        }
      }
    }
  }
  // None of the deleted v1 tools may ever be returned.
  for (const dead of ['supervisor.overview', 'evidence.capture_screenshot', 'critique.bundle.create', 'critique.findings.record']) {
    assert.equal(returned.has(dead), false, `chooseNextTool can still return deleted tool "${dead}"`);
  }
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

    registry.markLaneCompleted(registry.getLane(lane.id));
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
      sessionId: session.id,
      allowedTools: ['lane.get'],
    }), (error) => error.status === 422 && /scoped to a lane/.test(error.message));

    assert.throws(() => registry.createToolLease({
      role: 'critique',
      sessionId: session.id,
      allowedTools: ['critique.bundle.create'],
    }), (error) => error.status === 422 && /scoped to a lane/.test(error.message));

    assert.throws(() => registry.createToolLease({
      role: 'auditor',
      allowedTools: ['audit.queue_all_ready'],
    }), (error) => error.status === 422 && /scoped to a session or lane/.test(error.message));

    const sessionAuditor = registry.createToolLease({
      role: 'auditor',
      sessionId: session.id,
      allowedTools: ['audit.queue_all_ready'],
      actor: 'auditor-test',
    });
    assert.equal(sessionAuditor.lease.projectId, project.id);
    assert.equal(sessionAuditor.lease.sessionId, session.id);

    const sessionOnlyLease = registry.createToolLease({
      role: 'orchestrator',
      sessionId: session.id,
      allowedTools: ['project.describe', 'session.next_action'],
      actor: 'session-only-test',
    });
    assert.equal(sessionOnlyLease.lease.projectId, project.id);
    assert.equal(sessionOnlyLease.lease.sessionId, session.id);
    assert.equal(registry.validateToolLease(sessionOnlyLease.leaseToken, {
      role: 'orchestrator',
      toolId: 'project.describe',
      projectId: project.id,
    }).projectId, project.id);

    assert.throws(() => registry.createToolLease({
      role: 'executor',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
      allowedTools: ['provider.secret.set'],
    }), (error) => error.status === 422 && /cannot grant/i.test(error.message));

    const otherProject = registry.createProject({ name: 'Other Lease Project' }, { actor: 'test', approved: true });
    assert.throws(() => registry.validateToolLease(sessionOnlyLease.leaseToken, {
      role: 'orchestrator',
      toolId: 'project.describe',
      projectId: otherProject.id,
    }), (error) => error.status === 403 && /project mismatch/.test(error.message));

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
