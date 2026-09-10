// Route-authorization regression for the break-glass emergency-stop endpoints
// (hardening audit 2026-09-10, deferred P1). AGENTS.md's authority split: a
// paired remote device is an OPERATOR, not an admin. Operators may emergency-stop
// one executor or the agents under an orchestrator; fleet-wide stops are
// ADMIN-only (API token or loopback bootstrap). POST /api/emergency-stop {all:true}
// used to accept operator auth while POST /api/orchestrators/{id}/emergency-stop
// already required admin for the same fleet-wide effect.
//
// In-process routeRequest harness only (no listening daemon): state lives in a
// disposable temp cwd. Each *-api test carries its own copy of the harness
// helpers by convention (copied from overview-api.test.js).
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-emergency-stop-authz-'));

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
  const moduleUrl = `${pathToFileURL(SERVER_ENTRYPOINT).href}?emergency-stop-authz=${Date.now()}-${++harnessCounter}`;
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

// Mock lanes must stay live for the whole test, never auto-completing mid-assert.
const LONG_MOCK_RUN = { ORCA_AUTO_COMPLETE_MS: '600000' };

// Mint a REAL paired-device credential the way a phone gets one: an admin mints a
// one-time code, the device redeems it for a session cookie. Then prove the cookie
// is exactly what the tests claim: operator auth, and not admin auth.
async function pairOperatorDevice(server, token) {
  const pairing = await server.requestJson('/api/auth/pairing-codes', {
    method: 'POST',
    headers: { 'x-orca-token': token },
    body: { actor: 'dashboard', label: 'emergency-stop authz phone' },
  });
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  const paired = await server.requestJson('/api/auth/pair', {
    method: 'POST',
    body: { actor: 'dashboard', code: pairing.body.pairing.code },
  });
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  const setCookie = paired.response.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string', 'pairing must set a session cookie');
  const cookie = setCookie.split(';')[0];

  const operatorProbe = await server.requestJson('/api/overview', { headers: { cookie } });
  assert.equal(operatorProbe.status, 200, 'the paired cookie must carry operator auth');
  const adminProbe = await server.requestJson('/api/auth/pairing-codes', {
    method: 'POST',
    headers: { cookie },
    body: { actor: 'dashboard', label: 'rogue' },
  });
  assert.equal(adminProbe.status, 403, 'the paired cookie must NOT carry admin auth');
  return cookie;
}

