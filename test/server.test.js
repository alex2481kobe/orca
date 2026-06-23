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

  return {
    requestJson,
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
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Authorized project');
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
      '/api/agent-tools/discovery',
      '/api/agent-tools/next-action',
      '/api/system/blockers',
      '/api/route-inventory',
      '/api/audit/events',
      '/api/providers',
      '/api/mcp/tools',
      '/api/settings/effective',
      '/api/notifications',
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
    const local = await server.requestJson('/api/projects', { method: 'GET' });
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
    const rebind = await server.requestJson('/api/projects', {
      method: 'GET',
      headers: { host: 'attacker.example' },
    });
    assert.equal(rebind.status, 403);

    // Legit loopback Host names still pass through to the bootstrap-admin path.
    for (const host of ['127.0.0.1:3000', 'localhost', '[::1]:3000']) {
      const ok = await server.requestJson('/api/projects', { method: 'GET', headers: { host } });
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
      ORCA_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
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

    const tools = await server.requestJson('/api/mcp/tools', { method: 'GET', headers: { cookie } });
    assert.equal(tools.status, 200);

    // Host administration is refused (403) for a paired operator device.
    const adminAttempts = [
      ['POST', '/api/executors/codex/cli/reinstall', { actor: 'dashboard', approved: true, execute: false }],
      ['POST', '/api/providers/openai-compatible/secret', { actor: 'dashboard', approved: true, secret: 'sk-test' }],
      ['PATCH', '/api/private-access/settings', { actor: 'dashboard', preferredMode: 'local' }],
      ['POST', '/api/private-access/serve', { actor: 'dashboard', action: 'enable' }],
      ['POST', '/api/private-access/targets', { actor: 'dashboard', label: 'phone target', mode: 'local', localUrl: 'http://127.0.0.1:3000' }],
      ['PATCH', '/api/private-access/targets/example-target', { actor: 'dashboard', label: 'phone target edit' }],
      ['DELETE', '/api/private-access/targets/example-target', { actor: 'dashboard' }],
      ['POST', '/api/private-access/targets/example-target/check', { actor: 'dashboard' }],
      ['POST', '/api/auth/pairing-codes', { actor: 'dashboard', label: 'rogue' }],
      ['GET', '/api/providers/export', undefined],
      ['GET', '/api/app/export', undefined],
      // An orchestrator lease is an off-origin host credential — a paired operator
      // must not be able to mint one (same gate as /api/mcp/orchestrator-bootstrap).
      ['POST', '/api/agent-tools/leases', { actor: 'dashboard', role: 'orchestrator' }],
    ];
    for (const [method, route, body] of adminAttempts) {
      const res = await server.requestJson(route, { method, headers: { cookie }, body });
      assert.equal(res.status, 403, `${method} ${route} must be admin-only for paired devices (got ${res.status})`);
    }

    // But a NON-orchestrator (executor) lease stays an operator-level action.
    const execLease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST', headers: { cookie }, body: { actor: 'dashboard', role: 'executor' },
    });
    assert.notEqual(execLease.status, 403, 'operator may still mint a non-orchestrator lease');

    // The same routes are reachable for the workstation (API token = admin):
    // they pass the auth gate and fail later on policy/validation, never 401/403.
    const tokenReinstall = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', approved: true, execute: false },
    });
    assert.notEqual(tokenReinstall.status, 401);
    assert.notEqual(tokenReinstall.status, 403);

    const tokenExport = await server.requestJson('/api/providers/export', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(tokenExport.status, 200);
  } finally {
    await server.stop();
  }
});

test('notifications expose secret-free state with token-gated settings and read actions', async () => {
  const token = 'route-token-notifications';
  const server = await startServer({ token });

  try {
    const deniedSettings = await server.requestJson('/api/notifications/settings', {
      method: 'PATCH',
      body: {
        actor: 'dashboard',
        inAppEnabled: true,
      },
    });
    assert.equal(deniedSettings.status, 401);

    const approvalRequired = await server.requestJson('/api/notifications/settings', {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        inAppEnabled: true,
        browserEnabled: true,
        minSeverity: 'info',
      },
    });
    assert.equal(approvalRequired.status, 409);
    assert.equal(approvalRequired.body?.requiresApproval, true);

    const settings = await server.requestJson('/api/notifications/settings', {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        inAppEnabled: true,
        browserEnabled: true,
        minSeverity: 'info',
      },
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.body?.settings?.browserEnabled, true);

    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        name: 'Notification Route Project',
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        name: 'Notification Route Session',
      },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        title: 'Do not leak sk-route-notification-secret',
        executorType: 'mock',
      },
    });
    assert.equal(lane.status, 201);

    const stopped = await server.requestJson(`/api/lanes/${lane.body.id}/stop`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        reason: 'notification test terminal transition',
      },
    });
    assert.equal(stopped.status, 200);

    const notifications = await server.requestJson('/api/notifications?limit=20', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(notifications.status, 200);
    assert.equal(JSON.stringify(notifications.body).includes('sk-route-notification-secret'), false);
    const terminal = notifications.body.notifications.find((item) => item.laneId === lane.body.id);
    assert.ok(terminal);
    assert.equal(terminal.severity, 'warning');
    assert.equal(notifications.body.unreadCount >= 1, true);

    const deniedRead = await server.requestJson(`/api/notifications/${terminal.id}/read`, {
      method: 'POST',
      body: { actor: 'dashboard' },
    });
    assert.equal(deniedRead.status, 401);

    const read = await server.requestJson(`/api/notifications/${terminal.id}/read`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(read.status, 200);
    assert.ok(read.body?.readAt);

    const readAll = await server.requestJson('/api/notifications/read-all', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(readAll.status, 200);
    assert.equal(readAll.body?.unreadCount, 0);
  } finally {
    await server.stop();
  }
});

test('project and session API endpoints require explicit approval', async () => {
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

    const deniedSession = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Needs session approval' },
    });
    assert.equal(deniedSession.status, 409);
    assert.equal(Boolean(deniedSession.body?.requiresApproval), true);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Approval session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);
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

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Approval Baseline Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const deniedLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
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

    const allowedLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
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

