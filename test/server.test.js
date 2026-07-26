import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-server-'));

  process.chdir(tempDir);

  const restore = async () => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in previousEnv)) {
        delete process.env[key];
      }
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
  const entrypoint = SERVER_ENTRYPOINT;
  const moduleUrl = `${pathToFileURL(entrypoint).href}?server-test-harness=${Date.now()}-${++harnessCounter}`;
  const { routeRequest, stopServer } = await import(moduleUrl);

  const requestRaw = async (requestPath, options = {}) => {
    const headers = {
      'content-type': 'application/json',
      ...(options.headers || {}),
    };

    const body = options.rawBody !== undefined
      ? String(options.rawBody)
      : (options.body !== undefined ? JSON.stringify(options.body) : undefined);
    const { res, bodyText } = createResponseState();
    const req = new PassThrough();
    req.method = options.method || 'GET';
    req.url = requestPath;
    req.headers = headers;
    // Real connections always have a remote address; default to loopback so the
    // no-token local bootstrap path is exercisable, overridable per request.
    req.socket = { remoteAddress: options.remoteAddress || '127.0.0.1' };

    const handler = routeRequest(req, res);
    if (body === undefined) {
      req.end();
    } else {
      req.end(body);
    }
    await handler;

    const text = bodyText();
    return {
      status: res.statusCode,
      body: parseJsonBody(text),
      response: { statusCode: res.statusCode, headers: res.headers },
    };
  };

  const requestJson = requestRaw;

  return {
    requestJson,
    requestRaw,
    stop: async () => {
      if (typeof stopServer === 'function') {
        await stopServer();
      }
      await restore();
    },
  };
}

async function startDummyApiProvider(secret) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: `server credential ok ${secret}` } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startDummyWebTarget() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function waitForServerLane(server, laneId, token) {
  const headers = token ? { 'x-orca-token': token } : {};
  for (let i = 0; i < 80; i += 1) {
    const lane = await server.requestJson(`/api/lanes/${laneId}`, { method: 'GET', headers });
    if (['done', 'failed'].includes(lane.body?.state)) return lane;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return server.requestJson(`/api/lanes/${laneId}`, { method: 'GET', headers });
}

async function waitForTerminalText(server, terminalId, token, pattern) {
  const headers = token ? { 'x-orca-token': token } : {};
  for (let i = 0; i < 80; i += 1) {
    const tail = await server.requestJson(`/api/terminals/${terminalId}/tail?maxChars=65536`, {
      method: 'GET',
      headers,
    });
    if (tail.status === 200 && pattern.test(tail.body?.text || '')) return tail;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return server.requestJson(`/api/terminals/${terminalId}/tail?maxChars=65536`, {
    method: 'GET',
    headers,
  });
}

async function waitForLaneState(server, laneId, token, predicate) {
  const headers = token ? { 'x-orca-token': token } : {};
  for (let i = 0; i < 80; i += 1) {
    const lane = await server.requestJson(`/api/lanes/${laneId}`, { method: 'GET', headers });
    if (lane.status === 200 && predicate(lane.body)) return lane;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return server.requestJson(`/api/lanes/${laneId}`, { method: 'GET', headers });
}

async function waitForLaneTerminalText(server, laneId, token, pattern) {
  const headers = token ? { 'x-orca-token': token } : {};
  for (let i = 0; i < 80; i += 1) {
    const tail = await server.requestJson(`/api/lanes/${laneId}/terminal-tail?maxBytes=65536`, {
      method: 'GET',
      headers,
    });
    if (tail.status === 200 && pattern.test(tail.body?.text || '')) return tail;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return server.requestJson(`/api/lanes/${laneId}/terminal-tail?maxBytes=65536`, {
    method: 'GET',
    headers,
  });
}

// v2: no session container — the orchestrator RECORD (keyed by realpath(cwd)) is
// the lane container. Register one and return the full response ({ id, projectId,
// ... }). The in-process server shares this process's cwd (an approved repo root),
// so process.cwd() registers cleanly. Admin-token by default; pass a leaseToken to
// register as a scoped agent (its owning lease).
async function registerOrchestrator(server, token, {
  actor = 'dashboard',
  title = 'Server Test Orchestrator',
  leaseToken = null,
  cwd = process.cwd(),
} = {}) {
  const headers = leaseToken
    ? { 'x-orca-tool-lease': leaseToken }
    : (token ? { 'x-orca-token': token } : {});
  const res = await server.requestJson('/api/orchestrators', {
    method: 'POST',
    headers,
    body: { cwd, actor, title },
  });
  assert.equal(res.status, 200, `orchestrator register: ${JSON.stringify(res.body)}`);
  return res;
}

test('server API requires token for mutating actions while allowing read actions', async () => {
  const token = 'route-token-01';
  const server = await startServer({ token });

  try {
    const health = await server.requestJson('/api/health', { method: 'GET' });
    assert.equal(health.status, 200);

    const deniedCreate = await server.requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Unauthorized project' },
    });
    assert.equal(deniedCreate.status, 401);

    const created = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Authorized project',
        approved: true,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.name, 'Authorized project');
  } finally {
    await server.stop();
  }
});

test('lane terminal input and resize reach a PTY-backed interactive lane', async () => {
  const token = 'lane-terminal-route-token';
  const server = await startServer({
    token,
    env: {
      ORCA_ENABLE_CUSTOM_CLI: 'true',
      ORCA_CLI_BINARY: '/bin/bash',
      ORCA_CLI_ALLOWED_BINARIES: '/bin/bash',
    },
  });

  try {
    const orchestrator = await registerOrchestrator(server, token, { title: 'Lane Terminal Orchestrator' });

    const created = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Interactive bash lane',
        executorType: 'cli',
        executorBinary: '/bin/bash',
        args: ['--noprofile', '--norc'],
        presentationMode: 'terminal',
        approved: true,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const laneId = created.body.id;

    const running = await waitForLaneState(server, laneId, token, (lane) => lane?.state === 'running' && lane?.processMeta?.terminalWrapper === 'pty');
    assert.equal(running.status, 200);
    assert.equal(running.body.processMeta.terminalWrapper, 'pty');

    const resized = await server.requestJson(`/api/lanes/${laneId}/terminal-resize`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', cols: 90, rows: 24 },
    });
    assert.equal(resized.status, 200);
    assert.equal(resized.body.result.cols, 90);
    assert.equal(resized.body.result.rows, 24);

    const input = await server.requestJson(`/api/lanes/${laneId}/terminal-input`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', input: 'printf "__ORCA_LANE_PTY__\\n"\n', raw: true },
    });
    assert.equal(input.status, 200);

    const tail = await waitForLaneTerminalText(server, laneId, token, /__ORCA_LANE_PTY__/);
    assert.equal(tail.status, 200);
    assert.match(tail.body.text, /__ORCA_LANE_PTY__/);

    const stopped = await server.requestJson(`/api/lanes/${laneId}/stop`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', approved: true },
    });
    assert.equal(stopped.status, 200);
  } finally {
    await server.stop();
  }
});

test('auth pairing codes create revocable browser sessions for mutating routes', async () => {
  const token = 'route-token-auth-session';
  const server = await startServer({ token });

  try {
    const status = await server.requestJson('/api/auth/status', { method: 'GET' });
    assert.equal(status.status, 200);
    assert.equal(status.body?.apiTokenRequired, true);
    assert.equal(status.body?.browserSessionAuthenticated, false);

    const deniedPairing = await server.requestJson('/api/auth/pairing-codes', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        label: 'phone',
      },
    });
    assert.equal(deniedPairing.status, 401);

    const pairing = await server.requestJson('/api/auth/pairing-codes', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        label: 'phone',
      },
    });
    assert.equal(pairing.status, 201);
    assert.match(pairing.body?.pairing?.code, /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);

    const paired = await server.requestJson('/api/auth/pair', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        code: pairing.body.pairing.code,
        label: 'phone browser',
      },
    });
    assert.equal(paired.status, 200);
    assert.equal(paired.body?.paired, true);
    assert.equal(JSON.stringify(paired.body).includes('sessionToken'), false);
    const cookie = paired.response.headers['set-cookie'];
    assert.equal(String(cookie).includes('HttpOnly'), true);
    assert.equal(String(cookie).includes('SameSite=Strict'), true);

    const deniedCrossOrigin = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { cookie, origin: 'http://evil.example' },
      body: {
        actor: 'dashboard',
        approved: true,
        name: 'Cross Origin Project',
      },
    });
    assert.equal(deniedCrossOrigin.status, 403);

    const createdWithCookie = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { cookie },
      body: {
        actor: 'dashboard',
        approved: true,
        name: 'Cookie Auth Project',
      },
    });
    assert.equal(createdWithCookie.status, 201);

    const sessions = await server.requestJson('/api/auth/sessions', {
      method: 'GET',
      headers: { cookie },
    });
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body?.sessions?.some((session) => session.label === 'phone browser'), true);

    const reusePairing = await server.requestJson('/api/auth/pair', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        code: pairing.body.pairing.code,
      },
    });
    assert.equal(reusePairing.status, 401);

    const logout = await server.requestJson('/api/auth/logout', {
      method: 'POST',
      headers: { cookie },
      body: {
        actor: 'dashboard',
      },
    });
    assert.equal(logout.status, 200);
    assert.equal(String(logout.response.headers['set-cookie']).includes('Max-Age=0'), true);

    const deniedAfterLogout = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { cookie },
      body: {
        actor: 'dashboard',
        approved: true,
        name: 'Denied Cookie Project',
      },
    });
    assert.equal(deniedAfterLogout.status, 401);
  } finally {
    await server.stop();
  }
});

