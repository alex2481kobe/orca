// POST /api/projects/{projectId}/name over the real request pipeline.
//
// The registry tests (test/project-rename.test.js) prove the RULE. This proves
// the WIRING, which is where a rule of this shape goes wrong: the route has to
// tell an agent apart from an operator, and it does that by reading the lease the
// auth gate validated (req._toolLease) rather than by trusting anything in the
// body. If that translation is wrong, either every agent is treated as an
// operator (the rule evaporates) or every operator is treated as a stranger (the
// dashboard button 403s).
//
// In-process routeRequest harness (no listening daemon), state in a disposable
// temp cwd. Harness helpers copied by convention from emergency-stop-authz-api.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';

const SERVER_ENTRYPOINT = path.join(process.cwd(), 'src', 'server.js');

function parseJsonBody(rawText) {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return { raw: rawText };
  }
}

function createResponseState() {
  const chunks = [];
  const res = { statusCode: 200, headers: {} };
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = String(value); };
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
  };
  return { res, bodyText: () => Buffer.concat(chunks).toString('utf8') };
}

async function isolateEnvironment(token) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-rename-api-')));
  process.chdir(tempDir);
  approveFixtureRoot(tempDir);
  process.env.ORCA_API_TOKEN = token;
  process.env.PORT = '0';
  const restore = async () => {
    Object.keys(process.env).forEach((key) => { if (!(key in previousEnv)) delete process.env[key]; });
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  };
  return { restore, tempDir };
}

let harnessCounter = 0;

async function startServer(token) {
  const { restore, tempDir } = await isolateEnvironment(token);
  const moduleUrl = `${pathToFileURL(SERVER_ENTRYPOINT).href}?project-rename-api=${Date.now()}-${++harnessCounter}`;
  const { routeRequest, stopServer } = await import(moduleUrl);

  const requestJson = async (requestPath, options = {}) => {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const { res, bodyText } = createResponseState();
    const req = new PassThrough();
    req.method = options.method || 'GET';
    req.url = requestPath;
    req.headers = headers;
    req.socket = { remoteAddress: '127.0.0.1' };
    const handler = routeRequest(req, res);
    if (body === undefined) req.end(); else req.end(body);
    await handler;
    return { status: res.statusCode, body: parseJsonBody(bodyText()) };
  };

  return {
    requestJson,
    cwd: () => tempDir,
    stop: async () => {
      if (typeof stopServer === 'function') await stopServer();
      await restore();
    },
  };
}

// The credential an agent actually holds. Minting an orchestrator lease is
// admin-only, which is how a real client gets one during setup.
async function mintOrchestratorLease(server, token, actor) {
  const minted = await server.requestJson('/api/agent-tools/leases', {
    method: 'POST',
    headers: { 'x-orca-token': token },
    body: { role: 'orchestrator', actor },
  });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  return minted.body.leaseToken;
}

test('an agent renames the project it registered on; a stranger agent is refused', async () => {
  const token = 'project-rename-api-token';
  const server = await startServer(token);
  try {
    const leaseToken = await mintOrchestratorLease(server, token, 'claude-code');
    const registered = await server.requestJson('/api/orchestrators', {
      method: 'POST',
      headers: { 'x-orca-tool-lease': leaseToken },
      body: { cwd: server.cwd(), title: 'Engine lane' },
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    const projectId = registered.body.projectId;
    assert.ok(projectId, 'register hands the agent the projectId the rename needs');

    const renamed = await server.requestJson(`/api/projects/${projectId}/name`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': leaseToken },
      body: { name: 'Truss Engine' },
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.name, 'Truss Engine');
    assert.equal(renamed.body.id, projectId, 'the response is the same project, not a new one');

    // The dashboard's only feed. This is the whole point of the feature.
    const overview = await server.requestJson('/api/overview', { headers: { 'x-orca-token': token } });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.projects.find((item) => item.id === projectId).name, 'Truss Engine');

    // A second, valid orchestrator lease that never registered here. Its scope is
    // empty, so the lease gate lets it through to this projectId — registration is
    // what refuses it.
    const strangerToken = await mintOrchestratorLease(server, token, 'someone-else');
    const refused = await server.requestJson(`/api/projects/${projectId}/name`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': strangerToken },
      body: { name: 'Not yours' },
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.body.error, /orchestrator registered on this project/i);

    const after = await server.requestJson('/api/overview', { headers: { 'x-orca-token': token } });
    assert.equal(after.body.projects.find((item) => item.id === projectId).name, 'Truss Engine', 'the refusal changed nothing');
  } finally {
    await server.stop();
  }
});

test('an operator on the workstation renames any project, and an unauthenticated caller renames none', async () => {
  const token = 'project-rename-api-operator-token';
  const server = await startServer(token);
  try {
    const registered = await server.requestJson('/api/orchestrators', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { cwd: server.cwd(), actor: 'dashboard', title: 'Engine lane' },
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    const projectId = registered.body.projectId;

    const unauthenticated = await server.requestJson(`/api/projects/${projectId}/name`, {
      method: 'POST',
      body: { name: 'Anyone' },
    });
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated.body));

    const renamed = await server.requestJson(`/api/projects/${projectId}/name`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Truss Engine' },
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.name, 'Truss Engine');

    const blank = await server.requestJson(`/api/projects/${projectId}/name`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: '   ' },
    });
    assert.equal(blank.status, 422, JSON.stringify(blank.body));

    const missing = await server.requestJson('/api/projects/prj_nope/name', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Ghost' },
    });
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});
