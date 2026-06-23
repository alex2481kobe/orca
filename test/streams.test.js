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

async function waitForBodyText(response, pattern, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = response.bodyText();
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for body text matching ${pattern}`);
}

test('stream endpoint requires auth when API token is configured and returns a lightweight revision signal', async () => {
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
    assert.equal(typeof snapshot.revision, 'number');
    assert.equal(typeof snapshot.counts.projects, 'number');
    assert.equal(typeof snapshot.counts.pendingAudits, 'number');
    // The signal carries NO lane/audit bodies — clients re-fetch via the tiered API.
    assert.equal(snapshot.activeLanes, undefined);
    assert.equal(snapshot.pendingAudits, undefined);
  } finally {
    await server.stop();
  }
});

test('lane stream accepts scoped lane.get tool leases for live executor output', async () => {
  const token = 'lane-stream-token';
  const server = await startServer({
    ORCA_API_TOKEN: token,
  });
  try {
    const project = await server.request('/api/projects', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Lane Stream Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await server.request(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Lane Stream Session', approved: true },
    });
    assert.equal(session.status, 201);
    const otherSession = await server.request(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { name: 'Other Lane Stream Session', approved: true },
    });
    assert.equal(otherSession.status, 201);
    const lane = await server.request(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Streaming executor', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201);

    const logDir = path.join(process.cwd(), 'artifacts', session.body.id, lane.body.id);
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, 'terminal.log'), 'hello from executor stream\n');

    const denied = await server.request(`/api/lanes/${lane.body.id}/stream`);
    assert.equal(denied.status, 401);

    const wrongSessionLease = await server.request('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'wrong-session-supervisor',
        role: 'supervisor',
        projectId: project.body.id,
        sessionId: otherSession.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(wrongSessionLease.status, 201);
    const scopedDenied = await server.request(`/api/lanes/${lane.body.id}/stream`, {
      headers: { 'x-orca-tool-lease': wrongSessionLease.body.leaseToken },
    });
    assert.equal(scopedDenied.status, 401);
    const scopedTailDenied = await server.request(`/api/lanes/${lane.body.id}/terminal-tail?maxBytes=64`, {
      headers: { 'x-orca-tool-lease': wrongSessionLease.body.leaseToken },
    });
    assert.equal(scopedTailDenied.status, 403);
    assert.match(scopedTailDenied.body.error, /Tool lease session mismatch/);

    const supervisorLease = await server.request('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'stream-supervisor',
        role: 'supervisor',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(supervisorLease.status, 201);

    const tail = await server.request(`/api/lanes/${lane.body.id}/terminal-tail?maxBytes=64`, {
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
    });
    assert.equal(tail.status, 200);
    assert.equal(tail.body.text, 'hello from executor stream\n');
    assert.equal(tail.body.offset, 0);
    assert.equal(tail.body.nextOffset, 'hello from executor stream\n'.length);
    assert.equal(tail.body.eof, true);

    const incrementalTail = await server.request(`/api/lanes/${lane.body.id}/terminal-tail?offset=6&maxBytes=4`, {
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
    });
    assert.equal(incrementalTail.status, 200);
    assert.equal(incrementalTail.body.text, 'from');
    assert.equal(incrementalTail.body.offset, 6);
    assert.equal(incrementalTail.body.nextOffset, 10);

    const stream = await server.request(`/api/lanes/${lane.body.id}/stream`, {
      headers: { 'x-orca-tool-lease': supervisorLease.body.leaseToken },
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers['content-type'].includes('text/event-stream'), true);
    const text = await waitForBodyText(stream, /hello from executor stream/);
    const events = parseSseEvents(text);
    assert.equal(events.some((event) => event.event === 'snapshot' && /hello from executor stream/.test(event.data.text)), true);
    stream.res.emit('close');
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