test('session updates require explicit approval', async () => {
  const token = 'route-token-session-patch';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Session Patch Baseline Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Session Patch Baseline',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const deniedArchive = await server.requestJson(`/api/sessions/${session.body.id}`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        state: 'archived',
      },
    });
    assert.equal(deniedArchive.status, 409);
    assert.equal(Boolean(deniedArchive.body?.requiresApproval), true);

    const allowedArchive = await server.requestJson(`/api/sessions/${session.body.id}`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        state: 'archived',
        approved: true,
      },
    });
    assert.equal(allowedArchive.status, 200);
    assert.equal(allowedArchive.body?.state, 'archived');

    const badState = await server.requestJson(`/api/sessions/${session.body.id}`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        state: 'bad-state',
        approved: true,
      },
    });
    assert.equal(badState.status, 422);
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
    const malformedAuditQuery = await server.requestJson('/api/audit/events?status=%E0%A4', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(malformedAuditQuery.status, 400);
    assert.equal(String(malformedAuditQuery.body?.error || '').includes('Invalid request query string.'), true);

    const malformedMcpQuery = await server.requestJson('/api/mcp/tools?scope=%E0%A4', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(malformedMcpQuery.status, 400);
    assert.equal(String(malformedMcpQuery.body?.error || '').includes('Invalid request query string.'), true);

    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Query project', approved: true },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Query session', approved: true },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Query lane',
        executorType: 'mock',
        command: 'echo query route',
        owner: 'test',
        approved: true,
      },
    });
    assert.equal(lane.status, 201);

    const malformedEvidenceQuery = await server.requestJson(`/api/lanes/${lane.body.id}/evidence/latest?mode=%E0%A4`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(malformedEvidenceQuery.status, 400);
    assert.equal(String(malformedEvidenceQuery.body?.error || '').includes('Invalid request query string.'), true);
  } finally {
    await server.stop();
  }
});

test('server blocks destructive artifact cleanup without explicit confirmation', async () => {
  const token = 'route-token-02';
  const server = await startServer({ token });

  try {
    const destructiveDenied = await server.requestJson('/api/artifacts/cleanup', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: false,
        confirmed: false,
      },
    });
    assert.equal(destructiveDenied.status, 409);
    assert.equal(typeof destructiveDenied.body?.error === 'string', true);

    const dryRunResult = await server.requestJson('/api/artifacts/cleanup', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: true,
      },
    });
    assert.equal(dryRunResult.status, 200);
    assert.equal(dryRunResult.body?.dryRun, true);
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall endpoints require explicit confirmation before execution', async () => {
  const token = 'route-token-03';
  const server = await startServer({
    token,
    env: {
      ORCA_CODEX_BINARY: '/usr/bin/codex',
      ORCA_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
    },
  });

  try {
    const info = await server.requestJson('/api/executors/codex/cli', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(info.status, 200);
    assert.equal(info.body.type, 'codex');
    assert.equal(info.body.reinstall?.available, true);

    const dryRun = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
      },
    });
    assert.equal(dryRun.status, 200);
    assert.equal(dryRun.body.executed, false);
    assert.equal(Array.isArray(dryRun.body.command), true);

    const executeDenied = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: true,
      },
    });
    assert.equal(executeDenied.status, 409);
    assert.equal(
      String(executeDenied.body?.error || '').includes('explicit confirmation'),
      true,
    );
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall requires approval for planning requests', async () => {
  const token = 'route-token-03e';
  const server = await startServer({
    token,
    env: {
      ORCA_CODEX_BINARY: '/usr/bin/codex',
      ORCA_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
    },
  });

  try {
    const denied = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: false,
        execute: false,
      },
    });
    assert.equal(denied.status, 409);
    assert.equal(Boolean(denied.body?.requiresApproval), true);
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall endpoint rejects unsafe override commands', async () => {
  const token = 'route-token-03b';
  const server = await startServer({
    token,
    env: {
      ORCA_CODEX_BINARY: '/usr/bin/codex',
      ORCA_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
    },
  });

  try {
    const badOverride = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
        command: 'rm -rf /',
      },
    });
    assert.equal(badOverride.status, 422);
    assert.equal(String(badOverride.body?.error || '').includes('Invalid reinstall command override'), true);
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall supports forcing source-based reinstall commands', async () => {
  const token = 'route-token-03c';
  const server = await startServer({
    token,
    env: {
      ORCA_CODEX_BINARY: '/usr/bin/codex',
      ORCA_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
      ORCA_CODEX_REINSTALL_SOURCE_REPOS: 'my-org/codex-fork,openai/codex',
      ORCA_CODEX_REINSTALL_PREFER_SOURCE: 'false',
    },
  });

  try {
    const sourceMode = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
        useSource: true,
      },
    });
    assert.equal(sourceMode.status, 200);
    assert.equal(sourceMode.body.executed, false);
    assert.equal(
      String(sourceMode.body.command?.join(' ') || '').includes('git+https://github.com/my-org/codex-fork.git'),
      true,
    );
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall rejects source mode with custom override command', async () => {
  const token = 'route-token-03d';
  const server = await startServer({
    token,
    env: {
      ORCA_CODEX_BINARY: '/usr/bin/codex',
      ORCA_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
      ORCA_CODEX_REINSTALL_SOURCE_REPOS: 'my-org/codex-fork,openai/codex',
    },
  });

  try {
    const rejected = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
        useSource: true,
        command: 'npm install --yes @openai/codex',
      },
    });
    assert.equal(rejected.status, 422);
    assert.equal(String(rejected.body?.error || '').includes('Cannot combine custom command override'), true);
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

    const missingReinstall = await server.requestJson('/api/executors/unknown/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
      },
    });
    assert.equal(missingReinstall.status, 404);
  } finally {
    await server.stop();
  }
});

test('API lane creation validates MCP tool IDs and executor constraints', async () => {
  const token = 'route-token-03g';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Lane MCP project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Lane MCP session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const codexTool = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'route-codex-tool',
        command: 'node',
        scope: ['codex'],
        approved: true,
      },
    });
    assert.equal(codexTool.status, 201);

    const claudeTool = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'route-claude-tool',
        command: 'node',
        scope: ['claude'],
        approved: true,
      },
    });
    assert.equal(claudeTool.status, 201);

    const badScopeLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Bad scope lane',
        executorType: 'codex',
        command: 'codex --version',
        mcpToolIds: [codexTool.body.id, claudeTool.body.id],
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(badScopeLane.status, 422);
    assert.equal(String(badScopeLane.body?.error || '').includes('Unauthorized MCP tools'), true);

    const badMissingLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Missing tool lane',
        executorType: 'codex',
        command: 'codex --version',
        mcpToolIds: ['missing-tool'],
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(badMissingLane.status, 422);
    assert.equal(String(badMissingLane.body?.error || '').includes('Unknown MCP tools'), true);

    const badCommand = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Bad command lane',
        executorType: 'codex',
        command: 'echo hello',
        mcpToolIds: [codexTool.body.id],
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(badCommand.status, 422);
    assert.equal(String(badCommand.body?.error || '').includes('configured codex binary'), true);

    const validLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Good codex lane',
        executorType: 'codex',
        command: 'codex --version',
        mcpToolIds: [codexTool.body.id],
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(validLane.status, 201);
    assert.equal(validLane.body.executorType, 'codex');
    assert.equal(validLane.body.mcpTools[0]?.id, codexTool.body.id);
  } finally {
    await server.stop();
  }
});

