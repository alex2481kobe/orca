import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = process.cwd();
const SERVER_ENTRYPOINT = path.join(PROJECT_ROOT, 'src', 'server.js');
let harnessCounter = 0;
let entityCounter = 0;

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

async function startServer({ token }) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-critique-api-'));
  process.chdir(tempDir);
  process.env.ORCA_API_TOKEN = token;
  process.env.PORT = '0';
  const moduleUrl = `${pathToFileURL(SERVER_ENTRYPOINT).href}?critique-api-test=${Date.now()}-${++harnessCounter}`;
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
    stop: async () => {
      if (typeof stopServer === 'function') await stopServer();
      Object.keys(process.env).forEach((key) => {
        if (!(key in previousEnv)) delete process.env[key];
      });
      Object.entries(previousEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      process.chdir(previousCwd);
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    },
  };
}

async function createProjectSessionLane(server, token, laneBody = {}) {
  const suffix = ++entityCounter;
  const project = await server.requestJson('/api/projects', {
    method: 'POST',
    headers: { 'x-orca-token': token },
    body: { name: `Critique API Project ${suffix}`, approved: true },
  });
  assert.equal(project.status, 201);
  const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
    method: 'POST',
    headers: { 'x-orca-token': token },
    body: { name: `Critique API Session ${suffix}`, approved: true },
  });
  assert.equal(session.status, 201);
  const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
    method: 'POST',
    headers: { 'x-orca-token': token },
    body: {
      title: `Critique API Lane ${suffix}`,
      executorType: 'mock',
      owner: 'dashboard',
      approved: true,
      ...laneBody,
    },
  });
  assert.equal(lane.status, 201);
  return { project: project.body, session: session.body, lane: lane.body };
}

test('critique and audit outcome routes are wired and token-gated', async () => {
  const token = 'critique-route-token';
  const server = await startServer({ token });
  try {
    const { lane } = await createProjectSessionLane(server, token, {
      critiqueMode: 'required',
    });

    const deniedBundle = await server.requestJson(`/api/lanes/${lane.id}/critique/bundle`, {
      method: 'POST',
      body: { actor: 'dashboard' },
    });
    assert.equal(deniedBundle.status, 401);

    const bundle = await server.requestJson(`/api/lanes/${lane.id}/critique/bundle`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(bundle.status, 201);
    assert.equal(typeof bundle.body?.critiqueNonce, 'string');

    const findings = await server.requestJson(`/api/lanes/${lane.id}/critique/findings`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        critiqueNonce: bundle.body.critiqueNonce,
        checksRun: ['route smoke'],
        ready: true,
      },
    });
    assert.equal(findings.status, 200);
    assert.equal(findings.body?.lane?.critiqueState, 'satisfied');

    const accepted = await server.requestJson(`/api/lanes/${lane.id}/audit/accept`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        verdict: 'accepted',
        findings: ['route accepted'],
      },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body?.lane?.state, 'accepted');
  } finally {
    await server.stop();
  }
});

test('audit findings route dispatches fix and block verdicts', async () => {
  const token = 'critique-route-token-2';
  const server = await startServer({ token });
  try {
    const first = await createProjectSessionLane(server, token);
    const fix = await server.requestJson(`/api/lanes/${first.lane.id}/audit/findings`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        verdict: 'fix_requested',
        findings: ['needs fix'],
        nextTask: 'Run a fix pass.',
      },
    });
    assert.equal(fix.status, 200);
    assert.equal(fix.body?.lane?.state, 'fix_requested');

    const retry = await server.requestJson(`/api/lanes/${first.lane.id}/retry`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body?.state, 'queued');

    const second = await createProjectSessionLane(server, token);
    const missingReason = await server.requestJson(`/api/lanes/${second.lane.id}/audit/block`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(missingReason.status, 422);

    const blocked = await server.requestJson(`/api/lanes/${second.lane.id}/audit/findings`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        verdict: 'blocked',
        reason: 'External dependency unavailable.',
      },
    });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body?.lane?.state, 'blocked');
  } finally {
    await server.stop();
  }
});

test('visual critique route refuses ready findings without fresh screenshot evidence', async () => {
  const token = 'critique-route-token-3';
  const server = await startServer({ token });
  try {
    const { lane } = await createProjectSessionLane(server, token, {
      targetUrl: 'http://127.0.0.1:4173',
    });
    const bundle = await server.requestJson(`/api/lanes/${lane.id}/critique/bundle`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(bundle.status, 201);
    const findings = await server.requestJson(`/api/lanes/${lane.id}/critique/findings`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        critiqueNonce: bundle.body.critiqueNonce,
        visualEvidenceReviewed: true,
        ready: true,
      },
    });
    assert.equal(findings.status, 409);
    assert.equal(String(findings.body?.error || '').includes('fresh screenshot evidence'), true);
  } finally {
    await server.stop();
  }
});
