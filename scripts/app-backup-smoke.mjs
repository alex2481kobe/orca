import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-app-backup-'));
const token = 'app-backup-smoke-token';
const secret = 'sk-app-backup-secret-value';

function restoreEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in previousEnv)) delete process.env[key];
  });
  Object.entries(previousEnv).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
}

function responseState() {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
  };
  return {
    res,
    body() {
      const text = Buffer.concat(chunks).toString('utf8');
      return text ? JSON.parse(text) : null;
    },
  };
}

try {
  process.chdir(tempDir);
  process.env.COMMAND_DECK_API_TOKEN = token;
  process.env.COMMAND_DECK_CREDENTIAL_BACKEND = 'memory';
  process.env.PORT = '0';

  const moduleUrl = `${pathToFileURL(path.join(previousCwd, 'src', 'server.js')).href}?app-backup-smoke=${Date.now()}`;
  const { routeRequest, stopServer } = await import(moduleUrl);

  const reqJson = async (url, options = {}) => {
    const state = responseState();
    const req = new PassThrough();
    req.method = options.method || 'GET';
    req.url = url;
    req.headers = {
      'content-type': 'application/json',
      ...(options.token === false ? {} : { 'x-commanddeck-token': token }),
      ...(options.headers || {}),
    };
    const pending = routeRequest(req, state.res);
    if (options.body === undefined) req.end();
    else req.end(JSON.stringify(options.body));
    await pending;
    return { status: state.res.statusCode, body: state.body(), headers: state.res.headers };
  };

  const unauthorized = await reqJson('/api/app/export', { token: false });
  assert.equal(unauthorized.status, 401);

  const project = await reqJson('/api/projects', {
    method: 'POST',
    body: {
      actor: 'smoke',
      approved: true,
      name: 'Backup Smoke',
      quickLinks: [{ label: 'Local', url: 'http://127.0.0.1:3000' }],
    },
  });
  assert.equal(project.status, 201);

  const session = await reqJson(`/api/projects/${project.body.id}/sessions`, {
    method: 'POST',
    body: {
      actor: 'smoke',
      approved: true,
      name: 'Backup Session',
    },
  });
  assert.equal(session.status, 201);

  const lane = await reqJson(`/api/sessions/${session.body.id}/lanes`, {
    method: 'POST',
    body: {
      actor: 'smoke',
      approved: true,
      title: `Backup lane ${secret}`,
      executorType: 'mock',
    },
  });
  assert.equal(lane.status, 201);

  const storedSecret = await reqJson('/api/providers/openai-compatible/secret', {
    method: 'POST',
    body: {
      actor: 'smoke',
      approved: true,
      secret,
    },
  });
  assert.equal(storedSecret.status, 200);

  const exported = await reqJson('/api/app/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.kind, 'command-deck.app-export');
  assert.equal(exported.body.excludesSecrets, true);
  assert.equal(exported.body.includesAuthSessions, false);
  assert.equal(exported.body.includesArtifacts, false);
  assert.equal(JSON.stringify(exported.body).includes(secret), false);
  assert.equal(JSON.stringify(exported.body).includes('toolLeases'), false);
  assert.equal(exported.body.counts.projects >= 1, true);
  assert.equal(exported.body.counts.providers >= 1, true);

  const dryRun = await reqJson('/api/app/import/dry-run', {
    method: 'POST',
    body: exported.body,
  });
  assert.equal(dryRun.status, 200);
  assert.equal(dryRun.body.dryRun, true);
  assert.equal(dryRun.body.counts.projects >= 1, true);

  const leaky = await reqJson('/api/app/import/dry-run', {
    method: 'POST',
    body: {
      ...exported.body,
      secretValue: secret,
    },
  });
  assert.equal(leaky.status, 422);
  assert.equal(JSON.stringify(leaky.body).includes(secret), false);

  const approvalRequired = await reqJson('/api/app/import/apply', {
    method: 'POST',
    body: {
      actor: 'smoke',
      payload: exported.body,
    },
  });
  assert.equal(approvalRequired.status, 409);
  assert.equal(approvalRequired.body.requiresApproval, true);

  const applied = await reqJson('/api/app/import/apply', {
    method: 'POST',
    body: {
      actor: 'smoke',
      approved: true,
      payload: exported.body,
    },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.dryRun, false);
  assert.equal(JSON.stringify(applied.body).includes(secret), false);

  const support = await reqJson('/api/app/support-bundle');
  assert.equal(support.status, 200);
  assert.equal(support.body.kind, 'command-deck.support-bundle');
  assert.equal(support.body.shareableByDefault, true);
  assert.equal(JSON.stringify(support.body).includes(secret), false);
  assert.equal(JSON.stringify(support.body).includes(tempDir), false);

  await stopServer();
  console.log('app backup smoke passed');
} finally {
  restoreEnv();
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}