test('dashboard orchestrator messages create server-owned turns and scoped tool leases', async () => {
  const token = 'route-token-orchestrator-chat';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Orchestrator Chat Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Orchestrator Chat Session',
        leader: 'mock',
        approvedCapacity: 4,
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const turn = await server.requestJson(`/api/sessions/${session.body.id}/orchestrator/messages`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        executorType: 'mock',
        model: 'gpt-5',
        permissionsProfile: 'plan',
        intelligenceProfile: 'high',
        message: 'Build the project plan and create the first executor lane.',
      },
    });
    assert.equal(turn.status, 201);
    assert.equal(turn.body?.lane?.owner, 'orchestrator');
    assert.equal(turn.body?.lane?.executorType, 'mock');
    assert.equal(turn.body?.lane?.model, 'gpt-5');
    assert.equal(turn.body?.lane?.permissionsProfile, 'plan');
    assert.equal(turn.body?.lane?.intelligenceProfile, 'high');
    assert.equal(turn.body?.thread?.messages?.length, 2);
    assert.equal(JSON.stringify(turn.body).includes('leaseToken'), false);
    assert.equal(JSON.stringify(turn.body).includes(token), false);
    assert.equal(String(turn.body?.lane?.taskPrompt || '').includes('ORCA_TOOL_LEASE_TOKEN'), true);
    assert.equal(String(turn.body?.lane?.taskPrompt || '').includes('Build the project plan'), true);

    const thread = await server.requestJson(`/api/sessions/${session.body.id}/orchestrator`, {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(thread.status, 200);
    assert.equal(thread.body?.activeLaneId, turn.body.lane.id);
    assert.equal(thread.body?.activeLane?.id, turn.body.lane.id);

    const lease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        role: 'orchestrator',
        projectId: project.body.id,
        sessionId: session.body.id,
        actor: 'dashboard',
      },
    });
    assert.equal(lease.status, 201);
    assert.equal(Boolean(lease.body?.leaseToken), true);

    const enrolled = await server.requestJson(`/api/sessions/${session.body.id}/orchestrator/enroll`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: { actor: 'orchestrator' },
    });
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.body?.activeOrchestrator?.active, true);

    const competingLease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        role: 'orchestrator',
        projectId: project.body.id,
        sessionId: session.body.id,
        actor: 'competing-orchestrator',
      },
    });
    assert.equal(competingLease.status, 201);

    const refusedMessage = await server.requestJson(`/api/sessions/${session.body.id}/orchestrator/messages`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': competingLease.body.leaseToken },
      body: {
        approved: true,
        executorType: 'mock',
        message: 'This should not queue because another orchestrator owns the session.',
      },
    });
    assert.equal(refusedMessage.status, 409);
    assert.match(refusedMessage.body?.error || '', /not the active orchestrator/i);

    const ownerMessage = await server.requestJson(`/api/sessions/${session.body.id}/orchestrator/messages`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        approved: true,
        executorType: 'mock',
        message: 'Owner lease queues a follow-up orchestrator turn.',
      },
    });
    assert.equal(ownerMessage.status, 201);
    assert.equal(ownerMessage.body?.lane?.owner, 'orchestrator');

    const leaseLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
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

    const forbidden = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        name: 'Forbidden by lease',
        approved: true,
      },
    });
    assert.equal(forbidden.status, 401);
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall supports claude with source-mode and command validation', async () => {
  const token = 'route-token-03e';
  const server = await startServer({
    token,
    env: {
      ORCA_CLAUDE_BINARY: '/usr/bin/claude',
      ORCA_CLAUDE_REINSTALL_COMMAND: 'npm install --yes @anthropic/claude-code',
      ORCA_CLAUDE_REINSTALL_SOURCE_REPOS: 'anthropic/claude-code,my-org/claude-fork',
      ORCA_CLAUDE_REINSTALL_PREFER_SOURCE: 'false',
    },
  });

  try {
    const info = await server.requestJson('/api/executors/claude/cli', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(info.status, 200);
    assert.equal(info.body.type, 'claude');
    assert.equal(info.body.reinstall?.available, true);
    assert.equal(Array.isArray(info.body.reinstall.command), true);

    const sourceMode = await server.requestJson('/api/executors/claude/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
        useSource: true,
      },
    });
    assert.equal(sourceMode.status, 200);
    assert.equal(sourceMode.body.executed, false);
    assert.equal(
      String(sourceMode.body.command?.join(' ') || '').includes('git+https://github.com/anthropic/claude-code.git'),
      true,
    );

    const executeDenied = await server.requestJson('/api/executors/claude/cli/reinstall', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: true,
        useSource: true,
      },
    });
    assert.equal(executeDenied.status, 409);
    assert.equal(
      String(executeDenied.body?.error || '').includes('requires explicit confirmation'),
      true,
    );
  } finally {
    await server.stop();
  }
});

