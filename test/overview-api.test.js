// v2 HTTP-level coverage for the read-only dashboard surface: the /api/overview
// projection (auth + shape + orchestrator nesting) and the break-glass
// /api/emergency-stop endpoint contract. Reuses the same in-process routeRequest
// harness style as server.test.js / effective-settings-api.test.js (each *-api
// test carries its own copy of the harness helpers by convention).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

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
  const res = {
    statusCode: 200,
    headers: {},
  };

  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = String(value);
  };

  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
  };

  return {
    res,
    bodyText: () => Buffer.concat(chunks).toString('utf8'),
  };
}

async function isolateEnvironment(token, env = {}) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-overview-api-'));

  process.chdir(tempDir);

  const restore = async () => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in previousEnv)) delete process.env[key];
    });
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  };

  if (typeof token === 'string') {
    process.env.ORCA_API_TOKEN = token;
  } else {
    delete process.env.ORCA_API_TOKEN;
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return { restore, tempDir };
}

let harnessCounter = 0;

async function startServer({ token, env = {} }) {
  const { restore } = await isolateEnvironment(token, { ...env, PORT: '0' });
  const moduleUrl = `${pathToFileURL(SERVER_ENTRYPOINT).href}?overview-api=${Date.now()}-${++harnessCounter}`;
  const { routeRequest, stopServer } = await import(moduleUrl);

  const requestJson = async (requestPath, options = {}) => {
    const headers = {
      'content-type': 'application/json',
      ...(options.headers || {}),
    };
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const { res, bodyText } = createResponseState();
    const req = new PassThrough();
    req.method = options.method || 'GET';
    req.url = requestPath;
    req.headers = headers;
    // Real connections always carry a remote address; default to loopback so the
    // token-gated operator auth path is exercisable as it is in server.test.js.
    req.socket = { remoteAddress: options.remoteAddress || '127.0.0.1' };

    const handler = routeRequest(req, res);
    if (body === undefined) {
      req.end();
    } else {
      req.end(body);
    }
    await handler;

    return {
      status: res.statusCode,
      body: parseJsonBody(bodyText()),
      response: { statusCode: res.statusCode, headers: res.headers },
    };
  };

  return {
    requestJson,
    // process.cwd() is the isolated temp dir until stop() restores it. That temp
    // dir is an approved repo root by default (getApprovedRepoRoots includes cwd),
    // so it is a legal orchestrator working directory.
    cwd: () => process.cwd(),
    stop: async () => {
      if (typeof stopServer === 'function') await stopServer();
      await restore();
    },
  };
}

test('GET /api/overview is operator-gated and returns the projects projection with a nested orchestrator', async () => {
  const token = 'overview-route-token';
  const server = await startServer({ token });

  try {
    // Unauthenticated callers get nothing (workspace data behind operator auth).
    const denied = await server.requestJson('/api/overview', { method: 'GET' });
    assert.equal(denied.status, 401);
    assert.equal(typeof denied.body?.error, 'string');
    assert.ok(denied.body.error.length > 0, 'a 401 must carry an error message');

    // Authenticated request: 200 with the { revision, generatedAt, projects } shape.
    const empty = await server.requestJson('/api/overview', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(empty.status, 200);
    assert.equal(typeof empty.body.revision, 'number');
    assert.equal(typeof empty.body.generatedAt, 'string');
    assert.equal(Array.isArray(empty.body.projects), true);
    assert.equal(empty.body.projects.length, 0, 'no orchestrators registered yet -> no projects');

    // Register an orchestrator for the server's (approved) working directory.
    const cwd = server.cwd();
    const registered = await server.requestJson('/api/orchestrators', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { cwd, actor: 'claude', title: 'Overview coverage work' },
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    assert.equal(registered.body.id.startsWith('orc_'), true);
    // The raw orchestrator record does carry a leaseId — the projection must not.
    assert.equal(registered.body.leaseId, 'dashboard');

    const overview = await server.requestJson('/api/overview', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.projects.length, 1, 'the registered orchestrator surfaces its project');

    const project = overview.body.projects[0];
    assert.equal(project.id.startsWith('prj_'), true);
    assert.equal(project.name, path.basename(cwd));
    assert.equal(Array.isArray(project.orchestrators), true);
    assert.equal(project.orchestrators.length, 1);

    const orchestrator = project.orchestrators[0];
    assert.equal(orchestrator.id, registered.body.id);
    assert.equal(orchestrator.actor, 'claude');
    assert.equal(orchestrator.title, 'Overview coverage work');
    assert.equal(Array.isArray(orchestrator.executors), true);

    // The projection must not leak the lease or any secret onto the wire.
    assert.equal(Object.prototype.hasOwnProperty.call(orchestrator, 'leaseId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(orchestrator, 'secret'), false);
    assert.equal(JSON.stringify(overview.body).includes('leaseId'), false, 'no leaseId anywhere in the overview payload');
  } finally {
    await server.stop();
  }
});

test('POST /api/emergency-stop is the operator break-glass control with a clean contract', async () => {
  const token = 'emergency-stop-route-token';
  const server = await startServer({ token });

  try {
    // Unauthenticated break-glass is refused.
    const denied = await server.requestJson('/api/emergency-stop', {
      method: 'POST',
      body: { all: true },
    });
    assert.equal(denied.status, 401);
    assert.equal(typeof denied.body?.error, 'string');
    assert.ok(denied.body.error.length > 0, 'a 401 must carry an error message');

    // Neither {laneId} nor {all} -> a clean 400 describing the contract.
    const missing = await server.requestJson('/api/emergency-stop', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {},
    });
    assert.equal(missing.status, 400);
    assert.equal(String(missing.body?.error || '').includes('Provide {laneId} or {all:true}.'), true);

    // A non-existent lane surfaces the registry's clean 404 (never a 500).
    const missingLane = await server.requestJson('/api/emergency-stop', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { laneId: 'lane-does-not-exist' },
    });
    assert.equal(missingLane.status, 404);
    assert.notEqual(missingLane.status, 500);
    assert.equal(String(missingLane.body?.error || '').includes('Lane not found'), true);

    // The stop-all form returns 200 with the {stopped:'all', count} envelope.
    const stopAll = await server.requestJson('/api/emergency-stop', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { all: true },
    });
    assert.equal(stopAll.status, 200, JSON.stringify(stopAll.body));
    assert.equal(stopAll.body.stopped, 'all');
    assert.equal(Object.prototype.hasOwnProperty.call(stopAll.body, 'count'), true);
  } finally {
    await server.stop();
  }
});
