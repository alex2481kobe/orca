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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-settings-api-'));

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
    process.env.COMMAND_DECK_API_TOKEN = token;
  } else {
    delete process.env.COMMAND_DECK_API_TOKEN;
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return { restore };
}

let harnessCounter = 0;

async function startServer({ token, env = {} }) {
  const { restore } = await isolateEnvironment(token, { ...env, PORT: '0' });
  const moduleUrl = `${pathToFileURL(SERVER_ENTRYPOINT).href}?effective-settings-api=${Date.now()}-${++harnessCounter}`;
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
      await restore();
    },
  };
}

test('effective settings API exposes defaults, scoped overrides, and mobile links', async () => {
  const token = 'effective-settings-token';
  const server = await startServer({ token });

  try {
    const defaults = await server.requestJson('/api/settings/effective', { method: 'GET' });
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body?.settings?.spawn?.spawnPolicy, 'within_capacity');
    assert.equal(defaults.body?.settings?.privateAccess?.funnelAllowed, false);
    assert.equal(JSON.stringify(defaults.body).includes('apiKey'), false);

    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Settings API Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Settings API Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const deniedNoToken = await server.requestJson(`/api/settings/project/${project.body.id}`, {
      method: 'PATCH',
      body: {
        actor: 'dashboard',
        approved: true,
        settingsOverrides: {
          privateAccess: { preferredMode: 'local' },
        },
      },
    });
    assert.equal(deniedNoToken.status, 401);

    const deniedApproval = await server.requestJson(`/api/settings/project/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        settingsOverrides: {
          privateAccess: { preferredMode: 'local' },
        },
      },
    });
    assert.equal(deniedApproval.status, 409);
    assert.equal(deniedApproval.body?.requiresApproval, true);

    const updated = await server.requestJson(`/api/settings/project/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        settingsOverrides: {
          privateAccess: { preferredMode: 'local' },
          notifications: { browser: true },
        },
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body?.settings?.privateAccess?.preferredMode, 'local');
    assert.equal(updated.body?.settings?.notifications?.browser, true);

    const invalid = await server.requestJson(`/api/settings/session/${session.body.id}`, {
      method: 'PATCH',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        settingsOverrides: {
          provider: { apiKey: 'should-not-persist' },
        },
      },
    });
    assert.equal(invalid.status, 422);
    assert.equal(String(invalid.body?.error || '').includes('not supported'), true);

    const manifest = await server.requestJson('/api/mobile/manifest', { method: 'GET' });
    assert.equal(manifest.status, 200);
    assert.equal(typeof manifest.body?.effectiveSettingsUrl, 'string');
    assert.equal(typeof manifest.body?.projects?.[0]?.effectiveSettingsUrl, 'string');
    assert.equal(typeof manifest.body?.projects?.[0]?.sessions?.[0]?.effectiveSettingsUrl, 'string');
  } finally {
    await server.stop();
  }
});