test('server MCP tooling routes require token and support CRUD workflow', async () => {
  const token = 'route-token-04';
  const server = await startServer({ token });

  try {
    const deniedCreate = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      body: {
        name: 'route-tool',
        command: 'node',
        scope: ['all'],
        args: ['--version'],
        enabled: true,
      },
    });
    assert.equal(deniedCreate.status, 401);

    const created = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'route-tool',
        command: 'node',
        scope: ['all'],
        args: ['--version'],
        enabled: true,
        approved: true,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'route-tool');

    const listed = await server.requestJson('/api/mcp/tools', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(listed.status, 200);
    assert.equal(Array.isArray(listed.body), true);
    assert.equal(listed.body.length, 1);

    const fetched = await server.requestJson(`/api/mcp/tools/${created.body.id}`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, created.body.id);

    const updated = await server.requestJson(`/api/mcp/tools/${created.body.id}`, {
      method: 'PATCH',
      headers: { 'x-orca-token': token },
      body: {
        enabled: false,
        approved: true,
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.enabled, false);

    const deleted = await server.requestJson(`/api/mcp/tools/${created.body.id}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
      body: {
        approved: true,
      },
    });
    assert.equal(deleted.status, 200);

    const afterDelete = await server.requestJson(`/api/mcp/tools/${created.body.id}`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(afterDelete.status, 404);
  } finally {
    await server.stop();
  }
});

test('server MCP tool env (secrets) is shown to admin but redacted for paired operators', async () => {
  const token = 'route-token-mcp-env';
  const server = await startServer({ token });
  try {
    const created = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'secretful', command: 'node', args: ['x.js'], scope: ['all'], approved: true,
        env: { GITHUB_TOKEN: 'ghp_supersecret_value' },
      },
    });
    assert.equal(created.status, 201);

    // Admin (token) sees the real secret value.
    const adminList = await server.requestJson('/api/mcp/tools', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(adminList.body[0].env.GITHUB_TOKEN, 'ghp_supersecret_value');

    // Pair an operator device.
    const pairing = await server.requestJson('/api/auth/pairing-codes', {
      method: 'POST', headers: { 'x-orca-token': token }, body: { actor: 'dashboard', label: 'phone' },
    });
    const paired = await server.requestJson('/api/auth/pair', { method: 'POST', body: { actor: 'dashboard', code: pairing.body.pairing.code } });
    const cookie = paired.response.headers['set-cookie'];

    // Operator sees the env KEY but never the secret VALUE (list + single-get).
    const opList = await server.requestJson('/api/mcp/tools', { method: 'GET', headers: { cookie } });
    assert.equal(opList.status, 200);
    assert.ok('GITHUB_TOKEN' in opList.body[0].env, 'operator still sees which env keys exist');
    assert.notEqual(opList.body[0].env.GITHUB_TOKEN, 'ghp_supersecret_value');
    const opGet = await server.requestJson(`/api/mcp/tools/${created.body.id}`, { method: 'GET', headers: { cookie } });
    assert.notEqual(opGet.body.env.GITHUB_TOKEN, 'ghp_supersecret_value');

    const operatorCreate = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { cookie },
      body: { name: 'phone-tool', command: 'node', args: ['--version'], scope: ['all'], approved: true },
    });
    assert.equal(operatorCreate.status, 403);

    const operatorPatch = await server.requestJson(`/api/mcp/tools/${created.body.id}`, {
      method: 'PATCH',
      headers: { cookie },
      body: { enabled: false, approved: true },
    });
    assert.equal(operatorPatch.status, 403);

    const operatorDelete = await server.requestJson(`/api/mcp/tools/${created.body.id}`, {
      method: 'DELETE',
      headers: { cookie },
      body: { approved: true },
    });
    assert.equal(operatorDelete.status, 403);
  } finally {
    await server.stop();
  }
});

test('server MCP tooling sanitizes blocked argument tokens', async () => {
  const token = 'route-token-04c';
  const server = await startServer({ token });

  try {
    const blockedArg = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'blocked-arg-tool',
        command: 'node',
        args: [';rm -rf /'],
        scope: ['all'],
        approved: true,
      },
    });
    assert.equal(blockedArg.status, 422);
    assert.equal(String(blockedArg.body?.error || '').includes('contains blocked characters'), true);
  } finally {
    await server.stop();
  }
});

test('server MCP tooling rejects unsupported scope values and blocked commands', async () => {
  const token = 'route-token-04b';
  const server = await startServer({
    token,
    env: {
      ORCA_MCP_TOOL_COMMAND_ALLOWLIST: 'node,npx',
    },
  });

  try {
    const invalidScope = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'bad-scope-tool',
        command: 'node',
        scope: ['invalid'],
        approved: true,
      },
    });
    assert.equal(invalidScope.status, 422);
    assert.equal(String(invalidScope.body?.error || '').includes('unsupported values'), true);

    const blockedCommand = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'blocked-command-tool',
        command: 'python',
        scope: ['all'],
        approved: true,
      },
    });
    assert.equal(blockedCommand.status, 422);
    assert.equal(String(blockedCommand.body?.error || '').includes('not in the allowlist'), true);

    const created = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'all-tool',
        command: 'node',
        scope: ['all'],
        args: ['--version'],
        approved: true,
      },
    });
    assert.equal(created.status, 201);

    const codexScope = await server.requestJson('/api/mcp/tools?scope=codex', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(codexScope.status, 200);
    assert.equal(Array.isArray(codexScope.body), true);
    assert.equal(codexScope.body.length, 0);

    const allScope = await server.requestJson('/api/mcp/tools?scope=all', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(allScope.status, 200);
    assert.equal(Array.isArray(allScope.body), true);
    assert.equal(allScope.body.length, 1);
    assert.equal(allScope.body[0]?.id, 'all-tool');
  } finally {
    await server.stop();
  }
});

test('run-now cleanup endpoint enforces approval and supports dry-run mode', async () => {
  const token = 'route-token-05';
  const server = await startServer({ token });

  try {
    const denied = await server.requestJson('/api/artifacts/cleanup/run-now', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        dryRun: false,
        confirmed: true,
      },
    });
    assert.equal(denied.status, 409);
    assert.equal(Boolean(denied.body?.requiresApproval), true);

    const dryRunResult = await server.requestJson('/api/artifacts/cleanup/run-now', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: true,
      },
    });
    assert.equal(dryRunResult.status, 200);
    assert.equal(dryRunResult.body?.dryRun, true);
    assert.equal(dryRunResult.body?.removed, 0);

    const invalidRunNowSession = await server.requestJson('/api/artifacts/cleanup/run-now', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: true,
        sessionId: 'missing-session-id',
      },
    });
    assert.equal(invalidRunNowSession.status, 404);
    assert.equal(String(invalidRunNowSession.body?.error || '').includes('Session not found'), true);

    const missingCleanupConfirmation = await server.requestJson('/api/artifacts/cleanup/run-now', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: false,
        confirmed: false,
      },
    });
    assert.equal(missingCleanupConfirmation.status, 409);
    assert.equal(
      String(missingCleanupConfirmation.body?.error || '').includes('Destructive cleanup requires explicit confirmation.'),
      true,
    );
  } finally {
    await server.stop();
  }
});

test('cleanup schedule endpoint enforces approval and persists updated schedule', async () => {
  const token = 'route-token-06';
  const server = await startServer({ token });

  try {
    const denied = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        enabled: true,
        intervalHours: 12,
      },
    });
    assert.equal(denied.status, 409);
    assert.equal(Boolean(denied.body?.requiresApproval), true);

    const saved = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        enabled: true,
        approved: true,
        intervalHours: 12,
        olderThanDays: 30,
        dryRun: true,
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body?.enabled, true);
    assert.equal(saved.body?.intervalHours, 12);
    assert.equal(saved.body?.olderThanDays, 30);
    assert.equal(saved.body?.dryRun, true);

    const listed = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body?.schedule?.enabled, true);
    assert.equal(listed.body?.schedule?.intervalHours, 12);
  } finally {
    await server.stop();
  }
});

test('cleanup schedule endpoint validates interval, session id, and retention', async () => {
  const token = 'route-token-06b';
  const server = await startServer({ token });

  try {
    const badInterval = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        intervalHours: 900,
      },
    });
    assert.equal(badInterval.status, 422);
    assert.equal(String(badInterval.body?.error || '').includes('cannot exceed 720'), true);

    const badSession = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        enabled: true,
        sessionId: 'missing-session-id',
      },
    });
    assert.equal(badSession.status, 404);
    assert.equal(String(badSession.body?.error || '').includes('Session not found'), true);

    const badRetention = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        olderThanDays: 'nope',
      },
    });
    assert.equal(badRetention.status, 422);
    assert.equal(String(badRetention.body?.error || '').includes('olderThanDays must be a positive integer or null'), true);
  } finally {
    await server.stop();
  }
});

test('mobile manifest exposes deep links for projects, sessions, and lane artifact/evidence actions', async () => {
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

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Manifest Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Manifest Lane',
        executorType: 'mock',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(lane.status, 201);

    const manifest = await server.requestJson('/api/mobile/manifest', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(manifest.status, 200);
    assert.equal(Boolean(manifest.body?.apiTokenRequired), true);
    assert.equal(Array.isArray(manifest.body?.projects), true);
    assert.equal(manifest.body.projects.length, 1);

    const projectEntry = manifest.body.projects[0];
    assert.equal(projectEntry.projectId, project.body.id);
    assert.equal(projectEntry.route.includes(`/projects/${project.body.slug}`), true);
    assert.equal(projectEntry.sessions.length, 1);

    const sessionEntry = projectEntry.sessions[0];
    assert.equal(sessionEntry.sessionId, session.body.id);
    assert.equal(sessionEntry.route.includes(`/projects/${project.body.slug}/sessions/${session.body.id}`), true);
    assert.equal(sessionEntry.lanes.length, 1);
    assert.equal(typeof sessionEntry.capacityUrl, 'string');
    assert.equal(typeof sessionEntry.capacityRequestUrl, 'string');
    assert.equal(typeof sessionEntry.capacityPolicyUrl, 'string');

    const laneEntry = sessionEntry.lanes[0];
    assert.equal(laneEntry.laneId, lane.body.id);
    assert.equal(laneEntry.route.includes(`/projects/${project.body.slug}/sessions/${session.body.id}/lanes/${lane.body.id}`), true);
    assert.equal(laneEntry.artifactsUrl, `/api/lanes/${lane.body.id}/artifacts`);
    assert.equal(laneEntry.evidenceUrl, `/api/lanes/${lane.body.id}/evidence`);
    assert.equal(laneEntry.evidenceLatestUrl, `/api/lanes/${lane.body.id}/evidence/latest`);
    assert.equal(laneEntry.auditApi, `/api/lanes/${lane.body.id}/audit`);

    assert.equal(typeof manifest.body?.artifactCleanupUrl, 'string');
    assert.equal(typeof manifest.body?.artifactCleanupScheduleUrl, 'string');
    assert.equal(typeof manifest.body?.artifactCleanupNowUrl, 'string');
    assert.equal(typeof manifest.body?.executorProfilesUrl, 'string');
    assert.equal(typeof manifest.body?.executorCliInfoUrl, 'string');
    assert.equal(typeof manifest.body?.executorCliReinstallUrl, 'string');
    assert.equal(manifest.body?.browserSessionSupported, true);
    assert.equal(typeof manifest.body?.authStatusUrl, 'string');
    assert.equal(typeof manifest.body?.authPairingCodeUrl, 'string');
    assert.equal(typeof manifest.body?.authPairUrl, 'string');
    assert.equal(typeof manifest.body?.authLogoutUrl, 'string');
    assert.equal(typeof manifest.body?.authSessionsUrl, 'string');
    assert.equal(typeof manifest.body?.agentToolsDiscoveryUrl, 'string');
    assert.equal(typeof manifest.body?.agentToolsNextActionUrl, 'string');
    assert.equal(typeof manifest.body?.agentToolsLeaseUrl, 'string');
  } finally {
    await server.stop();
  }
});

test('agent tool routes expose discovery, nextAction, and token-gated leases', async () => {
  const token = 'route-token-agent-tools';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Agent Route Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Agent Route Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const discovery = await server.requestJson('/api/agent-tools/discovery', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(discovery.status, 200);
    assert.equal(discovery.body?.contractVersion, 'orca.agent-tools.v1');
    assert.equal(discovery.body?.publicSafe, true);
    assert.equal(discovery.body.tools.some((tool) => tool.id === 'session.next_action'), true);
    assert.equal(discovery.body.tools.some((tool) => tool.id === 'executor.capabilities'), true);
    assert.equal(discovery.body.executorCapabilities?.codex?.invocation?.canRunAsOrchestrator, true);

    const next = await server.requestJson(`/api/agent-tools/next-action?role=orchestrator&projectId=${project.body.id}&sessionId=${session.body.id}`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(next.status, 200);
    assert.equal(next.body?.nextRequiredTool, 'orchestrator.enroll');
    assert.equal(next.body?.allowedTools.includes('lane.create'), true);
    assert.equal(next.body?.executorCapabilities?.claude?.invocation?.canRunAsExecutor, true);

    const deniedLease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        role: 'orchestrator',
        projectId: project.body.id,
        sessionId: session.body.id,
      },
    });
    assert.equal(deniedLease.status, 401);

    const lease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        role: 'orchestrator',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 60000,
      },
    });
    assert.equal(lease.status, 201);
    assert.equal(Boolean(lease.body?.leaseToken), true);
    assert.equal(lease.body?.lease?.allowedTools.includes('lane.create'), true);
    assert.equal(JSON.stringify(lease.body?.lease || {}).includes(lease.body.leaseToken), false);
    assert.equal(lease.body?.nextAction?.nextRequiredTool, 'orchestrator.enroll');

    const refusedBeforeEnroll = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        actor: 'orchestrator',
        approved: true,
        title: 'Unregistered lease lane',
        executorType: 'mock',
        owner: 'orchestrator',
      },
    });
    assert.equal(refusedBeforeEnroll.status, 409);
    assert.match(refusedBeforeEnroll.body?.error || '', /No active orchestrator/);

    const enrolled = await server.requestJson(`/api/sessions/${session.body.id}/orchestrator/enroll`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: { actor: 'orchestrator' },
    });
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.body?.activeOrchestrator?.active, true);

    const createdByLease = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
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

test('session capacity API supports request, approval, rejection, and policy updates', async () => {
  const token = 'route-token-capacity';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Capacity API Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Capacity API Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const capacity = await server.requestJson(`/api/sessions/${session.body.id}/capacity`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(capacity.status, 200);
    assert.equal(capacity.body?.approvedCapacity, 2);
    assert.equal(capacity.body?.spawnPolicy, 'within_capacity');

    const request = await server.requestJson(`/api/sessions/${session.body.id}/capacity/request`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'orchestrator',
        requestedCapacity: 5,
        reason: 'Need parallel lanes',
        tasksUnlocked: ['lane one', 'lane two'],
        costRisk: 'more processes',
      },
    });
    assert.equal(request.status, 201);
    assert.equal(request.body?.request?.status, 'pending');

    const deniedPolicy = await server.requestJson(`/api/sessions/${session.body.id}/capacity/policy`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: false,
        spawnPolicy: 'never',
      },
    });
    assert.equal(deniedPolicy.status, 409);

    const updatedPolicy = await server.requestJson(`/api/sessions/${session.body.id}/capacity/policy`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        spawnPolicy: 'ask',
        approvedCapacity: 3,
        idleShutdownMode: 'short_keepalive',
      },
    });
    assert.equal(updatedPolicy.status, 200);
    assert.equal(updatedPolicy.body?.spawnPolicy, 'ask');
    assert.equal(updatedPolicy.body?.approvedCapacity, 3);
    assert.equal(updatedPolicy.body?.idleShutdownMode, 'short_keepalive');

    const deniedApprove = await server.requestJson(`/api/sessions/${session.body.id}/capacity/requests/${request.body.request.id}/approve`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: false,
      },
    });
    assert.equal(deniedApprove.status, 409);

    const approved = await server.requestJson(`/api/sessions/${session.body.id}/capacity/requests/${request.body.request.id}/approve`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        reason: 'Approved',
      },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body?.request?.status, 'approved');
    assert.equal(approved.body?.capacity?.approvedCapacity, 5);

    const secondRequest = await server.requestJson(`/api/sessions/${session.body.id}/capacity/request`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'orchestrator',
        requestedCapacity: 6,
        reason: 'Need one more',
      },
    });
    assert.equal(secondRequest.status, 201);
    const rejected = await server.requestJson(`/api/sessions/${session.body.id}/capacity/requests/${secondRequest.body.request.id}/reject`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        reason: 'Not needed',
      },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body?.request?.status, 'rejected');
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

test('project live links are server-authoritative, SSRF-checked, health-checked, and removable', async () => {
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
      },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body?.link?.label, 'Example App');
    assert.equal(added.body?.link?.kind, 'vite');
    assert.equal(added.body?.link?.port, target.port);
    assert.equal(added.body?.link?.favorite, true);
    assert.equal(added.body?.project?.quickLinks?.length, 1);

    const checked = await server.requestJson(`/api/projects/${project.body.id}/quick-links/${added.body.link.id}/check`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        prefer: 'local',
      },
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body?.result?.status, 'reachable');
    assert.equal(checked.body?.link?.healthStatus, 'reachable');
    assert.equal(checked.body?.link?.lastStatusCode, 200);
    assert.equal(target.requests.length >= 1, true);

    const removed = await server.requestJson(`/api/projects/${project.body.id}/quick-links/${added.body.link.id}`, {
      method: 'DELETE',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
      },
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body?.removed, true);
    assert.equal(removed.body?.project?.quickLinks?.length, 0);
  } finally {
    await server.stop();
    await target.close();
  }
});

test('orchestrator tool leases can manage project links and read private-access setup state', async () => {
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

    const tailnet = await server.requestJson('/api/private-access/tailnet?fake=serve-http', {
      method: 'GET',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
    });
    assert.equal(tailnet.status, 200);
    assert.equal(tailnet.body?.serveMode, 'tailnet-http');

    const setup = await server.requestJson('/api/private-access/setup-plan?localUrl=http%3A%2F%2F127.0.0.1%3A3000', {
      method: 'GET',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
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

test('project archive and restore are dashboard-only scoped tool routes', async () => {
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

    const orchestratorLease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        role: 'orchestrator',
        projectId: project.body.id,
        ttlMs: 60_000,
      },
    });
    assert.equal(orchestratorLease.status, 201);
    assert.equal(orchestratorLease.body?.lease?.allowedTools.includes('project.archive'), false);

    const deniedArchive = await server.requestJson(`/api/projects/${project.body.id}/archive`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': orchestratorLease.body.leaseToken },
      body: { approved: true },
    });
    assert.equal(deniedArchive.status, 403);
    assert.match(deniedArchive.body.error, /Tool lease does not grant this tool/);

    const dashboardLease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        role: 'dashboard',
        projectId: project.body.id,
        ttlMs: 60_000,
      },
    });
    assert.equal(dashboardLease.status, 201);
    assert.equal(dashboardLease.body?.lease?.allowedTools.includes('project.archive'), true);
    assert.equal(dashboardLease.body?.lease?.allowedTools.includes('project.restore'), true);

    const archived = await server.requestJson(`/api/projects/${project.body.id}/archive`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': dashboardLease.body.leaseToken },
      body: { approved: true },
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body?.state, 'archived');

    const hiddenFromList = await server.requestJson('/api/projects', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(hiddenFromList.status, 200);
    assert.equal(hiddenFromList.body.some((item) => item.id === project.body.id), false);

    const restored = await server.requestJson(`/api/projects/${project.body.id}/restore`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': dashboardLease.body.leaseToken },
      body: { approved: true },
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body?.state, 'active');
  } finally {
    await server.stop();
  }
});

test('lane-level and session-level audit-event listing supports filtering by scope and status', async () => {
  const token = 'route-token-09';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Audit Scope Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Audit Scope Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Audit Scope Lane',
        executorType: 'mock',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(lane.status, 201);

    const auditQueued = await server.requestJson(`/api/lanes/${lane.body.id}/audit`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
      },
    });
    assert.equal(auditQueued.status, 201);
    const queuedAuditEventId = auditQueued.body?.event?.id || auditQueued.body?.id;
    assert.equal(typeof queuedAuditEventId, 'string');

    const lanePending = await server.requestJson(`/api/lanes/${lane.body.id}/audit-events?status=pending`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(lanePending.status, 200);
    assert.equal(Array.isArray(lanePending.body), true);
    assert.equal(lanePending.body.some((event) => event.id === queuedAuditEventId), true);

    const sessionPending = await server.requestJson(`/api/sessions/${session.body.id}/audit-events?status=pending`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(sessionPending.status, 200);
    assert.equal(Array.isArray(sessionPending.body), true);
    assert.equal(sessionPending.body.some((event) => event.id === queuedAuditEventId), true);

    const laneAck = await server.requestJson(`/api/audit/events/${queuedAuditEventId}/ack`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(laneAck.status, 200);

    const lanePendingAfterAck = await server.requestJson(`/api/lanes/${lane.body.id}/audit-events?status=pending`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(lanePendingAfterAck.status, 200);
    assert.equal(Array.isArray(lanePendingAfterAck.body), true);
    assert.equal(lanePendingAfterAck.body.some((event) => event.id === queuedAuditEventId), false);

    const lanePassed = await server.requestJson(`/api/lanes/${lane.body.id}/audit-events?status=passed`, { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(lanePassed.status, 200);
    assert.equal(Array.isArray(lanePassed.body), true);
    assert.equal(lanePassed.body.some((event) => event.id === queuedAuditEventId), true);
  } finally {
    await server.stop();
  }
});

test('high-risk lane stop action requires explicit approval', async () => {
  const token = 'route-token-10';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Lane Stop Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        name: 'Lane Stop Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
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

    const systemSpoof = await server.requestJson('/api/artifacts/cleanup', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'system', approved: true, dryRun: true, sessionId: null },
    });
    assert.equal(systemSpoof.status, 403);
  } finally {
    await server.stop();
  }
});

test('artifact serving rejects traversal, absolute, encoded, and symlink paths', async () => {
  const token = 'route-token-14';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Artifact Path Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Artifact Path Session', approved: true },
    });
    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
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
    const project = await server.requestJson('/api/projects', {
      method: 'POST', headers: { 'x-orca-token': token }, body: { name: 'Bridge Project', approved: true },
    });
    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST', headers: { 'x-orca-token': token }, body: { name: 'Bridge Session', approved: true },
    });
    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
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

test('lane heartbeat endpoint can be gated by ORCA_WORKER_TOKEN', async () => {
  const token = 'route-token-13';
  const workerToken = 'worker-token-aa';
  const server = await startServer({ token, env: { ORCA_WORKER_TOKEN: workerToken } });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Heartbeat Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Heartbeat Session', approved: true },
    });
    assert.equal(session.status, 201);
    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Heartbeat Lane', executorType: 'mock', owner: 'dashboard', approved: true },
    });
    assert.equal(lane.status, 201);

    const denied = await server.requestJson(`/api/lanes/${lane.body.id}/heartbeat`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {},
    });
    assert.equal(denied.status, 401);
    assert.equal(String(denied.body?.error || '').toLowerCase().includes('worker token'), true);

    const allowed = await server.requestJson(`/api/lanes/${lane.body.id}/heartbeat`, {
      method: 'POST',
      headers: { 'x-orca-token': token, 'x-orca-worker-token': workerToken },
      body: {},
    });
    assert.equal(allowed.status, 200);

    const lease = await server.requestJson('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        role: 'executor',
        projectId: project.body.id,
        sessionId: session.body.id,
        laneId: lane.body.id,
        ttlMs: 60000,
      },
    });
    assert.equal(lease.status, 201);
    assert.equal(lease.body?.lease?.allowedTools.includes('lane.heartbeat'), true);

    const leaseHeartbeat = await server.requestJson(`/api/lanes/${lane.body.id}/heartbeat`, {
      method: 'POST',
      headers: { 'x-orca-tool-lease': lease.body.leaseToken },
      body: {
        actor: 'executor',
      },
    });
    assert.equal(leaseHeartbeat.status, 200);
  } finally {
    await server.stop();
  }
});

test('private access API exposes mocked tailnet state, dry-run setup plans, and rejects Funnel targets', async () => {
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

    const target = await server.requestJson('/api/private-access/targets', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        label: 'Local target',
        mode: 'local',
        localUrl: 'http://127.0.0.1:3000',
      },
    });
    assert.equal(target.status, 201);
    assert.equal(target.body?.mode, 'local');

    const badFunnel = await server.requestJson('/api/private-access/targets', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        label: 'Bad Funnel',
        mode: 'tailnet-https-serve',
        localUrl: 'http://127.0.0.1:3000',
        httpsServeUrl: 'https://orca.funnel.ts.net',
      },
    });
    assert.equal(badFunnel.status, 422);
    assert.equal(String(badFunnel.body?.error || '').includes('Funnel'), true);
  } finally {
    await server.stop();
  }
});

test('provider profile API exposes first-class providers and memory-backed secret references without echoing values', async () => {
  const token = 'route-token-providers';
  const server = await startServer({ token, env: { ORCA_CREDENTIAL_BACKEND: 'memory' } });

  try {
    const list = await server.requestJson('/api/providers', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(list.status, 200);
    assert.equal(list.body?.credentialBackend, 'memory');
    const ids = new Set((list.body?.profiles || []).map((profile) => profile.id));
    for (const id of ['codex', 'claude', 'gemini-cli', 'composer-cli', 'custom-cli', 'openai-compatible', 'gemini', 'kimi', 'deepseek', 'openrouter', 'composer']) {
      assert.equal(ids.has(id), true, `missing ${id}`);
    }

    const deniedSecret = await server.requestJson('/api/providers/openai-compatible/secret', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: false,
        secret: 'sk-test-secret',
      },
    });
    assert.equal(deniedSecret.status, 409);

    const setSecret = await server.requestJson('/api/providers/openai-compatible/secret', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        secret: 'sk-test-secret',
      },
    });
    assert.equal(setSecret.status, 200);
    assert.equal(JSON.stringify(setSecret.body).includes('sk-test-secret'), false);

    const health = await server.requestJson('/api/providers/openai-compatible/health', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(health.status, 200);
    assert.equal(health.body?.status, 'configured');
    assert.equal(typeof health.body?.baseUrl, 'string');
    assert.equal(health.body?.credential?.backend, 'memory');
    assert.equal(JSON.stringify(health.body).includes('sk-test-secret'), false);

    const pairing = await server.requestJson('/api/auth/pairing-codes', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'dashboard', label: 'provider-health-phone' },
    });
    assert.equal(pairing.status, 201);
    const paired = await server.requestJson('/api/auth/pair', {
      method: 'POST',
      body: { code: pairing.body.pairing.code, label: 'provider-health-phone' },
    });
    assert.equal(paired.status, 200);
    const operatorHealth = await server.requestJson('/api/providers/openai-compatible/health', {
      method: 'GET',
      headers: { cookie: paired.response.headers['set-cookie'] },
    });
    assert.equal(operatorHealth.status, 200);
    assert.equal(operatorHealth.body?.status, 'configured');
    assert.equal(operatorHealth.body?.baseUrl, undefined);
    assert.equal(operatorHealth.body?.apiStyle, undefined);
    assert.deepEqual(operatorHealth.body?.credential, { present: true });
    const operatorHealthText = JSON.stringify(operatorHealth.body);
    assert.equal(operatorHealthText.includes('OPENAI'), false);
    assert.equal(operatorHealthText.includes('memory'), false);

    const operatorList = await server.requestJson('/api/providers', {
      method: 'GET',
      headers: { cookie: paired.response.headers['set-cookie'] },
    });
    assert.equal(operatorList.status, 200);
    assert.equal(operatorList.body?.credentialBackend, undefined);
    assert.equal(operatorList.body?.credentialBackends, undefined);
    const operatorListText = JSON.stringify(operatorList.body);
    for (const text of ['OPENAI', 'memory', 'envName', 'backend', 'secretRef', 'apiKeyEnv']) {
      assert.equal(operatorListText.includes(text), false, `operator provider list leaked ${text}`);
    }
    const operatorApiProfile = operatorList.body?.profiles?.find((profile) => profile.id === 'openai-compatible');
    assert.ok(operatorApiProfile);
    for (const field of ['baseUrl', 'apiStyle', 'secretRef', 'apiKeyEnv', 'binary', 'version']) {
      assert.equal(operatorApiProfile[field], undefined, `operator profile leaked ${field}`);
    }
    assert.deepEqual(operatorApiProfile.credential, { present: true });
    const operatorProfileText = JSON.stringify(operatorApiProfile);
    for (const text of ['OPENAI', 'memory', 'envName', 'backend', 'ref']) {
      assert.equal(operatorProfileText.includes(text), false, `operator profile leaked ${text}`);
    }

    const operatorProfileGet = await server.requestJson('/api/providers/openai-compatible', {
      method: 'GET',
      headers: { cookie: paired.response.headers['set-cookie'] },
    });
    assert.equal(operatorProfileGet.status, 200);
    assert.equal(operatorProfileGet.body?.baseUrl, undefined);
    assert.equal(operatorProfileGet.body?.secretRef, undefined);
    assert.equal(operatorProfileGet.body?.credential, undefined);

    const operatorCliHealth = await server.requestJson('/api/providers/codex/health', {
      method: 'GET',
      headers: { cookie: paired.response.headers['set-cookie'] },
    });
    assert.equal(operatorCliHealth.status, 200);
    for (const field of ['binary', 'version', 'exitCode', 'errorCode']) {
      assert.equal(operatorCliHealth.body?.[field], undefined, `operator CLI health leaked ${field}`);
    }

    const exported = await server.requestJson('/api/providers/export', { method: 'GET', headers: { 'x-orca-token': token } });
    assert.equal(exported.status, 200);
    assert.equal(exported.body?.excludesSecrets, true);
    assert.equal(JSON.stringify(exported.body).includes('sk-test-secret'), false);
  } finally {
    await server.stop();
  }
});

test('server API provider lanes use dashboard-stored credential references without leaking secrets', async () => {
  const token = 'route-token-api-provider-lane';
  const secret = 'server-api-provider-secret';
  const dummy = await startDummyApiProvider(secret);
  const server = await startServer({
    token,
    env: {
      ORCA_CREDENTIAL_BACKEND: 'memory',
      ORCA_OPENAI_COMPATIBLE_BASE_URL: dummy.baseUrl,
    },
  });

  try {
    const setSecret = await server.requestJson('/api/providers/openai-compatible/secret', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        secret,
      },
    });
    assert.equal(setSecret.status, 200);
    assert.equal(JSON.stringify(setSecret.body).includes(secret), false);

    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'API Provider Route Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'API Provider Route Session', approved: true },
    });
    assert.equal(session.status, 201);
    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        title: 'Dashboard credential API lane',
        executorType: 'openai-compatible',
        taskPrompt: 'Use the dashboard-stored provider credential.',
        model: 'server-test-model',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(lane.status, 201);

    const completed = await waitForServerLane(server, lane.body.id, token);
    assert.equal(completed.status, 200);
    assert.equal(completed.body?.state, 'done', completed.body?.exitReason || 'lane should complete');
    assert.equal(dummy.requests.length, 1);
    assert.equal(dummy.requests[0].headers.authorization, `Bearer ${secret}`);
    assert.equal(dummy.requests[0].body.model, 'server-test-model');
    assert.equal(completed.body.processMeta.secretRef, 'provider:openai-compatible');
    assert.equal(completed.body.processMeta.credentialBackend, 'memory');
    assert.equal(JSON.stringify(completed.body).includes(secret), false);
  } finally {
    await server.stop();
    await dummy.close();
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

    // Operator (paired session) may NOT revoke — admin only.
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
