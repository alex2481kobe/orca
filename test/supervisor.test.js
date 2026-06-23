import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import { buildNextActionEnvelope } from '../src/agent-tools.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-supervisor-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000 });
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

test('supervisor overview summarizes projects, sessions, orchestrators, backlog, and warnings', async () => {
  await withRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Supervisor Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Supervisor Session',
      spawnPolicy: 'auto',
      approvedCapacity: 2,
      worktreeMode: 'shared',
    }, { actor: 'test', approved: true });
    registry.addTask(session.id, { title: 'First task' }, { actor: 'supervisor' });
    registry.enrollOrchestrator(session.id, { leaseId: 'dashboard', actor: 'dashboard', source: 'dashboard' });
    const lane = registry.createLane(session.id, {
      title: 'Needs approval',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    registry.recordLaneApproval(lane.id, {
      kind: 'tool',
      detail: 'Executor wants to run a governed tool.',
      actor: 'executor',
    });

    const overview = registry.supervisorOverview();
    assert.equal(overview.projects.length, 1);
    const summarized = overview.projects[0].sessions[0];
    assert.equal(summarized.id, session.id);
    assert.equal(summarized.activeOrchestrator.active, true);
    assert.equal(summarized.worktreeMode, 'shared');
    assert.equal(summarized.backlog.counts.pending, 1);
    assert.equal(summarized.backlog.warnings.length, 1);
    assert.equal(summarized.approvals.pending, 1);
    assert.equal(summarized.approvals.lanes[0].laneId, lane.id);
    assert.equal(summarized.lanes[0].id, lane.id);
    assert.equal(summarized.lanes[0].pendingApprovals, 1);

    const next = buildNextActionEnvelope(registry, { role: 'supervisor' });
    assert.equal(next.nextRequiredTool, 'supervisor.overview');
    assert.equal(next.allowedTools.includes('session.supervisor_audit'), true);
    assert.equal(next.allowedTools.includes('lane.get'), true);
  });
});

test('supervisor bootstrap attaches to existing Orca state without duplicating sessions or lanes', async () => {
  await withRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Attach Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Attach Session' }, { actor: 'test', approved: true });
    registry.enrollOrchestrator(session.id, { leaseId: 'dashboard', actor: 'dashboard', source: 'dashboard' });
    const lane = registry.createLane(session.id, {
      title: 'Streaming worker',
      executorType: 'mock',
      taskDescription: 'Produce streamed progress.',
    }, { actor: 'test', approved: true });
    registry.appendLaneAgentEvent(registry.getLane(lane.id), {
      source: 'mock',
      type: 'message.assistant.delta',
      title: 'Worker update',
      content: 'checking files one by one',
      stream: 'stdout',
    }, { persist: true });

    const beforeCounts = {
      projects: registry.projects.length,
      sessions: registry.sessions.length,
      lanes: registry.lanes.length,
    };
    const bootstrap = registry.createOrchestratorMcpBootstrap({
      role: 'supervisor',
      projectId: project.id,
      sessionId: session.id,
      actor: 'codex-supervisor-chat',
    });
    assert.equal(registry.projects.length, beforeCounts.projects);
    assert.equal(registry.sessions.length, beforeCounts.sessions);
    assert.equal(registry.lanes.length, beforeCounts.lanes);
    assert.equal(bootstrap.lease.role, 'supervisor');
    assert.equal(bootstrap.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env.ORCA_ROLE, 'supervisor');

    const overview = registry.supervisorOverview();
    assert.equal(overview.activeSupervisors.length, 1);
    assert.equal(overview.activeSupervisors[0].actor, 'codex-supervisor-chat');
    assert.equal(overview.projects[0].sessions[0].activeOrchestrator.actor, 'dashboard');
    const summarizedLane = overview.projects[0].sessions[0].lanes.find((item) => item.id === lane.id);
    assert.ok(summarizedLane);
    assert.equal(summarizedLane.recentAgentEvents.some((event) => /checking files/.test(event.content)), true);

    registry.revokeToolLease(bootstrap.lease.id, { actor: 'dashboard' });
    assert.equal(registry.supervisorOverview().activeSupervisors.length, 0);
  });
});

test('supervisor audit records verdict and nudges the orchestrator thread', async () => {
  await withRegistry(async (registry) => {
    const project = registry.createProject({ name: 'Supervisor Audit Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Supervisor Audit Session' }, { actor: 'test', approved: true });
    const result = registry.recordSupervisorSessionAudit(session.id, {
      actor: 'supervisor',
      verdict: 'request_fix',
      summary: 'Needs tighter verification.',
      findings: ['No screenshot evidence attached.'],
      nextTask: 'Ask the orchestrator to capture evidence and rerun audit.',
    });
    assert.equal(result.supervisorReview.status, 'fix_requested');
    const stored = registry.getSession(session.id);
    assert.equal(stored.supervisorReview.verdict, 'request_fix');
    assert.equal(stored.orchestratorThread.messages.at(-1).role, 'system');
    assert.match(stored.orchestratorThread.messages.at(-1).content, /No screenshot evidence/);
    assert.ok(registry.auditEvents.some((event) =>
      event.type === 'session_supervisor_audited' && event.status === 'pending'));
    assert.throws(
      () => registry.recordSupervisorSessionAudit(session.id, {
        actor: 'supervisor',
        verdict: 'maybe',
      }),
      (error) => error.status === 422 && /verdict must be accept, request_fix, or block/.test(error.message)
    );
    assert.throws(
      () => registry.recordSupervisorSessionAudit(session.id, {
        actor: 'supervisor',
        verdict: 'request_fix',
      }),
      (error) => error.status === 422 && /request_fix requires/.test(error.message)
    );
    assert.throws(
      () => registry.recordSupervisorSessionAudit(session.id, {
        actor: 'supervisor',
        verdict: 'block',
      }),
      (error) => error.status === 422 && /block requires/.test(error.message)
    );
  });
});
