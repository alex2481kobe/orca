import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const SERVER_ENTRYPOINT = path.join(process.cwd(), 'src', 'server.js');
let counter = 0;

function parseJson(rawText) {
  try { return rawText ? JSON.parse(rawText) : null; } catch { return { raw: rawText }; }
}

async function withServer(callback) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-supervisor-api-'));
  process.chdir(tempDir);
  process.env.ORCA_API_TOKEN = 'supervisor-api-token';
  process.env.PORT = '0';
  const moduleUrl = `${pathToFileURL(SERVER_ENTRYPOINT).href}?supervisor-api=${Date.now()}-${++counter}`;
  const { routeRequest, stopServer } = await import(moduleUrl);
  const requestJson = async (requestPath, { method = 'GET', headers = {}, body } = {}) => {
    const chunks = [];
    const req = new PassThrough();
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
      end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
    };
    req.method = method;
    req.url = requestPath;
    req.headers = { 'content-type': 'application/json', ...headers };
    const pending = routeRequest(req, res);
    req.end(body === undefined ? undefined : JSON.stringify(body));
    await pending;
    return { status: res.statusCode, body: parseJson(Buffer.concat(chunks).toString('utf8')) };
  };
  try {
    await callback({ requestJson, token: process.env.ORCA_API_TOKEN });
  } finally {
    if (typeof stopServer === 'function') await stopServer();
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('supervisor API overview and session audit are token-gated and routed', async () => {
  await withServer(async ({ requestJson, token }) => {
    const denied = await requestJson('/api/supervisor/overview');
    assert.equal(denied.status, 401);

    const project = await requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Supervisor API Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Supervisor API Session', approved: true },
    });
    assert.equal(session.status, 201);

    const overview = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-token': token },
    });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.projects[0].sessions[0].id, session.body.id);

    const audit = await requestJson(`/api/sessions/${session.body.id}/supervisor/audit`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'supervisor', verdict: 'accept', summary: 'Looks good.' },
    });
    assert.equal(audit.status, 200);
    assert.equal(audit.body.supervisorReview.status, 'accepted');

    const invalidAudit = await requestJson(`/api/sessions/${session.body.id}/supervisor/audit`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'supervisor', verdict: 'maybe' },
    });
    assert.equal(invalidAudit.status, 422);
    assert.match(invalidAudit.body.error, /verdict must be accept, request_fix, or block/);
  });
});

