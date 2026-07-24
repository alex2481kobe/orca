import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { availableToolIdsForRole } from '../src/agent-tools/roles.js';
import { buildNextActionEnvelope } from '../src/agent-tools/next-action.js';
import { findTool, getToolDefinitions, TOOL_DEFINITIONS } from '../src/agent-tools/tool-definitions.js';
import { ROLE_INSTRUCTIONS } from '../src/agent-tools/role-instructions.js';
import { chooseNextTool } from '../src/agent-tools/next-action.js';
import { OrcaRegistry } from '../src/registry.js';

async function withIsolatedRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-agent-tools-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000 });
  registry.stopScheduler();
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

// v2: the orchestrator RECORD is the lane container (no session records).
// registerOrchestrator creates the project keyed by cwd and returns the orc_
// container id; createLane / next-action take that id where a sessionId used to go.
async function makeOrchestrator(registry, { cwd = process.cwd(), actor = 'test', title = 'Orch' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd, actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
}

test('the tool table is public-safe and carries the core-loop tool ids', () => {
  const tools = getToolDefinitions();
  const ids = new Set(tools.map((tool) => tool.id));
  // The loop the whole product exists for: register -> spawn -> read -> audit ->
  // integrate or discard, plus the runtime paths that break without them.
  for (const id of [
    'orchestrator.register',
    'orchestrator.status',
    'orchestrator.resign',
    'executor.spawn',
    'lane.list',
    'lane.get',
    'lane.submit',
    'lane.terminal.tail',
    'lane.terminal.write',
    'lane.artifacts.list',
    'lane.artifacts.get',
    'lane.controls.update',
    'lane.shutdown',
    'lane.retry',
    'lane.delete',
    'approval.request',
    'approval.list',
    'approval.respond',
    'audit.queue_one',
    'audit.findings.record',
    'audit.accept',
    'audit.request_fix',
    'audit.block',
    'lane.integrate',
    'lane.worktree.discard',
    'fleet.emergency_stop',
    'event.drain',
    'project.preview.set',
  ]) {
    assert.equal(ids.has(id), true, `missing ${id}`);
  }
  // Public-safe: no local paths leak through the table, and every advertised tool
  // is really implemented and routed (an unimplemented row would be a lie).
  assert.equal(JSON.stringify(tools).includes(process.cwd()), false);
  assert.deepEqual(tools.filter((tool) => !tool.implemented || !tool.route).map((tool) => tool.id), []);

  // Tools deleted in the scale-back must stay gone from the surface AND from
  // every role's toolset — an agent must not be told to call a dead route.
  for (const dead of [
    'session.next_action', 'executor.capabilities', 'lane.create', 'lane.heartbeat',
    'audit.queue_all_ready', 'audit.log.read', 'audit.log.ack',
    'project.list', 'project.describe', 'project.quick_link.upsert',
    'project.quick_link.delete', 'project.quick_link.health',
    'orchestrator.update', 'orchestrator.heartbeat',
    'event.replay', 'event.ack',
    'tailscale.status', 'tailscale.serve.configure', 'orca.setup_guide',
    'artifact.cleanup', 'artifact.schedule',
    'project.create', 'project.archive', 'project.restore',
    'session.create', 'session.list', 'session.describe',
  ]) {
    assert.equal(findTool(dead), null, `deleted tool "${dead}" is still in the table`);
    for (const role of ['orchestrator', 'executor', 'auditor', 'dashboard']) {
      assert.equal(availableToolIdsForRole(role).includes(dead), false, `${role} can still call deleted "${dead}"`);
    }
  }

  // The one surviving preview tool points at the quick-link route the dashboard
  // renders from (/api/overview previews).
  assert.equal(findTool('project.preview.set')?.method, 'POST');
  assert.equal(findTool('project.preview.set')?.route, '/api/projects/{projectId}/quick-links');
});

// Regression guard for a bug this refactor actually shipped: registry-audit.js
// handed an agent nextRequiredTool:'session.next_action' / 'lane.create' AFTER
// both tools were deleted. Those literals live outside chooseNextTool (routes and
// registry methods override nextRequiredTool on refusals), so the coherence guard
// below could not see them. Sweep src/ for quoted tool-id-shaped literals instead.
test('no source file quotes a tool id that no longer exists', async () => {
  const liveIds = new Set(TOOL_DEFINITIONS.map((tool) => tool.id));
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

  // Dotted, lower_snake segments — the exact shape of a tool id. Restricted to the
  // known GROUPS so ordinary dotted prose/identifiers don't trip it.
  // 'orca' is deliberately absent: no live tool uses it as a group, and the
  // prefix collides with real non-tool strings ('orca.streams.v1', '*.ts.net').
  const GROUPS = ['orchestrator', 'executor', 'lane', 'approval', 'audit', 'fleet', 'event', 'project', 'session', 'tailscale', 'artifact'];
  const SHAPE = new RegExp(`'((?:${GROUPS.join('|')})\\.[a-z_][a-z0-9_.]*)'`, 'g');
  // Escape hatch for a dotted literal in these groups that is genuinely NOT a
  // tool id. Keep it short and specific; an empty set is the healthy state.
  const NOT_A_TOOL_ID = new Set([]);

  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const resolved = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(resolved); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = await fs.readFile(resolved, 'utf8');
      for (const match of text.matchAll(SHAPE)) {
        const id = match[1];
        if (liveIds.has(id) || NOT_A_TOOL_ID.has(id)) continue;
        offenders.push(`${path.relative(srcDir, resolved)}: '${id}'`);
      }
    }
  };
  await walk(srcDir);

  assert.deepEqual(
    offenders,
    [],
    `src/ quotes tool ids that are not in TOOL_DEFINITIONS (an agent would be told to call a dead route):\n  ${offenders.join('\n  ')}`,
  );
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
  const roles = ['orchestrator', 'executor', 'auditor', 'dashboard'];
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
    // v2: registering the orchestrator IS the container step (no session/enroll).
    // With a container but no lane, the orchestrator's next move is to create one.
    const { orchestrator } = await makeOrchestrator(registry, { title: 'Agent Tools Orch' });
    const planning = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: orchestrator.projectId,
      sessionId: orchestrator.id,
    });
    assert.equal(planning.nextRequiredTool, 'executor.spawn');
    assert.equal(planning.allowedTools.includes(planning.nextRequiredTool), true);
    assert.equal(findTool(planning.nextRequiredTool)?.implemented, true);

    const lane = registry.createLane(orchestrator.id, {
      title: 'Visual lane',
      executorType: 'mock',
      targetUrl: 'http://127.0.0.1:3000',
    }, { actor: 'test', approved: true });
    const active = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: orchestrator.projectId,
      sessionId: orchestrator.id,
      laneId: lane.id,
    });
    assert.equal(active.nextRequiredTool, 'orchestrator.status');
    assert.equal(active.nextToolImplemented, true);

    registry.markLaneCompleted(registry.getLane(lane.id));
    const audit = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: orchestrator.projectId,
      sessionId: orchestrator.id,
      laneId: lane.id,
    });
    assert.equal(audit.nextRequiredTool, 'audit.queue_one');
    assert.equal(audit.allowedTools.includes('audit.queue_one'), true);
    assert.equal(audit.auditRequired, true);
  });
});