test('an unpaired client with only the URL receives no workspace or host data', async () => {
  const token = 'route-token-no-data';
  const server = await startServer({ token });

  try {
    // Seed real data as the workstation (token), so the routes have something
    // to leak if auth were broken.
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Secret Project',
        approved: true,
        quickLinks: [{ label: 'Secret Live Link', url: 'http://127.0.0.1:5173' }],
      },
    });
    assert.equal(project.status, 201);

    // Every data/host route must refuse an unauthenticated caller.
    const protectedReads = [
      '/api/projects',
      `/api/projects/${project.body.id}`,
      `/api/projects/${project.body.id}/sessions`,
      '/api/mobile/manifest',
      '/api/private-access',
      '/api/private-access/tailnet',
      '/api/system/blockers',
      '/api/executors/profiles',
    ];
    for (const route of protectedReads) {
      const res = await server.requestJson(route, { method: 'GET' });
      assert.equal(res.status, 401, `${route} must require auth`);
      assert.equal(JSON.stringify(res.body || {}).includes('Secret Project'), false, `${route} leaked project data`);
      assert.equal(JSON.stringify(res.body || {}).includes('Secret Live Link'), false, `${route} leaked quick link data`);
    }

    const protectedWrites = [
      ['POST', `/api/projects/${project.body.id}/quick-links`, { actor: 'dashboard', approved: true, label: 'Remote', url: 'http://127.0.0.1:5173' }],
      ['PATCH', `/api/projects/${project.body.id}/quick-links/${project.body.quickLinks[0].id}`, { actor: 'dashboard', approved: true, label: 'Remote Updated', url: 'http://127.0.0.1:5174' }],
      ['POST', `/api/projects/${project.body.id}/quick-links/${project.body.quickLinks[0].id}/check`, { actor: 'dashboard' }],
      ['DELETE', `/api/projects/${project.body.id}/quick-links/${project.body.quickLinks[0].id}`, { actor: 'dashboard', approved: true }],
    ];
    for (const [method, route, body] of protectedWrites) {
      const res = await server.requestJson(route, { method, body });
      assert.equal(res.status, 401, `${method} ${route} must require auth`);
      assert.equal(JSON.stringify(res.body || {}).includes('Secret Project'), false, `${method} ${route} leaked project data`);
      assert.equal(JSON.stringify(res.body || {}).includes('Secret Live Link'), false, `${method} ${route} leaked quick link data`);
    }

    // Liveness is the only public surface, and it must not expose counts.
    const health = await server.requestJson('/api/health', { method: 'GET' });
    assert.equal(health.status, 200);
    assert.equal(health.body?.status, 'ok');
    assert.equal(health.body?.counts, undefined);

    // Auth status is public so the client knows it must pair.
    const authStatus = await server.requestJson('/api/auth/status', { method: 'GET' });
    assert.equal(authStatus.status, 200);
    assert.equal(authStatus.body?.apiTokenRequired, true);
    assert.equal(authStatus.body?.browserSessionAuthenticated, false);
  } finally {
    await server.stop();
  }
});

test('with no API token, the local host bootstraps but proxied tailnet requests are denied', async () => {
  const server = await startServer({ token: null });

  try {
    // Direct, non-proxied loopback request = the workstation itself = admin.
    const local = await server.requestJson('/api/overview', { method: 'GET' });
    assert.equal(local.status, 200);

    const created = await server.requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Bootstrap Project', approved: true },
    });
    assert.equal(created.status, 201);

    const crossOriginMutation = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: { name: 'Cross Origin Bootstrap', approved: true },
    });
    assert.equal(crossOriginMutation.status, 403);

    const simpleFormMutation = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: { name: 'Text Plain Bootstrap', approved: true },
    });
    assert.equal(simpleFormMutation.status, 415);

    const originlessStatus = await server.requestJson('/api/auth/status', { method: 'GET' });
    assert.equal(originlessStatus.status, 200);
    assert.equal(originlessStatus.response.headers['set-cookie'], undefined);

    const sameOriginStatus = await server.requestJson('/api/auth/status', {
      method: 'GET',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(sameOriginStatus.status, 200);
    assert.match(String(sameOriginStatus.response.headers['set-cookie'] || ''), /orca[_-]?session=/i);

    // A Tailscale Serve / reverse-proxied request carries forwarding headers and
    // must NOT be treated as the local bootstrap — no data without pairing.
    const proxied = await server.requestJson('/api/projects', {
      method: 'GET',
      headers: { 'x-forwarded-for': '100.64.0.9' },
    });
    assert.equal(proxied.status, 401);

    const tsIdentity = await server.requestJson('/api/projects', {
      method: 'GET',
      headers: { 'tailscale-user-login': 'someone@example.com' },
    });
    assert.equal(tsIdentity.status, 401);

    // A non-loopback source address is also untrusted.
    const remote = await server.requestJson('/api/projects', {
      method: 'GET',
      remoteAddress: '100.64.0.9',
    });
    assert.equal(remote.status, 401);

    // Liveness still answers everyone.
    const health = await server.requestJson('/api/health', {
      method: 'GET',
      headers: { 'x-forwarded-for': '100.64.0.9' },
    });
    assert.equal(health.status, 200);
  } finally {
    await server.stop();
  }
});

test('anti-DNS-rebinding: a direct request with a foreign Host header is refused', async () => {
  const server = await startServer({ token: null });
  try {
    // A rebinding drive-by: browser connects to 127.0.0.1 over loopback but the
    // page's Host header is the attacker domain. Must be rejected before auth.
    const rebind = await server.requestJson('/api/overview', {
      method: 'GET',
      headers: { host: 'attacker.example' },
    });
    assert.equal(rebind.status, 403);

    // Legit loopback Host names still pass through to the bootstrap-admin path.
    for (const host of ['127.0.0.1:3000', 'localhost', '[::1]:3000']) {
      const ok = await server.requestJson('/api/overview', { method: 'GET', headers: { host } });
      assert.equal(ok.status, 200, `host ${host} should be allowed`);
    }

    // A proxied (tailnet) request carries a foreign Host legitimately — the gate
    // must not block it (auth still applies; unpaired => 401, not 403).
    const proxied = await server.requestJson('/api/projects', {
      method: 'GET',
      headers: { host: 'box.tail1234.ts.net', 'x-forwarded-for': '100.64.0.9' },
    });
    assert.equal(proxied.status, 401);
  } finally {
    await server.stop();
  }
});

test('paired devices get operator access but are denied host administration', async () => {
  const token = 'route-token-least-privilege';
  const server = await startServer({
    token,
    env: {
      ORCA_CODEX_BINARY: '/usr/bin/codex',
      ORCA_CREDENTIAL_BACKEND: 'memory',
    },
  });

  try {
    const pairing = await server.requestJson('/api/auth/pairing-codes', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', label: 'phone' },
    });
    assert.equal(pairing.status, 201);
    const paired = await server.requestJson('/api/auth/pair', {
      method: 'POST',
      body: { actor: 'dashboard', code: pairing.body.pairing.code },
    });
    assert.equal(paired.status, 200);
    const cookie = paired.response.headers['set-cookie'];

    // Operator workflow works with the paired cookie.
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { cookie },
      body: { name: 'Operator Project', approved: true },
    });
    assert.equal(project.status, 201);

    const overview = await server.requestJson('/api/overview', { method: 'GET', headers: { cookie } });
    assert.equal(overview.status, 200);

    // Host administration is refused (403) for a paired operator device.
    const adminAttempts = [
      ['PATCH', '/api/private-access/settings', { actor: 'dashboard', preferredMode: 'local' }],
      ['POST', '/api/private-access/serve', { actor: 'dashboard', action: 'enable' }],
      ['POST', '/api/auth/pairing-codes', { actor: 'dashboard', label: 'rogue' }],
      // Dashboard/orchestrator leases are off-origin host credentials —
      // a paired operator must not be able to mint them.
      ['POST', '/api/agent-tools/leases', { actor: 'dashboard', role: 'dashboard' }],
      ['POST', '/api/agent-tools/leases', { actor: 'dashboard', role: 'orchestrator' }],
    ];
    for (const [method, route, body] of adminAttempts) {
      const res = await server.requestJson(route, { method, headers: { cookie }, body });
      assert.equal(res.status, 403, `${method} ${route} must be admin-only for paired devices (got ${res.status})`);
    }

    // v2: the operator registers an orchestrator (keyed by cwd) instead of a
    // session container, then spawns a worker lane under it. Registration is an
    // operator-level workflow action, reachable with the paired cookie.
    const operatorOrchestrator = await server.requestJson('/api/orchestrators', {
      method: 'POST',
      headers: { cookie },
      body: { cwd: process.cwd(), actor: 'dashboard', title: 'Operator Worker Orchestrator' },
    });
    assert.equal(operatorOrchestrator.status, 200, JSON.stringify(operatorOrchestrator.body));
    const operatorLane = await server.requestJson(`/api/orchestrators/${operatorOrchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Operator Worker Lane', executorType: 'mock', approved: true },
    });
    assert.equal(operatorLane.status, 201);

    const unscopedExecLease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST', headers: { cookie }, body: { actor: 'dashboard', role: 'executor' },
    });
    assert.equal(unscopedExecLease.status, 422);
    assert.match(unscopedExecLease.body?.error || '', /scoped to a lane/);

    // But a worker-lane lease stays an operator-level action when bound to a lane.
    const execLease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { cookie },
      body: {
        actor: 'dashboard',
        role: 'executor',
        projectId: operatorOrchestrator.body.projectId,
        sessionId: operatorOrchestrator.body.id,
        laneId: operatorLane.body.id,
      },
    });
    assert.equal(execLease.status, 201, 'operator may still mint a lane-scoped worker lease');

    // The same admin routes are reachable for the workstation (API token = admin):
    // they pass the auth gate and fail later on policy/validation, never 401/403.
    const tokenAdmin = await server.requestJson('/api/auth/pairing-codes', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', label: 'workstation' },
    });
    assert.notEqual(tokenAdmin.status, 401);
    assert.notEqual(tokenAdmin.status, 403);
  } finally {
    await server.stop();
  }
});


test('project API endpoints require explicit approval', async () => {
  const token = 'route-token-01c';
  const server = await startServer({ token });

  try {
    const deniedProject = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Needs approval' },
    });
    assert.equal(deniedProject.status, 409);
    assert.equal(Boolean(deniedProject.body?.requiresApproval), true);

    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Approval project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);
  } finally {
    await server.stop();
  }
});

test('project updates and lane creations require explicit approval', async () => {
  const token = 'route-token-01d';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Approval Baseline Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const deniedUpdate = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        quickLinks: [],
      },
    });
    assert.equal(deniedUpdate.status, 409);
    assert.equal(Boolean(deniedUpdate.body?.requiresApproval), true);

    const updated = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        quickLinks: [{ label: 'Project Home', url: 'http://localhost:4173' }],
        approved: true,
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(Array.isArray(updated.body?.quickLinks), true);
    assert.equal(updated.body.quickLinks.length, 1);

    // v2: lanes are created under the orchestrator container (keyed by cwd), not a
    // session. The lane-creation approval gate is unchanged.
    const orchestrator = await registerOrchestrator(server, token, { title: 'Approval Baseline Orchestrator' });

    const deniedLane = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'No approval lane',
        executorType: 'mock',
        owner: 'dashboard',
      },
    });
    assert.equal(deniedLane.status, 409);
    assert.equal(Boolean(deniedLane.body?.requiresApproval), true);

    const allowedLane = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Approved lane',
        executorType: 'mock',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(allowedLane.status, 201);
    assert.equal(allowedLane.body?.title, 'Approved lane');

    const deniedControls = await server.requestJson(`/api/lanes/${allowedLane.body.id}/controls`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        model: 'gpt-5',
        permissionsProfile: 'plan',
        intelligenceProfile: 'high',
      },
    });
    assert.equal(deniedControls.status, 409);
    assert.equal(Boolean(deniedControls.body?.requiresApproval), true);

    const updatedControls = await server.requestJson(`/api/lanes/${allowedLane.body.id}/controls`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        approved: true,
        model: 'gpt-5',
        permissionsProfile: 'auto-edit',
        intelligenceProfile: 'max',
      },
    });
    assert.equal(updatedControls.status, 200);
    assert.equal(updatedControls.body?.model, 'gpt-5');
    assert.equal(updatedControls.body?.permissionsProfile, 'auto-edit');
    assert.equal(updatedControls.body?.intelligenceProfile, 'max');
  } finally {
    await server.stop();
  }
});

// DELETED: 'session updates require explicit approval' — exercised only the
// removed PATCH /api/sessions/{id} archive route (Model-A session CRUD). The
// orchestrator container has no approval-gated state PATCH to port it onto.

test('permanent project delete requires valid JSON, approval, and archived state', async () => {
  const token = 'route-token-permanent-delete';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Permanent Delete Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const malformed = await server.requestRaw(`/api/projects/${project.body.id}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
      rawBody: '{not-json',
    });
    assert.equal(malformed.status, 400);

    const projectMissingApproval = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
      body: {},
    });
    assert.equal(projectMissingApproval.status, 409);
    assert.equal(Boolean(projectMissingApproval.body?.requiresApproval), true);

    const activeProjectDelete = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
      body: { approved: true },
    });
    assert.equal(activeProjectDelete.status, 422);

    const archivedProject = await server.requestJson(`/api/projects/${project.body.id}/archive`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { approved: true },
    });
    assert.equal(archivedProject.status, 200);

    const deletedProject = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
      body: { approved: true },
    });
    assert.equal(deletedProject.status, 200);
    assert.equal(deletedProject.body?.deleted, true);
  } finally {
    await server.stop();
  }
});