test('supervisor overview respects scoped supervisor tool leases', async () => {
  await withServer(async ({ requestJson, token }) => {
    const projectA = await requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Scoped Supervisor A', approved: true },
    });
    assert.equal(projectA.status, 201);
    const projectB = await requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Scoped Supervisor B', approved: true },
    });
    assert.equal(projectB.status, 201);
    const sessionA1 = await requestJson(`/api/projects/${projectA.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Scoped Session A1', approved: true },
    });
    assert.equal(sessionA1.status, 201);
    const sessionA2 = await requestJson(`/api/projects/${projectA.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Scoped Session A2', approved: true },
    });
    assert.equal(sessionA2.status, 201);
    const sessionB = await requestJson(`/api/projects/${projectB.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Scoped Session B', approved: true },
    });
    assert.equal(sessionB.status, 201);

    const projectLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'project-supervisor', role: 'supervisor', projectId: projectA.body.id, ttlMs: 60_000 },
    });
    assert.equal(projectLease.status, 201);
    const projectOverview = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-tool-lease': projectLease.body.leaseToken },
    });
    assert.equal(projectOverview.status, 200);
    assert.deepEqual(projectOverview.body.projects.map((project) => project.id), [projectA.body.id]);
    assert.deepEqual(projectOverview.body.projects[0].sessions.map((session) => session.id).sort(), [sessionA1.body.id, sessionA2.body.id].sort());
    assert.deepEqual(projectOverview.body.activeSupervisors.map((lease) => lease.actor), ['project-supervisor']);
    assert.ok(Date.parse(projectOverview.body.activeSupervisors[0].lastSeenAt));

    const foreignOverview = await requestJson(`/api/supervisor/overview?projectId=${projectB.body.id}`, {
      headers: { 'x-orca-tool-lease': projectLease.body.leaseToken },
    });
    assert.equal(foreignOverview.status, 403);
    assert.match(foreignOverview.body.error, /Tool lease project mismatch/);

    const sessionLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'session-supervisor', role: 'supervisor', sessionId: sessionA1.body.id, ttlMs: 60_000 },
    });
    assert.equal(sessionLease.status, 201);
    const sessionOverview = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-tool-lease': sessionLease.body.leaseToken },
    });
    assert.equal(sessionOverview.status, 200);
    assert.deepEqual(sessionOverview.body.projects.map((project) => project.id), [projectA.body.id]);
    assert.deepEqual(sessionOverview.body.projects[0].sessions.map((session) => session.id), [sessionA1.body.id]);
    assert.deepEqual(sessionOverview.body.activeSupervisors.map((lease) => lease.actor), ['session-supervisor']);

    const scopedThread = await requestJson(`/api/sessions/${sessionA1.body.id}/orchestrator`, {
      headers: { 'x-orca-tool-lease': sessionLease.body.leaseToken },
    });
    assert.equal(scopedThread.status, 200);
    assert.equal(scopedThread.body.sessionId, sessionA1.body.id);

    const hiddenThread = await requestJson(`/api/sessions/${sessionA2.body.id}/orchestrator`, {
      headers: { 'x-orca-tool-lease': sessionLease.body.leaseToken },
    });
    assert.equal(hiddenThread.status, 403);
    assert.match(hiddenThread.body.error, /Tool lease session mismatch/);
  });
});

test('orchestrator enroll rejects non-orchestrator tool leases at the route boundary', async () => {
  await withServer(async ({ requestJson, token }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Wrong Role Orchestrator Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Wrong Role Orchestrator Session', approved: true },
    });
    assert.equal(session.status, 201);
    const executorLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'executor-not-orchestrator', role: 'executor', projectId: project.body.id, sessionId: session.body.id, ttlMs: 60_000 },
    });
    assert.equal(executorLease.status, 201);
    assert.equal(executorLease.body.lease.role, 'executor');
    assert.equal(executorLease.body.lease.allowedTools.includes('orchestrator.enroll'), false);

    const denied = await requestJson(`/api/sessions/${session.body.id}/orchestrator/enroll`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': executorLease.body.leaseToken },
      body: { takeover: true },
    });
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /Tool lease does not grant this tool/);

    const status = await requestJson(`/api/sessions/${session.body.id}/orchestrator/status`, {
      headers: { 'x-orca-token': token },
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.activeOrchestrator.active, false);
  });
});

test('supervisor resign revokes only the caller supervisor lease', async () => {
  await withServer(async ({ requestJson, token }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Supervisor Resign Project', approved: true },
    });
    assert.equal(project.status, 201);

    const supervisorA = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'supervisor-a', role: 'supervisor', projectId: project.body.id, ttlMs: 60_000 },
    });
    assert.equal(supervisorA.status, 201);
    const supervisorB = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'supervisor-b', role: 'supervisor', projectId: project.body.id, ttlMs: 60_000 },
    });
    assert.equal(supervisorB.status, 201);

    const adminDenied = await requestJson('/api/supervisor/resign', {
      method: 'POST',
      headers: { 'x-orca-token': token },
    });
    assert.equal(adminDenied.status, 403);
    assert.match(adminDenied.body.error, /supervisor tool lease/i);

    const before = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-token': token },
    });
    assert.deepEqual(before.body.activeSupervisors.map((lease) => lease.actor).sort(), ['supervisor-a', 'supervisor-b']);

    const malformedDenied = await requestJson('/api/supervisor/resign', {
      method: 'POST',
      headers: { 'x-orca-tool-lease': 'not-a-real-lease-token' },
    });
    assert.equal(malformedDenied.status, 401);
    assert.match(malformedDenied.body.error, /not found/i);
    const afterMalformed = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-token': token },
    });
    assert.deepEqual(afterMalformed.body.activeSupervisors.map((lease) => lease.actor).sort(), ['supervisor-a', 'supervisor-b']);

    const resigned = await requestJson('/api/supervisor/resign', {
      method: 'POST',
      headers: { 'x-orca-tool-lease': supervisorA.body.leaseToken },
    });
    assert.equal(resigned.status, 200);
    assert.equal(resigned.body.resigned, true);
    assert.equal(resigned.body.lease.actor, 'supervisor-a');
    assert.equal(resigned.body.lease.active, false);
    assert.ok(resigned.body.lease.revokedAt);

    const after = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-token': token },
    });
    assert.deepEqual(after.body.activeSupervisors.map((lease) => lease.actor), ['supervisor-b']);

    const revokedCannotRead = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-tool-lease': supervisorA.body.leaseToken },
    });
    assert.equal(revokedCannotRead.status, 401);
    assert.match(revokedCannotRead.body.error, /revoked/i);

    const stillActive = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-tool-lease': supervisorB.body.leaseToken },
    });
    assert.equal(stillActive.status, 200);
    assert.deepEqual(stillActive.body.activeSupervisors.map((lease) => lease.actor), ['supervisor-b']);
    assert.ok(Date.parse(stillActive.body.activeSupervisors[0].lastSeenAt));
  });
});

test('orchestrator MCP bootstrap attaches to existing Orca state without duplicating records', async () => {
  await withServer(async ({ requestJson, token }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Orchestrator Attach Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Orchestrator Attach Session', approved: true },
    });
    assert.equal(session.status, 201);
    const lane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Existing lane', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201);

    const counts = async () => {
      const projects = await requestJson('/api/projects', { headers: { 'x-orca-token': token } });
      const sessions = await requestJson(`/api/projects/${project.body.id}/sessions`, { headers: { 'x-orca-token': token } });
      const lanes = await requestJson(`/api/sessions/${session.body.id}/lanes`, { headers: { 'x-orca-token': token } });
      assert.equal(projects.status, 200);
      assert.equal(sessions.status, 200);
      assert.equal(lanes.status, 200);
      return {
        projects: projects.body.length,
        sessions: sessions.body.length,
        lanes: lanes.body.length,
      };
    };
    const before = await counts();

    const bootstrapA = await requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'codex-orchestrator-chat-a',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(bootstrapA.status, 201);
    assert.equal(bootstrapA.body.lease.role, 'orchestrator');
    assert.equal(bootstrapA.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env.ORCA_ROLE, 'orchestrator');
    assert.deepEqual(await counts(), before);

    const enrolledA = await requestJson(`/api/sessions/${session.body.id}/orchestrator/enroll`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': bootstrapA.body.leaseToken },
      body: {},
    });
    assert.equal(enrolledA.status, 200);
    assert.equal(enrolledA.body.activeOrchestrator.actor, 'codex-orchestrator-chat-a');
    assert.deepEqual(await counts(), before);

    const bootstrapB = await requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'codex-orchestrator-chat-b',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(bootstrapB.status, 201);
    assert.deepEqual(await counts(), before);

    const refusedB = await requestJson(`/api/sessions/${session.body.id}/orchestrator/enroll`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': bootstrapB.body.leaseToken },
      body: {},
    });
    assert.equal(refusedB.status, 409);
    assert.equal(refusedB.body.current.actor, 'codex-orchestrator-chat-a');

    const takeoverB = await requestJson(`/api/sessions/${session.body.id}/orchestrator/enroll`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': bootstrapB.body.leaseToken },
      body: { takeover: true },
    });
    assert.equal(takeoverB.status, 200);
    assert.equal(takeoverB.body.activeOrchestrator.actor, 'codex-orchestrator-chat-b');
    assert.deepEqual(await counts(), before);

    const status = await requestJson(`/api/sessions/${session.body.id}/orchestrator/status`, {
      headers: { 'x-orca-tool-lease': bootstrapB.body.leaseToken },
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.activeOrchestrator.actor, 'codex-orchestrator-chat-b');
    assert.equal(String(status.body.tree || '').includes('Existing lane'), true);

    const revokedB = await requestJson(`/api/agent-tools/leases/${bootstrapB.body.lease.id}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
    });
    assert.equal(revokedB.status, 200);
    assert.equal(revokedB.body.lease.active, false);

    const bootstrapC = await requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'codex-orchestrator-chat-c',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(bootstrapC.status, 201);
    assert.deepEqual(await counts(), before);

    const staleOwnerCreate = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': bootstrapC.body.leaseToken },
      body: { title: 'Must enroll first', executorType: 'mock', approved: true },
    });
    assert.equal(staleOwnerCreate.status, 409);
    assert.match(staleOwnerCreate.body.error, /active orchestrator.*stale/i);
    assert.equal(staleOwnerCreate.body.nextAction.nextRequiredTool, 'orchestrator.enroll');

    const enrolledC = await requestJson(`/api/sessions/${session.body.id}/orchestrator/enroll`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': bootstrapC.body.leaseToken },
      body: {},
    });
    assert.equal(enrolledC.status, 200);
    assert.equal(enrolledC.body.activeOrchestrator.actor, 'codex-orchestrator-chat-c');

    const createdByC = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': bootstrapC.body.leaseToken },
      body: { title: 'Replacement chat lane', executorType: 'mock', approved: true },
    });
    assert.equal(createdByC.status, 201);
    assert.equal(createdByC.body.title, 'Replacement chat lane');
  });
});

