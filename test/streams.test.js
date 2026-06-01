import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
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
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = String(value);
  };
  res.write = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.write(chunk);
    res.ended = true;
    res.emit('finish');
  };
  return {
    res,
    bodyText: () => Buffer.concat(chunks).toString('utf8'),
  };
}

async function startServer(env = {}) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-streams-'));
  process.chdir(tempDir);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.PORT = '0';
  const moduleUrl = `${pathToFileURL(SERVER_ENTRYPOINT).href}?streams-test=${Date.now()}-${++harnessCounter}`;
  const { routeRequest, stopServer } = await import(moduleUrl);

  const request = async (requestPath, options = {}) => {
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
    req.socket = { remoteAddress: '127.0.0.1' };
    const handler = routeRequest(req, res);
    if (body === undefined) req.end();
    else req.end(body);
    await handler;
    const currentBody = bodyText();
    return {
      status: res.statusCode,
      bodyText,
      body: parseJsonBody(currentBody),
      headers: res.headers,
      res,
    };
  };

  return {
    request,
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

function parseSseEvents(text) {
  return text.split(/\n\n+/).map((frame) => {
    const eventLine = frame.split('\n').find((line) => line.startsWith('event:'));
    const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) return null;
    return {
      event: eventLine ? eventLine.slice(6).trim() : 'message',
      data: JSON.parse(dataLine.slice(5).trim()),
    };
  }).filter(Boolean);
}

test('stream endpoint requires auth when API token is configured and returns compact once payload', async () => {
  const token = 'stream-test-token';
  const server = await startServer({
    ORCA_API_TOKEN: token,
  });
  try {
    const denied = await server.request('/api/streams/events?once=true');
    assert.equal(denied.status, 401);
    assert.equal(String(denied.body?.error || '').includes('Unauthorized stream'), true);

    const allowed = await server.request('/api/streams/events?once=true', {
      headers: { 'x-orca-token': token },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['content-type'].includes('text/event-stream'), true);
    assert.equal(allowed.headers['cache-control'].includes('no-store'), true);
    assert.equal(allowed.headers['x-ratelimit-policy'], 'stream');
    assert.equal(allowed.bodyText().includes(token), false);
    assert.equal(allowed.bodyText().includes('ORCA_API_TOKEN'), false);
    const events = parseSseEvents(allowed.bodyText());
    assert.deepEqual(events.map((event) => event.event), ['stream_open', 'snapshot', 'stream_close']);
    const snapshot = events.find((event) => event.event === 'snapshot').data;
    assert.equal(snapshot.contractVersion, 'orca.streams.v1');
    assert.equal(typeof snapshot.counts.projects, 'number');
    assert.equal(Array.isArray(snapshot.activeLanes), true);
    assert.equal(Array.isArray(snapshot.pendingAudits), true);
  } finally {
    await server.stop();
  }
});

test('browser-session stream closes after the paired session is revoked', async () => {
  const token = 'stream-test-token-revoke';
  const server = await startServer({
    ORCA_API_TOKEN: token,
    ORCA_STREAM_HEARTBEAT_MS: '20',
  });
  try {
    const pairing = await server.request('/api/auth/pairing-codes', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'dashboard',
        label: 'stream test',
      },
    });
    assert.equal(pairing.status, 201);
    const paired = await server.request('/api/auth/pair', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        code: pairing.body.pairing.code,
        label: 'stream test browser',
      },
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers['set-cookie'];
    assert.equal(String(cookie).includes('HttpOnly'), true);

    const stream = await server.request('/api/streams/events', {
      headers: { cookie },
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.bodyText().includes('snapshot'), true);

    const logout = await server.request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie },
      body: {
        actor: 'dashboard',
      },
    });
    assert.equal(logout.status, 200);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stream did not close after auth revocation')), 500);
      stream.res.once('finish', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.equal(stream.bodyText().includes('auth_revoked'), true);
    assert.equal(stream.res.ended, true);
  } finally {
    await server.stop();
  }
});