async function registerOrchestrator(server, token, title) {
  const registered = await server.requestJson('/api/orchestrators', {
    method: 'POST',
    headers: { 'x-orca-token': token },
    body: { cwd: server.cwd(), actor: 'dashboard', title },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  return registered.body.id;
}

async function spawnMockLane(server, token, orchestratorId, title) {
  const lane = await server.requestJson(`/api/orchestrators/${orchestratorId}/executors`, {
    method: 'POST',
    headers: { 'x-orca-token': token },
    body: { title, executorType: 'mock', owner: 'dashboard', approved: true },
  });
  assert.equal(lane.status, 201, JSON.stringify(lane.body));
  assert.equal(typeof lane.body.id, 'string');
  return lane.body.id;
}

async function laneState(server, token, laneId) {
  const lane = await server.requestJson(`/api/lanes/${laneId}`, { headers: { 'x-orca-token': token } });
  assert.equal(lane.status, 200, JSON.stringify(lane.body));
  return lane.body.state;
}

test('a paired operator is REFUSED the fleet-wide stop on POST /api/emergency-stop {all:true}', async () => {
  const token = 'emergency-stop-authz-refuse-token';
  const server = await startServer({ token, env: LONG_MOCK_RUN });

  try {
    const cookie = await pairOperatorDevice(server, token);
    const orchestratorId = await registerOrchestrator(server, token, 'Fleet stop refusal');
    const laneId = await spawnMockLane(server, token, orchestratorId, 'Bystander lane');

    const refused = await server.requestJson('/api/emergency-stop', {
      method: 'POST',
      headers: { cookie },
      body: { all: true },
    });
    assert.equal(refused.status, 403, `paired operator fleet-stop must be 403 (got ${refused.status}: ${JSON.stringify(refused.body)})`);
    assert.match(String(refused.body?.error || ''), /admin/i, 'the refusal must say admin auth is required');

    // A laneId riding along must not smuggle the fleet-wide form through.
    const smuggled = await server.requestJson('/api/emergency-stop', {
      method: 'POST',
      headers: { cookie },
      body: { all: true, laneId },
    });
    assert.equal(smuggled.status, 403, `{all:true, laneId} from a paired operator must still be 403 (got ${smuggled.status})`);

    // The refusal had no side effect: the bystander lane was not stopped.
    assert.notEqual(await laneState(server, token, laneId), 'stopped', 'a refused fleet-stop must not stop anything');
  } finally {
    await server.stop();
  }
});

test('a paired operator KEEPS its legitimate break-glass: one executor, and the agents under an orchestrator', async () => {
  const token = 'emergency-stop-authz-operator-token';
  const server = await startServer({ token, env: LONG_MOCK_RUN });

  try {
    const cookie = await pairOperatorDevice(server, token);
    const orchestratorId = await registerOrchestrator(server, token, 'Operator break-glass');
    const laneA = await spawnMockLane(server, token, orchestratorId, 'Runaway lane A');
    const laneB = await spawnMockLane(server, token, orchestratorId, 'Runaway lane B');

    // Stop ONE executor via the singleton route (the dashboard's per-executor stop).
    const single = await server.requestJson('/api/emergency-stop', {
      method: 'POST',
      headers: { cookie },
      body: { laneId: laneA },
    });
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.stopped, laneA);
    assert.equal(await laneState(server, token, laneA), 'stopped');

    // Stop the agents under ONE orchestrator (the dashboard's per-orchestrator stop,
    // sent with the same body public/ui/overview.js sends).
    const scoped = await server.requestJson(`/api/orchestrators/${orchestratorId}/emergency-stop`, {
      method: 'POST',
      headers: { cookie },
      body: { actor: 'dashboard', approved: true },
    });
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.equal(await laneState(server, token, laneB), 'stopped');

    // Parity: the orchestrator-scoped route refuses the fleet-wide form too.
    const scopedAll = await server.requestJson(`/api/orchestrators/${orchestratorId}/emergency-stop`, {
      method: 'POST',
      headers: { cookie },
      body: { all: true },
    });
    assert.equal(scopedAll.status, 403, JSON.stringify(scopedAll.body));
  } finally {
    await server.stop();
  }
});

test('admin (API token) KEEPS the fleet-wide stop on POST /api/emergency-stop {all:true}', async () => {
  const token = 'emergency-stop-authz-admin-token';
  const server = await startServer({ token, env: LONG_MOCK_RUN });

  try {
    const orchestratorId = await registerOrchestrator(server, token, 'Admin fleet stop');
    await spawnMockLane(server, token, orchestratorId, 'Fleet lane');

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

test('admin (loopback bootstrap, no token configured) KEEPS the fleet-wide stop; a proxied caller does not', async () => {
  const server = await startServer({ token: null });

  try {
    // Direct loopback connection, no forwarding headers: the host itself, i.e. admin.
    const local = await server.requestJson('/api/emergency-stop', {
      method: 'POST',
      body: { all: true },
    });
    assert.equal(local.status, 200, JSON.stringify(local.body));
    assert.equal(local.body.stopped, 'all');

    // The same socket arriving through a proxy (e.g. Tailscale Serve) is not the host.
    const proxied = await server.requestJson('/api/emergency-stop', {
      method: 'POST',
      headers: { 'x-forwarded-for': '100.64.0.7' },
      body: { all: true },
    });
    assert.equal(proxied.status, 401, JSON.stringify(proxied.body));
  } finally {
    await server.stop();
  }
});