test('nextAction capacity reflects the orchestrator real limits and live active-lane count', async () => {
  await withIsolatedRegistry(async (registry) => {
    const { orchestrator, lease } = await makeOrchestrator(registry, { title: 'Capacity Orch' });
    // Set a concrete container capacity (was hard-coded "2 slots / 0 active").
    registry.updateOrchestrator(orchestrator.id, { approvedCapacity: 5, laneConcurrencyLimit: 3 }, { leaseId: lease.id });

    // Two live lanes occupy slots (queued counts as live).
    registry.createLane(orchestrator.id, { title: 'L1', executorType: 'mock' }, { actor: 'test', approved: true });
    registry.createLane(orchestrator.id, { title: 'L2', executorType: 'mock' }, { actor: 'test', approved: true });

    const env = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: orchestrator.projectId,
      sessionId: orchestrator.id,
    });
    assert.equal(env.capacity.approvedCapacity, 5, 'reports the real approvedCapacity, not a hard-coded 2');
    assert.equal(env.capacity.laneConcurrencyLimit, 3);
    assert.equal(env.capacity.activeAgents, 2, 'reports the live count of active lanes');
    assert.equal(env.capacity.idleSlots, 1, 'idleSlots = limit - active');
    assert.equal(env.capacity.spawnPolicy, 'auto');
  });
});