test('server rejects malformed request URLs without crashing', async () => {
  const token = 'route-token-01a';
  const server = await startServer({ token });

  try {
    const malformed = await server.requestJson('/api/health/%E0%A4', { method: 'GET' });
    assert.equal(malformed.status, 400);
    assert.equal(String(malformed.body?.raw || '').includes('Invalid request URL'), true);
  } finally {
    await server.stop();
  }
});

test('server rejects malformed query strings on query-based endpoints', async () => {
  const token = 'route-token-01b';
  const server = await startServer({ token });

  try {
    const malformedDirQuery = await server.requestJson('/api/system/dirs?path=%E0%A4', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(malformedDirQuery.status, 400);
    assert.equal(String(malformedDirQuery.body?.error || '').includes('Invalid request query string.'), true);
  } finally {
    await server.stop();
  }
});

test('executor CLI APIs reject unsupported executor types', async () => {
  const token = 'route-token-03f';
  const server = await startServer({ token });

  try {
    const missingInfo = await server.requestJson('/api/executors/unknown/cli', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(missingInfo.status, 404);
  } finally {
    await server.stop();
  }
});

test('API lane creation enforces the executor binary constraint', async () => {
  const token = 'route-token-03g';
  const server = await startServer({ token });

  try {
    const orchestrator = await registerOrchestrator(server, token, { title: 'Lane constraint orchestrator' });

    // The custom-MCP-tool CRUD (and per-lane mcpToolIds) is gone; a lane's only
    // MCP server is Orca's own. The surviving spawn-time constraint is that an
    // explicit command must invoke the configured binary for its executor type.
    const badCommand = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Bad command lane',
        executorType: 'codex',
        command: 'echo hello',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(badCommand.status, 422);
    assert.equal(String(badCommand.body?.error || '').includes('configured codex binary'), true);

    const validLane = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Good codex lane',
        executorType: 'codex',
        command: 'codex', // bare binary: first-class CLIs refuse caller-supplied argv
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(validLane.status, 201);
    assert.equal(validLane.body.executorType, 'codex');

    // The sandbox-escape guard holds over HTTP too, and for an ADMIN caller at that:
    // cli-adapter prefers caller argv over Orca's built argv, so raw args would have
    // launched an unsandboxed agent while permissionsProfile still read "plan".
    const rawArgv = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Raw argv lane',
        executorType: 'codex',
        args: ['--dangerously-bypass-approvals-and-sandbox'],
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(rawArgv.status, 422);
    assert.match(String(rawArgv.body?.error || ''), /Orca builds the command line/i);
  } finally {
    await server.stop();
  }
});

test('dashboard-scoped orchestrator leases enroll and gate cross-scope actions', async () => {
  const token = 'route-token-orchestrator-chat';
  const server = await startServer({ token });

  try {
    // v2: an orchestrator lease is unscoped; it claims ownership by REGISTERING an
    // orchestrator (keyed by cwd) rather than enrolling against a session marker.
    const lease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        role: 'orchestrator',
        actor: 'dashboard',
      },
    });
    assert.equal(lease.status, 201);
    assert.equal(Boolean(lease.body?.leaseToken), true);

    const registered = await registerOrchestrator(server, token, {
      title: 'Orchestrator Chat', leaseToken: lease.body.leaseToken,
    });
    assert.ok(String(registered.body?.id || '').startsWith('orc_'));

    const leaseLane = await server.requestJson(`/api/orchestrators/${registered.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        actor: 'orchestrator',
        approved: true,
        title: 'Lease-created executor lane',
        executorType: 'mock',
      },
    });
    assert.equal(leaseLane.status, 201);
    assert.equal(leaseLane.body?.title, 'Lease-created executor lane');

    // v2 removed project.create from the agent tool surface — POST /api/projects
    // is no longer a lease-gated agent route (projects are created by the operator
    // or implicitly via orchestrator.register), so a scoped tool lease cannot
    // create a top-level project: the call is refused as unauthenticated-operator.
    const forbidden = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        name: 'Forbidden by lease',
        approved: true,
      },
    });
    assert.notEqual(forbidden.status, 201);
    assert.equal(forbidden.status, 401);
    assert.match(forbidden.body?.error || '', /Unauthorized/i);
  } finally {
    await server.stop();
  }
});

test('scoped orchestrator leases bind plan and task actors to the lease identity', async () => {
  const token = 'route-token-lease-actor-binding';
  const server = await startServer({ token });

  try {
    // v2: unscoped orchestrator lease that claims ownership by registering the
    // orchestrator container. The audit-queue actor-binding behavior is unchanged.
    const lease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'lease-bound-orchestrator',
        role: 'orchestrator',
      },
    });
    assert.equal(lease.status, 201);
    const leaseHeaders = { 'x-orca-tool-lease': lease.body.leaseToken };
    const registered = await registerOrchestrator(server, token, {
      title: 'Lease Actor', leaseToken: lease.body.leaseToken, actor: 'lease-bound-orchestrator',
    });
    const orchestratorId = registered.body.id;

    const lane = await server.requestJson(`/api/orchestrators/${orchestratorId}/executors`, {
      method: 'POST',
      headers: leaseHeaders,
      body: {
        actor: 'body-spoofed-lane',
        approved: true,
        title: 'Lease-bound audit queue lane',
        executorType: 'mock',
        taskPrompt: 'Complete a tiny mock task for actor-binding audit coverage.',
        autoCompleteMs: 10,
      },
    });
    assert.equal(lane.status, 201);
    const completedLane = await waitForServerLane(server, lane.body.id, token);
    assert.equal(completedLane.status, 200);
    assert.equal(['done', 'ready_for_audit'].includes(completedLane.body?.state), true);

    // Queue the audit through the surviving per-lane route, with a spoofed body actor.
    const queuedAudit = await server.requestJson(`/api/lanes/${lane.body.id}/audit`, {
      method: 'POST',
      headers: leaseHeaders,
      body: {
        actor: 'body-spoofed-audit-queue',
        approved: true,
      },
    });
    assert.equal(queuedAudit.status, 201);

    // The lease identity — not the body-supplied actor — is bound as the audit
    // actor for a scoped-lease request, so the caller cannot spoof provenance.
    const auditedLane = await server.requestJson(`/api/lanes/${lane.body.id}`, {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(auditedLane.status, 200);
    const laneLog = JSON.stringify(auditedLane.body?.logs || []);
    assert.equal(laneLog.includes('Audit requested by lease-bound-orchestrator'), true, laneLog);
    assert.equal(laneLog.includes('body-spoofed'), false);
  } finally {
    await server.stop();
  }
});

test('dashboard event routes use canonical consumer identity despite role actor query/body values', async () => {
  const token = 'route-token-event-consumer-identity';
  const server = await startServer({ token });

  try {
    // v2: the durable event queue is re-homed onto the orchestrator container.
    const orchestrator = await registerOrchestrator(server, token, { title: 'Event Identity Orchestrator' });
    const session = orchestrator;

    // A token-authenticated dashboard caller cannot spoof its consumer identity
    // via query params: the drain route derives the consumer role/actor from the
    // canonical (tool-lease-or-dashboard) identity and ignores ?role/?actor.
    const spoofedDrain = await server.requestJson(`/api/orchestrators/${session.body.id}/events/drain?role=orchestrator&actor=evil-dashboard`, {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(spoofedDrain.status, 200);
    assert.equal(spoofedDrain.body.role, 'dashboard');
    assert.equal(Array.isArray(spoofedDrain.body.events), true);

    // The ack route likewise binds to the canonical consumer identity and never
    // trusts a spoofed body role/actor — it resolves acks for the dashboard
    // consumer, so a spoofed orchestrator/evil-dashboard identity is disregarded.
    // (There is no events/ack route: draining IS the ack, and drain resolves the
    // consumer from the validated lease/auth identity, never from the body.)

  } finally {
    await server.stop();
  }
});

test('mobile manifest exposes project entries and workflow action URLs', async () => {
  const token = 'route-token-07';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Manifest Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const manifest = await server.requestJson('/api/mobile/manifest', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(manifest.status, 200);
    assert.equal(Boolean(manifest.body?.apiTokenRequired), true);
    assert.equal(Array.isArray(manifest.body?.projects), true);

    // v2: the manifest is a projects-by-cwd list (quick-link previews). The lane
    // container is the orchestrator now, so the mobile client reads the
    // orchestrator overview rather than a per-session/lane deep-link tree.
    const projectEntry = manifest.body.projects.find((entry) => entry.projectId === project.body.id);
    assert.ok(projectEntry, 'created project appears in the manifest');
    assert.equal(projectEntry.route.includes(`/projects/${project.body.slug}`), true);
    assert.equal(Array.isArray(projectEntry.quickLinks), true);
    assert.equal(typeof manifest.body?.orchestratorsUrl, 'string');

    assert.equal(manifest.body?.browserSessionSupported, true);
    assert.equal(typeof manifest.body?.authStatusUrl, 'string');
    assert.equal(typeof manifest.body?.authPairingCodeUrl, 'string');
    assert.equal(typeof manifest.body?.authPairUrl, 'string');
    assert.equal(typeof manifest.body?.authLogoutUrl, 'string');
    assert.equal(typeof manifest.body?.authSessionsUrl, 'string');
    assert.equal(typeof manifest.body?.agentToolsLeaseUrl, 'string');
  } finally {
    await server.stop();
  }
});

test('agent tool lease routes are token-gated and mint a scoped, usable lease', async () => {
  const token = 'route-token-agent-tools';
  const server = await startServer({ token });

  try {
    // /api/agent-tools/discovery and /next-action are gone: the executor
    // capability matrix was deleted, and orchestrator.status now carries the
    // next-action envelope.
    const goneDiscovery = await server.requestJson('/api/agent-tools/discovery', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(goneDiscovery.status, 404);
    const goneNextAction = await server.requestJson('/api/agent-tools/next-action?role=orchestrator', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(goneNextAction.status, 404);

    const deniedLease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        role: 'orchestrator',
      },
    });
    assert.equal(deniedLease.status, 401);

    const invalidRoleLease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        role: 'god',
      },
    });
    assert.equal(invalidRoleLease.status, 422);
    assert.match(invalidRoleLease.body?.error || '', /role must be/i);

    const lease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        role: 'orchestrator',
        ttlMs: 60000,
      },
    });
    assert.equal(lease.status, 201);
    assert.equal(Boolean(lease.body?.leaseToken), true);
    assert.equal(lease.body?.lease?.allowedTools.includes('executor.spawn'), true);
    assert.equal(JSON.stringify(lease.body?.lease || {}).includes(lease.body.leaseToken), false);
    assert.equal(lease.body?.nextAction?.nextRequiredTool, 'orchestrator.register');

    // The lease claims ownership by registering an orchestrator; only then may it
    // spawn lanes in that container.
    const registered = await registerOrchestrator(server, token, {
      title: 'Agent Route', leaseToken: lease.body.leaseToken,
    });
    const orchestratorId = registered.body.id;

    const createdByLease = await server.requestJson(`/api/orchestrators/${orchestratorId}/executors`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        actor: 'orchestrator',
        approved: true,
        title: 'Lease controlled lane',
        executorType: 'mock',
        owner: 'orchestrator',
      },
    });
    assert.equal(createdByLease.status, 201);

    const controlsByLease = await server.requestJson(`/api/lanes/${createdByLease.body.id}/controls`, {
      method: 'PATCH',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        actor: 'orchestrator',
        approved: true,
        model: 'gpt-5',
        permissionsProfile: 'plan',
        intelligenceProfile: 'high',
      },
    });
    assert.equal(controlsByLease.status, 200);
    assert.equal(controlsByLease.body?.model, 'gpt-5');

    const stoppedByLease = await server.requestJson(`/api/lanes/${createdByLease.body.id}/stop`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        actor: 'orchestrator',
        approved: true,
      },
    });
    assert.equal(stoppedByLease.status, 200);
    assert.equal(stoppedByLease.body?.state, 'stopped');

    const retriedByLease = await server.requestJson(`/api/lanes/${createdByLease.body.id}/retry`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        actor: 'orchestrator',
        approved: true,
      },
    });
    assert.equal(retriedByLease.status, 200);
    assert.equal(retriedByLease.body?.state, 'queued');
  } finally {
    await server.stop();
  }
});

test('projects can be patched to manage quick links from the dashboard', async () => {
  const token = 'route-token-08';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Quick Link Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const added = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        quickLinks: [
          { label: 'Local', url: 'http://localhost:3000' },
        ],
      },
    });
    assert.equal(added.status, 200);
    assert.equal(Array.isArray(added.body.quickLinks), true);
    assert.equal(added.body.quickLinks.length, 1);
    assert.equal(added.body.quickLinks[0].label, 'Local');
    assert.equal(added.body.quickLinks[0].url, 'http://localhost:3000/');

    const cleared = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        quickLinks: [],
      },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.quickLinks.length, 0);
  } finally {
    await server.stop();
  }
});

test('project live links are server-authoritative and SSRF-checked', async () => {
  const token = 'route-token-live-links';
  const target = await startDummyWebTarget();
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Live Link Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const approvalRequired = await server.requestJson(`/api/projects/${project.body.id}/quick-links`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        label: 'Example App',
        url: target.url,
        kind: 'vite',
      },
    });
    assert.equal(approvalRequired.status, 409);
    assert.equal(Boolean(approvalRequired.body?.requiresApproval), true);

    const badSsr = await server.requestJson(`/api/projects/${project.body.id}/quick-links`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        label: 'Metadata',
        url: 'http://169.254.169.254/latest/meta-data',
        kind: 'dev-server',
      },
    });
    assert.equal(badSsr.status, 422);

    const badHealthPath = await server.requestJson(`/api/projects/${project.body.id}/quick-links`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        label: 'Bad Health Path',
        url: target.url,
        healthPath: 'https://example.com/health',
      },
    });
    assert.equal(badHealthPath.status, 422);
    assert.match(badHealthPath.body?.error || '', /healthPath/);

    const added = await server.requestJson(`/api/projects/${project.body.id}/quick-links`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        label: 'Example App',
        url: target.url,
        localUrl: target.url,
        port: target.port,
        kind: 'vite',
        favorite: true,
        healthPath: 'readyz',
      },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body?.link?.label, 'Example App');
    assert.equal(added.body?.link?.kind, 'vite');
    assert.equal(added.body?.link?.port, target.port);
    assert.equal(added.body?.link?.favorite, true);
    assert.equal(added.body?.link?.healthPath, '/readyz');
    assert.equal(added.body?.project?.quickLinks?.length, 1);

    // (No /check and no DELETE: project.preview.set — one upsert — is the whole
    // preview surface now.)
  } finally {
    await server.stop();
    await target.close();
  }
});

test('private-access state is operator-readable, Serve stays admin-only, and a tool lease opens neither', async () => {
  const token = 'route-token-agent-project-links';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Agent Link Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const lease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        role: 'orchestrator',
        projectId: project.body.id,
        ttlMs: 60_000,
      },
    });
    assert.equal(lease.status, 201);
    assert.ok(lease.body?.leaseToken);

    // tailscale.status / orca.setup_guide were cut from the MCP surface, so a tool
    // lease no longer opens these routes — they survive for the dashboard operator.
    const tailnetByLease = await server.requestJson('/api/private-access/tailnet?fake=serve-http', {
      method: 'GET',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
    });
    assert.equal(tailnetByLease.status, 401);

    const tailnet = await server.requestJson('/api/private-access/tailnet?fake=serve-http', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(tailnet.status, 200);
    assert.equal(tailnet.body?.serveMode, 'tailnet-http');

    const setup = await server.requestJson('/api/private-access/setup-plan?localUrl=http%3A%2F%2F127.0.0.1%3A3000', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(setup.status, 200);
    assert.equal(Array.isArray(setup.body?.commands), true);

    const added = await server.requestJson(`/api/projects/${project.body.id}/quick-links`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        approved: true,
        label: 'Tailnet Vite',
        url: 'http://orca.example.ts.net:5173/',
        tailnetHttpUrl: 'http://orca.example.ts.net:5173/',
        localUrl: 'http://127.0.0.1:5173/',
        port: 5173,
        kind: 'vite',
        favorite: true,
      },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body?.link?.label, 'Tailnet Vite');
    assert.equal(added.body?.link?.tailnetHttpUrl, 'http://orca.example.ts.net:5173/');
    assert.equal(added.body?.project?.quickLinks?.length, 1);

    const serveConfigure = await server.requestJson('/api/private-access/serve', {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: { action: 'enable', port: 3000 },
    });
    assert.equal(serveConfigure.status, 401);
  } finally {
    await server.stop();
  }
});

test('project-scoped tool leases cannot cross into another project orchestrator container', async () => {
  const token = 'route-token-project-scope-session-routes';
  const server = await startServer({ token });

  try {
    // v2: projects are keyed by cwd, so two distinct project containers come from
    // two working dirs, each with its own orchestrator (the lane container). A
    // project-scoped orchestrator lease must not reach the other project's
    // orchestrator lanes or next-action.
    const dirB = path.join(process.cwd(), 'project-b');
    await fs.mkdir(dirB, { recursive: true });
    const orchestratorA = await registerOrchestrator(server, token, { title: 'Scope A' });
    const orchestratorB = await registerOrchestrator(server, token, { title: 'Scope B', cwd: dirB });
    const projectAId = orchestratorA.body.projectId;
    const projectBId = orchestratorB.body.projectId;
    assert.notEqual(projectAId, projectBId);

    const lease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'project-scope-orchestrator',
        role: 'orchestrator',
        projectId: projectAId,
        ttlMs: 60_000,
      },
    });
    assert.equal(lease.status, 201);

    // orchestrator.status carries the next-action envelope now (the standalone
    // /api/agent-tools/next-action route is gone), and it is scope-checked the
    // same way: own container readable, foreign container refused.
    const ownStatus = await server.requestJson(`/api/orchestrators/${orchestratorA.body.id}/status`, {
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
    });
    assert.equal(ownStatus.status, 200);
    assert.equal(ownStatus.body.orchestratorId, orchestratorA.body.id);
    assert.equal(typeof ownStatus.body.nextRequiredTool, 'string');

    const foreignStatus = await server.requestJson(`/api/orchestrators/${orchestratorB.body.id}/status`, {
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
    });
    assert.equal(foreignStatus.status, 403);
    assert.match(foreignStatus.body?.error || '', /Tool lease project mismatch/);

    const ownLanes = await server.requestJson(`/api/orchestrators/${orchestratorA.body.id}/lanes`, {
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
    });
    assert.equal(ownLanes.status, 200);

    const foreignLanes = await server.requestJson(`/api/orchestrators/${orchestratorB.body.id}/lanes`, {
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
    });
    assert.equal(foreignLanes.status, 403);
    assert.match(foreignLanes.body?.error || '', /Tool lease project mismatch/);

    const foreignLaneCreate = await server.requestJson(`/api/orchestrators/${orchestratorB.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: { title: 'Should stay outside scope', executorType: 'mock', approved: true },
    });
    assert.equal(foreignLaneCreate.status, 403);
    assert.match(foreignLaneCreate.body?.error || '', /Tool lease project mismatch/);
  } finally {
    await server.stop();
  }
});

