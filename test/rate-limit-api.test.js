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

async function startServerWithEnv(env = {}) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-rate-limit-api-'));
  process.chdir(tempDir);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.PORT = '0';
  const moduleUrl = `${pathToFileURL(SERVER_ENTRYPOINT).href}?rate-limit-api-test=${Date.now()}-${++harnessCounter}`;
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
    req.socket = { remoteAddress: options.remoteAddress || '127.0.0.1' };
    const handler = routeRequest(req, res);
    if (body === undefined) req.end();
    else req.end(body);
    await handler;
    return {
      status: res.statusCode,
      body: parseJsonBody(bodyText()),
      headers: res.headers,
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

test('API rate limiter returns 429 with retry metadata for pairing attempts', async () => {
  const server = await startServerWithEnv({
    ORCA_RATE_LIMIT_AUTH_PAIR_LIMIT: '1',
    ORCA_RATE_LIMIT_AUTH_PAIR_WINDOW_MS: '60000',
  });
  try {
    const first = await server.requestJson('/api/auth/pair', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        code: 'BAD-CODE',
      },
    });
    assert.notEqual(first.status, 429);
    assert.equal(first.headers['x-ratelimit-policy'], 'authPair');
    assert.equal(first.headers['x-ratelimit-limit'], '1');

    const second = await server.requestJson('/api/auth/pair', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        code: 'BAD-CODE',
      },
    });
    assert.equal(second.status, 429);
    assert.equal(second.headers['x-ratelimit-policy'], 'authPair');
    assert.equal(second.headers['x-ratelimit-remaining'], '0');
    assert.equal(second.headers['retry-after'], '60');
    assert.equal(second.body?.rateLimit?.policy, 'authPair');
    assert.equal(JSON.stringify(second.body).includes('BAD-CODE'), false);
  } finally {
    await server.stop();
  }
});

test('rate limiter keys authenticated requests without echoing raw token values', async () => {
  const token = 'rate-limit-token-secret';
  const server = await startServerWithEnv({
    ORCA_API_TOKEN: token,
    ORCA_RATE_LIMIT_PROVIDER_HEALTH_LIMIT: '1',
    ORCA_RATE_LIMIT_PROVIDER_HEALTH_WINDOW_MS: '60000',
  });
  try {
    const first = await server.requestJson('/api/providers/openai-compatible/health', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers['x-ratelimit-policy'], 'providerHealth');

    const second = await server.requestJson('/api/providers/openai-compatible/health', {
      method: 'GET',
      headers: { 'x-orca-token': token },
    });
    assert.equal(second.status, 429);
    assert.equal(second.body?.rateLimit?.policy, 'providerHealth');
    assert.equal(JSON.stringify(second.body).includes(token), false);
    assert.equal(JSON.stringify(second.headers).includes(token), false);
  } finally {
    await server.stop();
  }
});