test('session nextAction picks the highest-priority actionable lane after orchestrator enrollment', async () => {
  await withIsolatedRegistry(async (registry) => {
    // "Enrollment" is now registerOrchestrator: the container exists from the
    // moment the orchestrator is registered, and next-action resolves the
    // highest-priority actionable lane inside it.
    const { orchestrator } = await makeOrchestrator(registry, { title: 'Multi Lane Orch' });
    const acceptedLane = registry.createLane(orchestrator.id, {
      title: 'Already accepted',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const reviewLane = registry.createLane(orchestrator.id, {
      title: 'Needs audit',
      executorType: 'mock',
    }, { actor: 'test', approved: true });

    registry.markLaneCompleted(registry.getLane(acceptedLane.id));
    registry.acceptLaneAudit(acceptedLane.id, { actor: 'test-auditor', findings: ['reviewed'] });
    registry.markLaneCompleted(registry.getLane(reviewLane.id));

    // The accepted lane is no longer actionable, so next-action selects the lane
    // still awaiting audit and points at queuing it.
    const env = buildNextActionEnvelope(registry, {
      role: 'orchestrator',
      projectId: orchestrator.projectId,
      sessionId: orchestrator.id,
    });
    assert.equal(env.laneId, reviewLane.id);
    assert.equal(env.nextRequiredTool, 'audit.queue_one');
  });
});

test('tool leases are scoped, hashed at rest, and enforce allowed tools', async () => {
  await withIsolatedRegistry(async (registry, tempDir) => {
    // v2: the orchestrator container id stands in for the old sessionId; its
    // projectId is the lease's project scope.
    const { orchestrator } = await makeOrchestrator(registry, { title: 'Lease Orch' });
    const project = registry.projects.find((p) => p.id === orchestrator.projectId);
    const session = { id: orchestrator.id, projectId: orchestrator.projectId };
    const lane = registry.createLane(orchestrator.id, {
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
    assert.equal(issued.lease.allowedTools.includes('orchestrator.status'), true);
    assert.equal(issued.lease.lastUsedAt, null);
    assert.equal(JSON.stringify(registry.toolLeases).includes(issued.leaseToken), false);

    const validated = registry.validateToolLease(issued.leaseToken, {
      role: 'orchestrator',
      toolId: 'orchestrator.status',
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
      toolId: 'orchestrator.status',
    }), (error) => error.status === 401 && /expired/.test(error.message));

    assert.throws(() => registry.createToolLease({
      role: 'god',
      allowedTools: ['orchestrator.status'],
    }), (error) => error.status === 422 && /role must be/i.test(error.message));

    assert.throws(() => registry.createToolLease({
      role: 'executor',
      sessionId: session.id,
      allowedTools: ['lane.get'],
    }), (error) => error.status === 422 && /scoped to a lane/.test(error.message));

    assert.throws(() => registry.createToolLease({
      role: 'auditor',
      allowedTools: ['audit.queue_one'],
    }), (error) => error.status === 422 && /scoped to a session or lane/.test(error.message));

    const sessionAuditor = registry.createToolLease({
      role: 'auditor',
      sessionId: session.id,
      allowedTools: ['audit.queue_one'],
      actor: 'auditor-test',
    });
    assert.equal(sessionAuditor.lease.projectId, project.id);
    assert.equal(sessionAuditor.lease.sessionId, session.id);

    const sessionOnlyLease = registry.createToolLease({
      role: 'orchestrator',
      sessionId: session.id,
      allowedTools: ['lane.list', 'orchestrator.status'],
      actor: 'session-only-test',
    });
    assert.equal(sessionOnlyLease.lease.projectId, project.id);
    assert.equal(sessionOnlyLease.lease.sessionId, session.id);
    assert.equal(registry.validateToolLease(sessionOnlyLease.leaseToken, {
      role: 'orchestrator',
      toolId: 'lane.list',
      projectId: project.id,
    }).projectId, project.id);

    assert.throws(() => registry.createToolLease({
      role: 'executor',
      projectId: project.id,
      sessionId: session.id,
      laneId: lane.id,
      allowedTools: ['provider.secret.set'],
    }), (error) => error.status === 422 && /cannot grant/i.test(error.message));

    // A second container/project via a distinct approved cwd (subdir of tempDir).
    const otherCwd = path.join(tempDir, 'other-repo');
    await fs.mkdir(otherCwd, { recursive: true });
    const { orchestrator: otherOrchestrator } = await makeOrchestrator(registry, { cwd: otherCwd, actor: 'other-test', title: 'Other Orch' });
    const otherProject = registry.projects.find((p) => p.id === otherOrchestrator.projectId);
    assert.throws(() => registry.validateToolLease(sessionOnlyLease.leaseToken, {
      role: 'orchestrator',
      toolId: 'lane.list',
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