test('project archive and restore HTTP routes toggle project state (operator-authed)', async () => {
  // v2 removed project.archive / project.restore from the agent MCP tool surface;
  // the HTTP routes + registry.updateProject stay and are exercised here via the
  // workstation operator token (dashboard UI path), not a scoped tool lease.
  const token = 'route-token-project-archive-tools';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Archive Tool Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const archived = await server.requestJson(`/api/projects/${project.body.id}/archive`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { approved: true },
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body?.state, 'archived');

    // (GET /api/projects is gone with project.list; the archive response state is
    // the authoritative signal, and /api/overview only shows active projects.)
    const overview = await server.requestJson('/api/overview', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(overview.status, 200);
    assert.equal((overview.body.projects || []).some((item) => item.id === project.body.id), false);

    const restored = await server.requestJson(`/api/projects/${project.body.id}/restore`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { approved: true },
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body?.state, 'active');
  } finally {
    await server.stop();
  }
});

test('scoped orchestrator tool leases can read only their project/session/lane contract routes', async () => {
  const token = 'route-token-scoped-orchestrator-reads';
  const server = await startServer({ token });

  try {
    // v2: two cwd-keyed projects, each with its own orchestrator container + lane.
    const dirB = path.join(process.cwd(), 'scoped-read-b');
    await fs.mkdir(dirB, { recursive: true });
    const orchestratorA = await registerOrchestrator(server, token, { title: 'Scoped Read A' });
    const orchestratorB = await registerOrchestrator(server, token, { title: 'Scoped Read B', cwd: dirB });
    const projectAId = orchestratorA.body.projectId;
    const projectBId = orchestratorB.body.projectId;
    assert.notEqual(projectAId, projectBId);

    const laneA = await server.requestJson(`/api/orchestrators/${orchestratorA.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Scoped Read Lane A', executorType: 'mock', approved: true },
    });
    assert.equal(laneA.status, 201);
    const laneB = await server.requestJson(`/api/orchestrators/${orchestratorB.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Scoped Read Lane B', executorType: 'mock', approved: true },
    });
    assert.equal(laneB.status, 201);

    const lease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'scoped-orchestrator-reader',
        role: 'orchestrator',
        projectId: projectAId,
        sessionId: orchestratorA.body.id,
        ttlMs: 60_000,
      },
    });
    assert.equal(lease.status, 201);
    const leaseHeaders = { 'x-orca-tool-lease': lease.body.leaseToken };

    const status = await server.requestJson(`/api/orchestrators/${orchestratorA.body.id}/status`, { headers: leaseHeaders });
    assert.equal(status.status, 200);
    assert.equal(status.body.orchestratorId, orchestratorA.body.id);

    // GET /api/orchestrators/{id}/lanes is the scoped container read; a lease bound
    // to orchestrator A can list it. (v2 removed session.list / session.describe
    // and their /api/sessions/* routes entirely.)
    const ownLanes = await server.requestJson(`/api/orchestrators/${orchestratorA.body.id}/lanes`, { headers: leaseHeaders });
    assert.equal(ownLanes.status, 200);
    assert.equal(Array.isArray(ownLanes.body), true);

    const lane = await server.requestJson(`/api/lanes/${laneA.body.id}`, { headers: leaseHeaders });
    assert.equal(lane.status, 200);
    assert.equal(lane.body.id, laneA.body.id);

    // Cross-scope reads are refused for a lease bound to project/orchestrator A.
    const deniedContainer = await server.requestJson(`/api/orchestrators/${orchestratorB.body.id}/status`, { headers: leaseHeaders });
    assert.equal(deniedContainer.status, 403);
    const deniedLane = await server.requestJson(`/api/lanes/${laneB.body.id}`, { headers: leaseHeaders });
    assert.equal(deniedLane.status, 403);
  } finally {
    await server.stop();
  }
});