test('MCP tool leases can update worktree policy and supervisor state with scoped gates', async () => {
  await withServer(async ({ requestJson, token }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Supervisor Lease Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Supervisor Lease Session', approved: true },
    });
    assert.equal(session.status, 201);
    const otherSession = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Other Lease Session', approved: true },
    });
    assert.equal(otherSession.status, 201);

    const orchestratorLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        role: 'orchestrator',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(orchestratorLease.status, 201);
    assert.equal(orchestratorLease.body.lease.role, 'orchestrator');
    assert.ok(orchestratorLease.body.leaseToken);

    const enrolled = await requestJson(`/api/sessions/${session.body.id}/orchestrator/enroll`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': orchestratorLease.body.leaseToken },
      body: { actor: 'orchestrator' },
    });
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.body.activeOrchestrator.active, true);

    const worktree = await requestJson(`/api/sessions/${session.body.id}/worktree-policy`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': orchestratorLease.body.leaseToken },
      body: { worktreeMode: 'shared', approved: true },
    });
    assert.equal(worktree.status, 200);
    assert.equal(worktree.body.worktreeMode, 'shared');

    const invalidWorktree = await requestJson(`/api/sessions/${session.body.id}/worktree-policy`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': orchestratorLease.body.leaseToken },
      body: { worktreeMode: 'floaty', approved: true },
    });
    assert.equal(invalidWorktree.status, 422);
    assert.match(invalidWorktree.body.error, /worktreeMode must be isolated or shared/);

    const scopedOut = await requestJson(`/api/sessions/${otherSession.body.id}/worktree-policy`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': orchestratorLease.body.leaseToken },
      body: { worktreeMode: 'shared', approved: true },
    });
    assert.equal(scopedOut.status, 403);
    assert.match(scopedOut.body.error, /Tool lease session mismatch/);

    const supervisorLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'attached-supervisor', role: 'supervisor', ttlMs: 10 * 60 * 1000 },
    });
    assert.equal(supervisorLease.status, 201);
    assert.equal(supervisorLease.body.lease.role, 'supervisor');
    assert.ok(supervisorLease.body.leaseToken);
    assert.equal(supervisorLease.body.lease.allowedTools.includes('lane.get'), true);
    assert.equal(supervisorLease.body.lease.allowedTools.includes('lane.terminal.tail'), true);
    assert.equal(supervisorLease.body.lease.allowedTools.includes('approval.list'), true);
    assert.equal(supervisorLease.body.lease.allowedTools.includes('evidence.latest'), true);
    assert.equal(supervisorLease.body.lease.allowedTools.includes('orchestrator.thread.get'), true);
    assert.equal(supervisorLease.body.lease.allowedTools.includes('orchestrator.enroll'), false);
    assert.equal(supervisorLease.body.lease.allowedTools.includes('lane.create'), false);
    for (const deniedTool of [
      'session.plan.update',
      'session.create',
      'capacity.set_policy',
      'session.worktree_policy.update',
      'settings.update',
      'task.add',
      'task.bulk_add',
      'task.update',
      'task.delete',
    ]) {
      assert.equal(supervisorLease.body.lease.allowedTools.includes(deniedTool), false);
    }

    const seedTask = await requestJson(`/api/sessions/${session.body.id}/tasks`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Seed task' },
    });
    assert.equal(seedTask.status, 201);

    for (const request of [
      {
        path: `/api/projects/${project.body.id}/sessions`,
        method: 'POST',
        body: { name: 'Denied child session', approved: true },
      },
      {
        path: `/api/sessions/${session.body.id}/plan`,
        method: 'POST',
        body: { goal: 'Denied plan update' },
      },
      {
        path: `/api/sessions/${session.body.id}/tasks`,
        method: 'POST',
        body: { title: 'Denied task' },
      },
      {
        path: `/api/sessions/${session.body.id}/tasks/bulk`,
        method: 'POST',
        body: { tasks: [{ title: 'Denied bulk task' }] },
      },
      {
        path: `/api/sessions/${session.body.id}/worktree-policy`,
        method: 'POST',
        body: { worktreeMode: 'shared', approved: true },
      },
      {
        path: `/api/sessions/${session.body.id}/capacity/policy`,
        method: 'POST',
        body: { approvedCapacity: 3, approved: true },
      },
      {
        path: `/api/settings/session/${session.body.id}`,
        method: 'PATCH',
        body: { settingsOverrides: { flow: { requireAuditPass: true } }, approved: true },
      },
      {
        path: `/api/tasks/${seedTask.body.id}`,
        method: 'PATCH',
        body: { priority: 7 },
      },
      {
        path: `/api/tasks/${seedTask.body.id}`,
        method: 'DELETE',
        body: {},
      },
    ]) {
      const denied = await requestJson(request.path, {
        method: request.method,
        headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
        body: request.body,
      });
      assert.equal(denied.status, 403, `${request.method} ${request.path}`);
      assert.match(denied.body.error, /Tool lease does not grant this tool/);
    }

    const executorLane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': orchestratorLease.body.leaseToken },
      body: { title: 'Visible executor', executorType: 'mock', approved: true },
    });
    assert.equal(executorLane.status, 201);

    const supervisorLane = await requestJson(`/api/lanes/${executorLane.body.id}`, {
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
    });
    assert.equal(supervisorLane.status, 200);
    assert.equal(supervisorLane.body.id, executorLane.body.id);
    assert.equal(supervisorLane.body.agentEvents.some((event) => event.type === 'agent.queued'), true);

    const terminalDir = path.join(process.cwd(), 'artifacts', session.body.id, executorLane.body.id);
    await fs.mkdir(terminalDir, { recursive: true });
    await fs.writeFile(path.join(terminalDir, 'terminal.log'), 'supervisor live terminal output\n');
    const supervisorTerminalTail = await requestJson(`/api/lanes/${executorLane.body.id}/terminal-tail?maxBytes=4096`, {
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
    });
    assert.equal(supervisorTerminalTail.status, 200);
    assert.equal(supervisorTerminalTail.body.text, 'supervisor live terminal output\n');
    assert.equal(supervisorTerminalTail.body.nextOffset, 'supervisor live terminal output\n'.length);

    const deniedEnroll = await requestJson(`/api/sessions/${session.body.id}/orchestrator/enroll`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
      body: { takeover: true },
    });
    assert.equal(deniedEnroll.status, 403);
    assert.match(deniedEnroll.body.error, /Tool lease does not grant this tool/);

    const deniedLaneCreate = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
      body: { title: 'Should not spawn', executorType: 'mock', approved: true },
    });
    assert.equal(deniedLaneCreate.status, 403);
    assert.match(deniedLaneCreate.body.error, /Tool lease does not grant this tool/);

    const lanesAfterDenied = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      headers: { 'x-orca-token': token },
    });
    assert.equal(lanesAfterDenied.status, 200);
    assert.equal(lanesAfterDenied.body.length, 1);

    const leaseOverview = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
    });
    assert.equal(leaseOverview.status, 200);
    assert.equal(leaseOverview.body.projects[0].sessions.length, 2);
    assert.equal(leaseOverview.body.activeSupervisors.some((lease) => lease.actor === 'attached-supervisor'), true);
    const overviewLane = leaseOverview.body.projects[0].sessions[0].lanes.find((item) => item.id === executorLane.body.id);
    assert.ok(overviewLane);
    assert.equal(overviewLane.recentAgentEvents.some((event) => event.type === 'agent.queued'), true);

    const leaseAudit = await requestJson(`/api/sessions/${session.body.id}/supervisor/audit`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
      body: {
        actor: 'body-spoofed-supervisor',
        verdict: 'request_fix',
        summary: 'Needs one more check.',
        findings: ['Route-level lease audit.'],
      },
    });
    assert.equal(leaseAudit.status, 200);
    assert.equal(leaseAudit.body.supervisorReview.status, 'fix_requested');
    assert.equal(leaseAudit.body.supervisorReview.actor, 'attached-supervisor');

    const overviewAfterAudit = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
    });
    assert.equal(overviewAfterAudit.status, 200);
    const auditedSession = overviewAfterAudit.body.projects[0].sessions
      .find((item) => item.id === session.body.id);
    assert.equal(auditedSession.supervisorReview.status, 'fix_requested');
    assert.equal(auditedSession.supervisorReview.actor, 'attached-supervisor');

    const wrongRoleAudit = await requestJson(`/api/sessions/${session.body.id}/supervisor/audit`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': orchestratorLease.body.leaseToken },
      body: { verdict: 'accept' },
    });
    assert.equal(wrongRoleAudit.status, 403);
    assert.match(wrongRoleAudit.body.error, /Tool lease does not grant this tool/);

    const deniedBootstrap = await requestJson('/api/mcp/supervisor-bootstrap', {
      method: 'POST',
      body: { actor: 'desktop-app' },
    });
    assert.equal(deniedBootstrap.status, 401);

    const bootstrap = await requestJson('/api/mcp/supervisor-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'desktop-app', ttlMs: 10 * 60 * 1000 },
    });
    assert.equal(bootstrap.status, 201);
    assert.equal(bootstrap.body.lease.role, 'supervisor');
    assert.equal(bootstrap.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env.ORCA_ROLE, 'supervisor');
    assert.equal(JSON.stringify(bootstrap.body).includes(token), false);

    const bootstrapOverview = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-tool-lease': bootstrap.body.leaseToken },
    });
    assert.equal(bootstrapOverview.status, 200);
    assert.equal(bootstrapOverview.body.activeSupervisors.some((lease) => lease.actor === 'desktop-app'), true);
    assert.equal(bootstrapOverview.body.projects[0].sessions.length, 2);
    assert.equal(bootstrapOverview.body.projects[0].sessions[0].lanes.length, 1);
  });
});
