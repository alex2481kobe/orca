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

    const overview = registry.supervisorOverview();
    assert.equal(overview.projects.length, 1);
    const summarized = overview.projects[0].sessions[0];
    assert.equal(summarized.id, session.id);
    assert.equal(summarized.activeOrchestrator.active, true);
    assert.equal(summarized.worktreeMode, 'shared');
    assert.equal(summarized.backlog.counts.pending, 1);
    assert.equal(summarized.backlog.warnings.length, 1);

    const next = buildNextActionEnvelope(registry, { role: 'supervisor' });
    assert.equal(next.nextRequiredTool, 'supervisor.overview');
    assert.equal(next.allowedTools.includes('session.supervisor_audit'), true);
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
  });
});