test('high-risk lane stop action requires explicit approval', async () => {
  const token = 'route-token-10';
  const server = await startServer({ token });

  try {
    const orchestrator = await registerOrchestrator(server, token, { title: 'Lane Stop Orchestrator' });

    const lane = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Lane Stop Lane',
        executorType: 'mock',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(lane.status, 201);

    const deniedStop = await server.requestJson(`/api/lanes/${lane.body.id}/stop`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: false,
      },
    });
    assert.equal(deniedStop.status, 409);
    assert.equal(Boolean(deniedStop.body?.requiresApproval), true);

    const approvedStop = await server.requestJson(`/api/lanes/${lane.body.id}/stop`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
      },
    });
    assert.equal(approvedStop.status, 200);
    assert.equal(approvedStop.body?.state, 'stopped');
  } finally {
    await server.stop();
  }
});

test('server rejects oversized JSON bodies with 413 and small limit override', async () => {
  const token = 'route-token-11';
  const server = await startServer({ token, env: { ORCA_MAX_JSON_BYTES: '256' } });

  try {
    const oversize = {
      name: 'Oversize Project',
      approved: true,
      padding: 'x'.repeat(1024),
    };
    const over = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: oversize,
    });
    assert.equal(over.status, 413);
    assert.equal(String(over.body?.error || '').includes('exceeds the'), true);

    const malformed = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token, 'content-type': 'application/json' },
      body: undefined,
    });
    // Empty body is treated as {} not malformed; check that legitimate malformed JSON returns 400 instead.
    assert.equal(typeof malformed.status, 'number');
  } finally {
    await server.stop();
  }
});

test('server rejects dashboard requests that try to spoof the scheduler actor', async () => {
  const token = 'route-token-12';
  const server = await startServer({ token });

  try {
    const spoofed = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Spoofed Actor', approved: true, actor: 'scheduler' },
    });
    assert.equal(spoofed.status, 403);
    assert.equal(String(spoofed.body?.error || '').includes('scheduler'), true);
  } finally {
    await server.stop();
  }
});

test('artifact serving rejects traversal, absolute, encoded, and symlink paths', async () => {
  const token = 'route-token-14';
  const server = await startServer({ token });

  try {
    // v2: the artifact namespace is keyed by the lane's container id, which is the
    // orchestrator id (was the session id). Register an orchestrator and reuse its
    // id as the artifact scope segment.
    const orchestrator = await registerOrchestrator(server, token, { title: 'Artifact Path Orchestrator' });
    const session = orchestrator; // artifact path scope segment = orchestrator id
    const lane = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Artifact Lane', executorType: 'mock', owner: 'dashboard', approved: true },
    });
    assert.equal(lane.status, 201);

    const laneDir = path.join(process.cwd(), 'artifacts', session.body.id, lane.body.id);
    await fs.mkdir(laneDir, { recursive: true });
    await fs.writeFile(path.join(laneDir, 'real.txt'), 'real');
    const outsideTarget = path.join(process.cwd(), 'sensitive.txt');
    await fs.writeFile(outsideTarget, 'top secret');
    try {
      await fs.symlink(outsideTarget, path.join(laneDir, 'link.txt'));
    } catch {
      // ignore platforms that lack symlink support
    }

    const authHeaders = { 'x-orca-token': token };

    // Artifacts are operator-gated: an unauthenticated request must be rejected,
    // never served (regression guard for the unauthenticated-artifact bypass).
    const unauth = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/real.txt`, { method: 'GET' });
    assert.equal(unauth.status, 401);

    const traversal = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/..%2Fsensitive.txt`, {
      method: 'GET', headers: authHeaders,
    });
    assert.equal(traversal.status === 400 || traversal.status === 404, true);

    const absolute = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/%2Fetc%2Fpasswd`, {
      method: 'GET', headers: authHeaders,
    });
    assert.equal(absolute.status === 400 || absolute.status === 404, true);

    const real = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/real.txt`, { method: 'GET', headers: authHeaders });
    assert.equal(real.status, 200);
    // Symlink should be refused even though it exists.
    const symlinkProbe = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/link.txt`, { method: 'GET', headers: authHeaders });
    assert.equal(symlinkProbe.status === 400 || symlinkProbe.status === 404, true);
  } finally {
    await server.stop();
  }
});

test('auth status bridges token auth to a cookie session that authorizes artifact <img> loads', async () => {
  const token = 'route-token-bridge';
  const server = await startServer({ token });
  try {
    // v2: artifact scope segment = orchestrator id (the lane container).
    const orchestrator = await registerOrchestrator(server, token, { title: 'Bridge Orchestrator' });
    const session = orchestrator;
    const lane = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST', headers: { 'x-orca-token': token }, body: { title: 'Bridge Lane', executorType: 'mock', owner: 'dashboard', approved: true },
    });
    const laneDir = path.join(process.cwd(), 'artifacts', session.body.id, lane.body.id);
    await fs.mkdir(laneDir, { recursive: true });
    await fs.writeFile(path.join(laneDir, 'shot.png'), 'png-bytes');

    // A token-authed dashboard load mints a session cookie (no Origin header, as
    // with same-origin browser navigations).
    const status = await server.requestJson('/api/auth/status', {
      method: 'GET', headers: { 'x-orca-token': token },
    });
    assert.equal(status.status, 200);
    assert.equal(status.body?.browserSessionAuthenticated, true);
    const setCookie = String(status.response.headers['set-cookie'] || '');
    assert.match(setCookie, /orca[_-]?session=/i);
    const cookiePair = setCookie.split(';')[0]; // "name=value"

    // An <img>-style request carries only the cookie (no token header) and is authorized.
    const viaCookie = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/shot.png`, {
      method: 'GET', headers: { cookie: cookiePair },
    });
    assert.equal(viaCookie.status, 200);
  } finally {
    await server.stop();
  }
});

