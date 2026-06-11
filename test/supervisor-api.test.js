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
    assert.equal(scopedOut.status, 401);

    const supervisorLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', role: 'supervisor', ttlMs: 10 * 60 * 1000 },
    });
    assert.equal(supervisorLease.status, 201);
    assert.equal(supervisorLease.body.lease.role, 'supervisor');
    assert.ok(supervisorLease.body.leaseToken);

    const leaseOverview = await requestJson('/api/supervisor/overview', {
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
    });
    assert.equal(leaseOverview.status, 200);
    assert.equal(leaseOverview.body.projects[0].sessions.length, 2);

    const leaseAudit = await requestJson(`/api/sessions/${session.body.id}/supervisor/audit`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
      body: { verdict: 'request_fix', summary: 'Needs one more check.', findings: ['Route-level lease audit.'] },
    });
    assert.equal(leaseAudit.status, 200);
    assert.equal(leaseAudit.body.supervisorReview.status, 'fix_requested');

    const wrongRoleAudit = await requestJson(`/api/sessions/${session.body.id}/supervisor/audit`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': orchestratorLease.body.leaseToken },
      body: { verdict: 'accept' },
    });
    assert.equal(wrongRoleAudit.status, 401);

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
  });
});