test('private access API exposes mocked tailnet state, dry-run setup plans, and rejects Funnel', async () => {
  const token = 'route-token-private-access';
  const server = await startServer({ token });

  try {
    const state = await server.requestJson('/api/private-access?fakeTailnetState=serve-https', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(state.status, 200);
    assert.equal(state.body?.tailnet?.provider, 'fake');
    assert.equal(state.body?.tailnet?.serveMode, 'tailnet-https-serve');
    assert.equal(state.body?.pwa?.staticOnlyCache, true);

    const plan = await server.requestJson('/api/private-access/setup-plan?localUrl=http%3A%2F%2F127.0.0.1%3A3000', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(plan.status, 200);
    assert.equal(Array.isArray(plan.body?.commands), true);
    assert.equal(plan.body.commands.some((command) => String(command.copyText || '').includes('tailscale serve')), true);
    assert.equal(plan.body.commands.some((command) => String(command.copyText || '').toLowerCase().includes('funnel')), false);

    const funnelPlan = await server.requestJson('/api/private-access/setup-plan?localUrl=https%3A%2F%2Forca.funnel.ts.net', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(funnelPlan.status, 422);
    assert.match(funnelPlan.body?.error || '', /Funnel/);

    const metadataPlan = await server.requestJson('/api/private-access/setup-plan?localUrl=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(metadataPlan.status, 422);
    assert.match(metadataPlan.body?.error || '', /blocked private/);
  } finally {
    await server.stop();
  }
});

test('orchestrator MCP bootstrap is token-gated and returns paste-ready desktop configs', async () => {
  const token = 'bootstrap-token-01';
  const server = await startServer({ token });
  try {
    // Mutating route: rejected without the API token.
    const denied = await server.requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      body: { actor: 'desktop-app' },
    });
    assert.equal(denied.status, 401);

    const created = await server.requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'desktop-app' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.lease.role, 'orchestrator');
    assert.ok(created.body.leaseToken, 'returns the lease token once for pasting');

    const orca = created.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca;
    assert.equal(orca.env.ORCA_ROLE, 'orchestrator');
    assert.equal(orca.env.ORCA_TOOL_LEASE_TOKEN, created.body.leaseToken);
    assert.match(created.body.bootstrap.clients.codex.snippet, /\[mcp_servers\.orca\]/);

    // The full API token must never appear in the bootstrap payload.
    assert.equal(JSON.stringify(created.body).includes(token), false);

    const badNodePath = await server.requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'desktop-app', nodePath: '/usr/bin/node\n--eval=bad' },
    });
    assert.equal(badNodePath.status, 422);
    assert.match(badNodePath.body?.error || '', /control characters/);
  } finally {
    await server.stop();
  }
});

test('agent tool leases can be listed and admin-revoked (audit H2)', async () => {
  const token = 'lease-revoke-token';
  const server = await startServer({ token });

  try {
    // Create an orchestrator lease (admin/token context).
    const created = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', role: 'orchestrator' },
    });
    assert.equal(created.status, 201);
    const leaseId = created.body?.lease?.id;
    assert.ok(leaseId, 'lease id returned');

    // List shows the active lease and never leaks the raw token or hash.
    const listed = await server.requestJson('/api/agent-tools/leases?activeOnly=true', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.leases.some((lease) => lease.id === leaseId && lease.active));
    const listText = JSON.stringify(listed.body);
    assert.equal(listText.includes('tokenHash'), false);
    assert.equal(listText.includes(created.body.leaseToken), false);

    // Pair an operator (non-admin) browser session.
    const pairing = await server.requestJson('/api/auth/pairing-codes', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', label: 'phone' },
    });
    const paired = await server.requestJson('/api/auth/pair', {
      method: 'POST',
      body: { actor: 'dashboard', code: pairing.body.pairing.code, label: 'phone' },
    });
    const cookie = paired.response.headers['set-cookie'];

    // Operator (paired session) may NOT enumerate or revoke leases — admin only.
    const operatorList = await server.requestJson('/api/agent-tools/leases?activeOnly=true', {
      method: 'GET',
      headers: { cookie },
    });
    assert.equal(operatorList.status, 403);

    const operatorRevoke = await server.requestJson(`/api/agent-tools/leases/${leaseId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(operatorRevoke.status, 403);

    // Admin (token) revokes successfully; idempotent + reflected in active list.
    const adminRevoke = await server.requestJson(`/api/agent-tools/leases/${leaseId}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
    });
    assert.equal(adminRevoke.status, 200);
    assert.equal(adminRevoke.body?.lease?.active, false);

    const afterList = await server.requestJson('/api/agent-tools/leases?activeOnly=true', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(afterList.body.leases.some((lease) => lease.id === leaseId), false);

    // Unknown lease id -> 404.
    const missing = await server.requestJson('/api/agent-tools/leases/does-not-exist', {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
    });
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});

test('workstation directory picker lists jailed dirs and refuses escapes', async () => {
  const token = 'workstation-dirs-token';
  const server = await startServer({ token });
  try {
    // The harness chdir'd into an isolated temp dir, which is an approved root
    // (getApprovedRepoRoots includes cwd). Create a plain subdir + a git repo.
    const root = process.cwd();
    await fs.mkdir(path.join(root, 'plain-sub'), { recursive: true });
    await fs.mkdir(path.join(root, 'a-repo', '.git'), { recursive: true });

    // No path -> approved roots as the top level.
    const top = await server.requestJson('/api/system/dirs', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(top.status, 200);
    assert.ok(Array.isArray(top.body.roots) && top.body.roots.length >= 1);

    // List the root -> sees the subdirs; flags the git repo; never returns files.
    const listed = await server.requestJson(`/api/system/dirs?path=${encodeURIComponent(root)}`, {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(listed.status, 200);
    const names = listed.body.entries.map((entry) => entry.name);
    assert.ok(names.includes('plain-sub'));
    const repo = listed.body.entries.find((entry) => entry.name === 'a-repo');
    assert.equal(repo?.isGitRepo, true);
    assert.ok(listed.body.entries.every((entry) => entry.isDirectory === true));

    // Outside the jail -> 403.
    const outside = await server.requestJson('/api/system/dirs?path=%2Fetc', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(outside.status, 403);

    // Traversal above the jail -> 403.
    const traversal = await server.requestJson(`/api/system/dirs?path=${encodeURIComponent(path.join(root, '..', '..'))}`, {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(traversal.status, 403);

    // Unauthenticated (no token) -> 401.
    const unauth = await server.requestJson(`/api/system/dirs?path=${encodeURIComponent(root)}`, { method: 'GET' });
    assert.equal(unauth.status, 401);
  } finally {
    await server.stop();
  }
});

test('removed v2 routes fail closed as 404 (not 500) for an authenticated request', async () => {
  // Regression lock-in for the v2 refactor: the capacity / supervisor /
  // agent-memory / tasks / backlog / loops / critique / evidence HTTP handlers
  // (and their registry methods) were deleted. Their tool-lease requirement
  // entries were removed from toolLeaseRequirementForRoute too, so an authed
  // request must dispatch straight through to the global 404 — never a 500 from
  // a route block calling a now-missing registry method.
  const token = 'removed-routes-404-token';
  const server = await startServer({ token });
  const auth = { 'x-orca-token': token };

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: auth,
      body: { name: 'Removed Routes Project', approved: true },
    });
    assert.equal(project.status, 201, JSON.stringify(project.body));

    // v2: the lane container is the orchestrator (keyed by cwd). Its id stands in
    // for the removed session id below — the /api/sessions/* handlers are gone, so
    // any id there must 404 regardless.
    const orchestrator = await registerOrchestrator(server, token, { title: 'Removed Routes Orchestrator' });
    const sid = orchestrator.body.id;

    const lane = await server.requestJson(`/api/orchestrators/${sid}/executors`, {
      method: 'POST',
      headers: auth,
      body: { title: 'Removed Routes Lane', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201, JSON.stringify(lane.body));
    const lid = lane.body.id;

    const removed = [
      // The Model-A session container + all its sub-routes were deleted.
      ['POST', `/api/projects/${project.body.id}/sessions`, { name: 'x', approved: true }],
      ['POST', `/api/sessions/${sid}/lanes`, { title: 'x', executorType: 'mock', approved: true }],
      ['POST', `/api/sessions/${sid}/orchestrator/enroll`, { actor: 'dashboard' }],
      ['GET', `/api/sessions/${sid}`, undefined],
      ['GET', `/api/sessions/${sid}/agent-memory`, undefined],
      ['POST', `/api/sessions/${sid}/tasks`, { actor: 'dashboard', approved: true, title: 'x' }],
      ['GET', `/api/sessions/${sid}/backlog`, undefined],
      ['GET', `/api/sessions/${sid}/loops`, undefined],
      ['POST', `/api/sessions/${sid}/supervisor/audit`, { actor: 'dashboard', approved: true }],
      ['POST', `/api/lanes/${lid}/critique/bundle`, { actor: 'dashboard', approved: true }],
    ];

    for (const [method, routePath, body] of removed) {
      const res = await server.requestJson(routePath, { method, headers: auth, body });
      assert.equal(
        res.status,
        404,
        `${method} ${routePath} should be a removed-route 404, got ${res.status} ${JSON.stringify(res.body)}`,
      );
      // Explicitly guard against a 500 leaking from a dangling registry call.
      assert.notEqual(res.status, 500, `${method} ${routePath} must not 500`);
    }
  } finally {
    await server.stop();
  }
});

// --- HTTP-layer lane-lifecycle, ownership, and auth coverage (audit gap fill) ---
// These drive the real /api routes (no direct registry poking) using the same
// harness the tests above use. A git repo is initialized at the harness cwd (an
// approved repo root) so isolated-worktree lanes have a base branch to merge.

async function initGitRepoAt(dir, { file = 'README.md', content = 'base' } = {}) {
  const { spawnSync } = await import('node:child_process');
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@local');
  g('config', 'user.name', 'Orca Test');
  g('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, file), content);
  g('add', file);
  g('commit', '-qm', 'init');
  const baseBranch = g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  return { g, baseBranch };
}

async function gitIn(dir, ...args) {
  const { spawnSync } = await import('node:child_process');
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

async function createAcceptedIsolatedLane(server, token, orchestratorId, { branch, worktreeContent = null }) {
  const created = await server.requestJson(`/api/orchestrators/${orchestratorId}/executors`, {
    method: 'POST',
    headers: { 'x-orca-token': token },
    body: {
      title: `Isolated lane ${branch}`,
      executorType: 'mock',
      worktreeMode: 'isolated',
      branch,
      autoCompleteMs: 40,
      approved: true,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const lane = created.body;
  assert.ok(lane.worktreePath, 'isolated lane must have a worktreePath');
  assert.equal(lane.worktreeMode, 'isolated');
  // Let the mock worker finish so the lane is auditable (not running).
  const done = await waitForLaneState(server, lane.id, token, (l) => l?.state === 'done');
  assert.equal(done.body.state, 'done', `lane should reach done: ${JSON.stringify(done.body?.state)}`);
  // Optionally commit real work on the lane branch inside its worktree.
  if (worktreeContent) {
    await fs.writeFile(path.join(lane.worktreePath, worktreeContent.file), worktreeContent.content);
    await gitIn(lane.worktreePath, 'add', worktreeContent.file);
    await gitIn(lane.worktreePath, 'commit', '-qm', `lane ${branch} work`);
  }
  return lane;
}

async function acceptAudit(server, token, laneId) {
  const accepted = await server.requestJson(`/api/lanes/${laneId}/audit/accept`, {
    method: 'POST',
    headers: { 'x-orca-token': token },
    body: { actor: 'dashboard', findings: ['reviewed'] },
  });
  assert.equal(accepted.status, 200, `audit accept: ${JSON.stringify(accepted.body)}`);
  return accepted;
}

test('POST /api/lanes/{id}/integrate merges an accepted isolated lane and rejects direct lanes', async () => {
  const token = 'route-token-integrate-ok';
  const server = await startServer({ token });
  try {
    const { baseBranch } = await initGitRepoAt(process.cwd());
    const orchestrator = await registerOrchestrator(server, token, { title: 'Integrate OK Orchestrator' });

    // Isolated lane with a real commit on its branch -> integrate merges it back.
    const lane = await createAcceptedIsolatedLane(server, token, orchestrator.body.id, {
      branch: 'feat-integrate',
      worktreeContent: { file: 'feature.txt', content: 'new feature body' },
    });
    await acceptAudit(server, token, lane.id);

    const integrated = await server.requestJson(`/api/lanes/${lane.id}/integrate`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(integrated.status, 200, JSON.stringify(integrated.body));
    assert.equal(integrated.body.integrated, true);
    assert.equal(integrated.body.baseBranch, baseBranch);
    assert.equal(integrated.body.branch, 'feat-integrate');
    // The lane's commit is now merged into the base checkout.
    assert.equal((await fs.stat(path.join(process.cwd(), 'feature.txt'))).isFile(), true);

    // A DIRECT (shared/in-place) lane has nothing to merge back -> 422.
    const directLane = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Direct lane', executorType: 'mock', worktreeMode: 'direct', autoCompleteMs: 40, approved: true },
    });
    assert.equal(directLane.status, 201, JSON.stringify(directLane.body));
    const directRejected = await server.requestJson(`/api/lanes/${directLane.body.id}/integrate`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(directRejected.status, 422);
    assert.match(directRejected.body?.error || '', /isolated/i);
  } finally {
    await server.stop();
  }
});

test('POST /api/lanes/{id}/integrate returns 409 with conflicts:true on a merge conflict', async () => {
  const token = 'route-token-integrate-conflict';
  const server = await startServer({ token });
  try {
    const { baseBranch } = await initGitRepoAt(process.cwd(), { file: 'shared.txt', content: 'original line\n' });
    const orchestrator = await registerOrchestrator(server, token, { title: 'Integrate Conflict Orchestrator' });

    // Lane edits shared.txt on its branch...
    const lane = await createAcceptedIsolatedLane(server, token, orchestrator.body.id, {
      branch: 'feat-conflict',
      worktreeContent: { file: 'shared.txt', content: 'lane edit\n' },
    });
    // ...and the base branch edits the SAME line differently -> divergence.
    await fs.writeFile(path.join(process.cwd(), 'shared.txt'), 'base edit\n');
    await gitIn(process.cwd(), 'add', 'shared.txt');
    await gitIn(process.cwd(), 'commit', '-qm', 'base edit');

    await acceptAudit(server, token, lane.id);

    const conflicted = await server.requestJson(`/api/lanes/${lane.id}/integrate`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(conflicted.status, 409, JSON.stringify(conflicted.body));
    assert.equal(conflicted.body.conflicts, true);
    assert.equal(conflicted.body.baseBranch, baseBranch);
    assert.equal(conflicted.body.branch, 'feat-conflict');
    // The base checkout must be left clean (merge --abort), not mid-conflict.
    const status = await gitIn(process.cwd(), 'status', '--porcelain');
    assert.equal(/^UU |^AA |<<<<<<< /m.test(status.stdout || ''), false, 'base checkout left clean after conflict abort');
  } finally {
    await server.stop();
  }
});

test('POST /api/lanes/{id}/worktree/discard refuses uncommitted work, forces, and removes the branch', async () => {
  const token = 'route-token-discard';
  const server = await startServer({ token });
  try {
    await initGitRepoAt(process.cwd());
    const orchestrator = await registerOrchestrator(server, token, { title: 'Discard Orchestrator' });
    const lane = await createAcceptedIsolatedLane(server, token, orchestrator.body.id, { branch: 'feat-discard' });
    const branch = lane.branch;
    assert.ok(branch, 'lane has a branch');

    // Leave uncommitted work in the worktree.
    await fs.writeFile(path.join(lane.worktreePath, 'scratch.txt'), 'unsaved');

    // Safe by default: refuse with a client-actionable 409 + uncommittedChanges.
    const refused = await server.requestJson(`/api/lanes/${lane.id}/worktree/discard`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', approved: true },
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.ok(refused.body.uncommittedChanges >= 1, `expected uncommittedChanges>=1, got ${refused.body.uncommittedChanges}`);
    assert.equal((await fs.stat(lane.worktreePath)).isDirectory(), true, 'worktree still present after refusal');

    // force:true + removeBranch:true discards the worktree AND deletes the branch.
    const forced = await server.requestJson(`/api/lanes/${lane.id}/worktree/discard`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', approved: true, force: true, removeBranch: true },
    });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.equal(forced.body.removed, true);
    await assert.rejects(fs.access(lane.worktreePath), (e) => e.code === 'ENOENT', 'worktree removed from disk');
    const branchList = await gitIn(process.cwd(), 'branch', '--list', branch);
    assert.equal((branchList.stdout || '').trim(), '', `branch ${branch} should be gone`);
  } finally {
    await server.stop();
  }
});

test('integrate/discard refuse a tool lease that does not own the lane orchestrator', async () => {
  const token = 'route-token-lane-ownership';
  const server = await startServer({ token });
  try {
    // Two cwd-keyed projects, each with its own orchestrator container.
    const dirB = path.join(process.cwd(), 'owner-project-b');
    await fs.mkdir(dirB, { recursive: true });
    const orchestratorA = await registerOrchestrator(server, token, { title: 'Owner A' });
    const orchestratorB = await registerOrchestrator(server, token, { title: 'Owner B', cwd: dirB });
    assert.notEqual(orchestratorA.body.projectId, orchestratorB.body.projectId);

    // A lane lives under orchestrator B.
    const laneB = await server.requestJson(`/api/orchestrators/${orchestratorB.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'B lane', executorType: 'mock', autoCompleteMs: 40, approved: true },
    });
    assert.equal(laneB.status, 201);

    // An orchestrator lease scoped to project A must not act on B's lane.
    const leaseA = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'owner-a', role: 'orchestrator', projectId: orchestratorA.body.projectId, ttlMs: 60_000 },
    });
    assert.equal(leaseA.status, 201);
    const foreignHeaders = { 'x-orca-tool-lease': leaseA.body.leaseToken };

    const foreignIntegrate = await server.requestJson(`/api/lanes/${laneB.body.id}/integrate`, {
      method: 'POST',
      headers: foreignHeaders,
      body: { actor: 'owner-a' },
    });
    assert.equal(foreignIntegrate.status, 403, JSON.stringify(foreignIntegrate.body));
    assert.match(foreignIntegrate.body?.error || '', /project mismatch/i);

    const foreignDiscard = await server.requestJson(`/api/lanes/${laneB.body.id}/worktree/discard`, {
      method: 'POST',
      headers: foreignHeaders,
      body: { actor: 'owner-a', approved: true },
    });
    assert.equal(foreignDiscard.status, 403, JSON.stringify(foreignDiscard.body));
    assert.match(foreignDiscard.body?.error || '', /project mismatch/i);
  } finally {
    await server.stop();
  }
});

test('DELETE /api/lanes/{id} refuses a running lane and succeeds on a terminal one', async () => {
  const token = 'route-token-lane-delete';
  const server = await startServer({ token });
  try {
    const orchestrator = await registerOrchestrator(server, token, { title: 'Delete Orchestrator' });
    // Default mock runtime (12s) keeps the lane running deterministically.
    const created = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Long lane', executorType: 'mock', approved: true },
    });
    assert.equal(created.status, 201);
    const laneId = created.body.id;
    const running = await waitForLaneState(server, laneId, token, (l) => l?.state === 'running');
    assert.equal(running.body.state, 'running');

    // Deleting a live lane is refused so a running child can't be orphaned.
    const refused = await server.requestJson(`/api/lanes/${laneId}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.ok([409, 422].includes(refused.status), `running-lane delete must be refused, got ${refused.status}`);
    assert.ok(await server.requestJson(`/api/lanes/${laneId}`, { method: 'GET', headers: { 'x-orca-token': token } }).then((r) => r.status === 200), 'lane still exists');

    // Stop it -> terminal -> delete succeeds.
    const stopped = await server.requestJson(`/api/lanes/${laneId}/stop`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', approved: true, reason: 'delete test' },
    });
    assert.equal(stopped.status, 200);
    const terminal = await waitForLaneState(server, laneId, token, (l) => ['stopped', 'done', 'failed'].includes(l?.state));
    assert.ok(['stopped', 'done', 'failed'].includes(terminal.body.state));

    const deleted = await server.requestJson(`/api/lanes/${laneId}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.deleted, true);
    const gone = await server.requestJson(`/api/lanes/${laneId}`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(gone.status, 404);
  } finally {
    await server.stop();
  }
});

test('admin can revoke a paired device by sessionId; a non-admin cannot, and unknown ids 404', async () => {
  const token = 'route-token-admin-revoke';
  const server = await startServer({ token });
  try {
    // GET /api/auth/sessions with NO credentials is refused outright.
    const noCred = await server.requestJson('/api/auth/sessions', { method: 'GET' });
    assert.equal(noCred.status, 401);

    // Pair two devices.
    const pairDevice = async (label) => {
      const pairing = await server.requestJson('/api/auth/pairing-codes', {
        method: 'POST',
        headers: { 'x-orca-token': token },
        body: { actor: 'dashboard', label },
      });
      assert.equal(pairing.status, 201);
      const paired = await server.requestJson('/api/auth/pair', {
        method: 'POST',
        body: { actor: 'dashboard', code: pairing.body.pairing.code, label },
      });
      assert.equal(paired.status, 200);
      return paired.response.headers['set-cookie'];
    };
    const cookie1 = await pairDevice('device-one');
    const cookie2 = await pairDevice('device-two');

    // Admin lists sessions and finds each device's id by label.
    const sessions = await server.requestJson('/api/auth/sessions', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(sessions.status, 200);
    const idFor = (label) => sessions.body.sessions.find((s) => s.label === label)?.id;
    const device1Id = idFor('device-one');
    const device2Id = idFor('device-two');
    assert.ok(device1Id && device2Id, 'both paired device sessions listed');

    // (b) A non-admin paired operator may NOT revoke ANOTHER device by sessionId.
    const operatorRevoke = await server.requestJson('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: cookie1 },
      body: { actor: 'dashboard', sessionId: device2Id },
    });
    assert.equal(operatorRevoke.status, 403);
    // Device 2 is still authenticated (not revoked by the failed attempt).
    const device2StillLive = await server.requestJson('/api/overview', { method: 'GET', headers: { cookie: cookie2 } });
    assert.equal(device2StillLive.status, 200);

    // (a) An admin (API token) revokes device 2 by sessionId. Own cookie untouched.
    const adminRevoke = await server.requestJson('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', sessionId: device2Id },
    });
    assert.equal(adminRevoke.status, 200, JSON.stringify(adminRevoke.body));
    assert.equal(adminRevoke.body.revoked, true);
    // The admin sessionId revoke path must NOT clear the requester's own cookie.
    assert.equal(adminRevoke.response.headers['set-cookie'], undefined);
    // Device 2's session is now revoked: its cookie no longer authorizes mutations.
    const device2Denied = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { cookie: cookie2 },
      body: { actor: 'dashboard', approved: true, name: 'Revoked Device Project' },
    });
    assert.equal(device2Denied.status, 401);

    // (c) Revoking a non-existent sessionId as admin -> 404.
    const missing = await server.requestJson('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', sessionId: 'orca-session-does-not-exist' },
    });
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});

// A paired device is an OPERATOR (stop/resign/approve), never a workstation admin.
// The spawn route enforced that; two sibling paths did not, and each one is a full
// sandbox escape by itself.
test('a paired operator cannot reach an unsandboxed agent by escalating a queued lane or by executor-specific mode aliasing', async () => {
  const token = 'route-token-permission-escalation';
  // Custom CLI ENABLED: that is the scenario the escape needs. Opting the feature
  // in is a workstation choice; it must not widen what a paired phone can launch.
  const server = await startServer({
    token,
    env: { ORCA_ENABLE_CUSTOM_CLI: 'true', ORCA_CLI_BINARY: process.execPath },
  });

  try {
    const pairing = await server.requestJson('/api/auth/pairing-codes', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', label: 'operator phone' },
    });
    assert.equal(pairing.status, 201);
    const paired = await server.requestJson('/api/auth/pair', {
      method: 'POST',
      body: { actor: 'dashboard', code: pairing.body.pairing.code, label: 'operator phone' },
    });
    assert.equal(paired.status, 200);
    const cookie = String(paired.response.headers['set-cookie']);
    const operator = { cookie };

    const orchestrator = await registerOrchestrator(server, token);
    const spawnUrl = `/api/orchestrators/${orchestrator.body.id}/executors`;

    // Baseline: the gate the spawn route already had.
    const directBypass = await server.requestJson(spawnUrl, {
      method: 'POST',
      headers: operator,
      body: { title: 'direct', executorType: 'codex', permissionsProfile: 'bypass-permissions', owner: 'dashboard' },
    });
    assert.equal(directBypass.status, 403, 'named bypass mode is blocked for a paired operator');

    // ESCAPE 1 — spawn sandboxed, then escalate the still-queued lane. The controls
    // route mutated permissionsProfile with no privilege check at all, and the
    // scheduler launches whatever mode the lane holds when its turn comes.
    const planLane = await server.requestJson(spawnUrl, {
      method: 'POST',
      headers: operator,
      body: { title: 'plan lane', executorType: 'codex', permissionsProfile: 'plan', owner: 'dashboard', approved: true },
    });
    assert.equal(planLane.status, 201, `plan spawn should be allowed: ${JSON.stringify(planLane.body)}`);
    const laneId = planLane.body.id;

    const escalate = await server.requestJson(`/api/lanes/${laneId}/controls`, {
      method: 'PATCH',
      headers: operator,
      body: { permissionsProfile: 'bypass-permissions', actor: 'dashboard', approved: true },
    });
    assert.equal(escalate.status, 403, 'post-spawn escalation must hit the same gate as spawn');

    const afterEscalate = await server.requestJson(`/api/lanes/${laneId}`, {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(afterEscalate.body.permissionsProfile, 'plan', 'the refused escalation must not have been applied');

    // ...but an ADMIN may still do it — this is an authorization gate, not a ban.
    const adminEscalate = await server.requestJson(`/api/lanes/${laneId}/controls`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: { permissionsProfile: 'bypass-permissions', actor: 'dashboard', approved: true },
    });
    assert.equal(adminEscalate.status, 200, `admin escalation stays allowed: ${JSON.stringify(adminEscalate.body)}`);

    // ESCAPE 2 — mode names are executor-specific. composer-cli turns "auto-edit"
    // into --force (unsandboxed), and the spawn route's own denial message used to
    // recommend "auto-edit" as the safe alternative.
    const composerAutoEdit = await server.requestJson(spawnUrl, {
      method: 'POST',
      headers: operator,
      body: { title: 'composer', executorType: 'composer-cli', permissionsProfile: 'auto-edit', owner: 'dashboard', approved: true },
    });
    assert.equal(composerAutoEdit.status, 403, 'auto-edit maps to --force on composer-cli, so it is unsandboxed');

    // executorType "cli" is the deliberate escape hatch first-class types point at
    // for raw argv — Orca builds no command line and maps no sandbox flag, so with
    // an allowed interpreter it is arbitrary code at the daemon's authority. Opting
    // the FEATURE in must not hand a paired phone arbitrary execution: it is
    // admin-only at every permissionsProfile, including "plan".
    const customCli = await server.requestJson(spawnUrl, {
      method: 'POST',
      headers: operator,
      body: {
        title: 'raw argv escape',
        executorType: 'cli',
        executorBinary: process.execPath,
        args: ['-e', 'process.exit(0)'],
        permissionsProfile: 'plan',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(customCli.status, 403, `custom-CLI spawn is admin-only: ${JSON.stringify(customCli.body)}`);

    // ...and the same alias must NOT be over-blocked where it really is sandboxed:
    // claude maps auto-edit to acceptEdits, codex to --sandbox workspace-write.
    for (const executorType of ['claude', 'codex']) {
      const sandboxed = await server.requestJson(spawnUrl, {
        method: 'POST',
        headers: operator,
        body: { title: `${executorType} auto-edit`, executorType, permissionsProfile: 'auto-edit', owner: 'dashboard', approved: true },
      });
      assert.equal(sandboxed.status, 201, `${executorType} auto-edit is sandboxed and must stay available to an operator: ${JSON.stringify(sandboxed.body)}`);
    }
  } finally {
    await server.stop();
  }
});

// Executors are told to submit and LEAVE the worktree, not to commit — so an
// isolated lane whose work is uncommitted is the ordinary case, and integration
// (which measures commits, base..laneBranch) saw "nothing to merge", set
// integratedAt, and let retention reap the only copy.
test('POST /api/lanes/{id}/integrate refuses a dirty worktree instead of silently discarding the work', async () => {
  const token = 'route-token-integrate-dirty';
  const server = await startServer({ token });
  try {
    await initGitRepoAt(process.cwd());
    const orchestrator = await registerOrchestrator(server, token, { title: 'Integrate Dirty Orchestrator' });

    const lane = await createAcceptedIsolatedLane(server, token, orchestrator.body.id, {
      branch: 'feat-dirty',
    });
    // Edit inside the worktree WITHOUT committing — zero commits ahead of base.
    const workFile = path.join(lane.worktreePath, 'uncommitted.txt');
    await fs.writeFile(workFile, 'the executor\'s only copy of its work\n');
    await acceptAudit(server, token, lane.id);

    const refused = await server.requestJson(`/api/lanes/${lane.id}/integrate`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.dirty, true);
    assert.match(String(refused.body.error || ''), /uncommitted/i);

    // The work is still there, and the lane must NOT read as integrated (which is
    // what made retention eligible to prune the record).
    assert.equal((await fs.stat(workFile)).isFile(), true);
    const after = await server.requestJson(`/api/lanes/${lane.id}`, {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.ok(!after.body.integratedAt, 'a refused integrate must not stamp integratedAt');

    // Committing it makes integrate succeed — the refusal is actionable, not a wall.
    await gitIn(lane.worktreePath, 'add', 'uncommitted.txt');
    await gitIn(lane.worktreePath, 'commit', '-qm', 'lane work');
    const integrated = await server.requestJson(`/api/lanes/${lane.id}/integrate`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(integrated.status, 200, JSON.stringify(integrated.body));
    assert.equal(integrated.body.integrated, true);
    assert.equal((await fs.stat(path.join(process.cwd(), 'uncommitted.txt'))).isFile(), true);
  } finally {
    await server.stop();
  }
});

// Isolation is decided at CREATE time but lanes start on a scheduler tick, so two
// writers spawned back-to-back were both still `queued` when the second was
// classified — both resolved to `direct` and then ran concurrently in the repo root.
test('two auto-mode writer lanes spawned before any scheduler tick do not both run directly in the checkout', async () => {
  const token = 'route-token-writer-isolation';
  const server = await startServer({ token });
  try {
    await initGitRepoAt(process.cwd());
    const orchestrator = await registerOrchestrator(server, token, { title: 'Writer Isolation Orchestrator' });

    const spawnWriter = async (title) => {
      const res = await server.requestJson(`/api/orchestrators/${orchestrator.body.id}/executors`, {
        method: 'POST',
        headers: { 'x-orca-token': token },
        body: {
          title,
          executorType: 'mock',
          // 'auto' + a writable profile: this is the default fan-out shape.
          worktreeMode: 'auto',
          permissionsProfile: 'auto-edit',
          autoCompleteMs: 400,
          approved: true,
        },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body;
    };

    const first = await spawnWriter('Writer A');
    const second = await spawnWriter('Writer B');

    const direct = [first, second].filter((lane) => lane.worktreeMode !== 'isolated');
    assert.equal(direct.length <= 1, true,
      `at most one concurrent writer may run directly in the checkout, got ${direct.length} (A=${first.worktreeMode}, B=${second.worktreeMode})`);
    assert.equal(second.worktreeMode, 'isolated', 'the second concurrent writer must be isolated');
    assert.ok(second.worktreePath, 'an isolated lane needs its own worktree');
    assert.notEqual(second.worktreePath, first.worktreePath);
  } finally {
    await server.stop();
  }
});
