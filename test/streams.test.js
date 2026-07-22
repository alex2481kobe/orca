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

async function waitForEvents(response, predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = parseSseEvents(response.bodyText());
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for SSE event predicate');
}

async function closeStreamResponse(stream) {
  if (!stream?.res) return;
  stream.res.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 50));
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
    // v2: no session container. Two orchestrators (same cwd project) stand in for
    // the two sessions — the lane's container id is its orchestrator id, and the
    // scoped-lease session gate now keys off that orchestrator id.
    const orchestrator = await server.request('/api/orchestrators', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { cwd: process.cwd(), actor: 'dashboard', title: 'Lane Stream Orchestrator' },
    });
    assert.equal(orchestrator.status, 200, orchestrator.bodyText());
    const otherOrchestrator = await server.request('/api/orchestrators', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { cwd: process.cwd(), actor: 'dashboard', title: 'Other Lane Stream Orchestrator' },
    });
    assert.equal(otherOrchestrator.status, 200, otherOrchestrator.bodyText());
    const projectId = orchestrator.body.projectId;
    const lane = await server.request(`/api/orchestrators/${orchestrator.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Streaming executor', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201);

    const logDir = path.join(process.cwd(), 'artifacts', orchestrator.body.id, lane.body.id);
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, 'terminal.log'), 'hello from executor stream\n');

    const denied = await server.request(`/api/lanes/${lane.body.id}/stream`);
    assert.equal(denied.status, 401);

    const wrongSessionLease = await server.request('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'wrong-session-auditor',
        role: 'auditor',
        projectId,
        sessionId: otherOrchestrator.body.id,
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

    const auditorLease = await server.request('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'stream-auditor',
        role: 'auditor',
        projectId,
        sessionId: orchestrator.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(auditorLease.status, 201);

    const tail = await server.request(`/api/lanes/${lane.body.id}/terminal-tail?maxBytes=64`, {
      headers: { 'x-orca-tool-lease': auditorLease.body.leaseToken },
    });
    assert.equal(tail.status, 200);
    assert.equal(tail.body.text, 'hello from executor stream\n');
    assert.equal(tail.body.offset, 0);
    assert.equal(tail.body.nextOffset, 'hello from executor stream\n'.length);
    assert.equal(tail.body.eof, true);

    const incrementalTail = await server.request(`/api/lanes/${lane.body.id}/terminal-tail?offset=6&maxBytes=4`, {
      headers: { 'x-orca-tool-lease': auditorLease.body.leaseToken },
    });
    assert.equal(incrementalTail.status, 200);
    assert.equal(incrementalTail.body.text, 'from');
    assert.equal(incrementalTail.body.offset, 6);
    assert.equal(incrementalTail.body.nextOffset, 10);

    const stream = await server.request(`/api/lanes/${lane.body.id}/stream`, {
      headers: { 'x-orca-tool-lease': auditorLease.body.leaseToken },
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers['content-type'].includes('text/event-stream'), true);
    const text = await waitForBodyText(stream, /hello from executor stream/);
    const events = parseSseEvents(text);
    assert.equal(events.some((event) => event.event === 'snapshot' && /hello from executor stream/.test(event.data.text)), true);
    await closeStreamResponse(stream);
  } finally {
    await server.stop();
  }
});

test('lane terminal tail and live stream preserve large-output continuity', async () => {
  const token = 'lane-stream-continuity-token';
  const server = await startServer({
    ORCA_API_TOKEN: token,
    ORCA_STREAM_HEARTBEAT_MS: '10000',
  });
  let stream = null;
  try {
    // v2: the orchestrator record is the lane container (was the session).
    const orchestrator = await server.request('/api/orchestrators', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { cwd: process.cwd(), actor: 'dashboard', title: 'Continuity Orchestrator' },
    });
    assert.equal(orchestrator.status, 200, orchestrator.bodyText());
    const lane = await server.request(`/api/orchestrators/${orchestrator.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { title: 'Continuity executor', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201);
    const auditorLease = await server.request('/api/agent-tools/leases', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'continuity-auditor',
        role: 'auditor',
        projectId: orchestrator.body.projectId,
        sessionId: orchestrator.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(auditorLease.status, 201);

    const logDir = path.join(process.cwd(), 'artifacts', orchestrator.body.id, lane.body.id);
    const logPath = path.join(logDir, 'terminal.log');
    await fs.mkdir(logDir, { recursive: true });
    const initialLog = Array.from({ length: 340 }, (_, index) => `tail-${String(index).padStart(3, '0')}:${'x'.repeat(1000)}\n`).join('');
    await fs.writeFile(logPath, initialLog);

    let offset = 0;
    let reconstructed = '';
    for (let guard = 0; guard < 40; guard += 1) {
      const tail = await server.request(`/api/lanes/${lane.body.id}/terminal-tail?offset=${offset}&maxBytes=32768`, {
        headers: { 'x-orca-tool-lease': auditorLease.body.leaseToken },
      });
      assert.equal(tail.status, 200);
      assert.equal(tail.body.offset, offset);
      assert.ok(Buffer.byteLength(tail.body.text, 'utf8') <= 32768);
      reconstructed += tail.body.text;
      offset = tail.body.nextOffset;
      if (tail.body.eof) break;
    }
    assert.equal(reconstructed, initialLog);
    assert.equal(offset, Buffer.byteLength(initialLog, 'utf8'));

    stream = await server.request(`/api/lanes/${lane.body.id}/stream`, {
      headers: { 'x-orca-tool-lease': auditorLease.body.leaseToken },
    });
    assert.equal(stream.status, 200);
    const snapshotEvents = await waitForEvents(stream, (events) => events.some((event) => event.event === 'snapshot'));
    const snapshot = snapshotEvents.find((event) => event.event === 'snapshot').data;
    assert.equal(snapshot.nextOffset, Buffer.byteLength(initialLog, 'utf8'));
    assert.equal(snapshot.size, Buffer.byteLength(initialLog, 'utf8'));
    assert.equal(snapshot.truncated, true);

    const liveOutput = Array.from({ length: 620 }, (_, index) => `live-${String(index).padStart(3, '0')}:${'y'.repeat(1000)}\n`).join('');
    const liveStartOffset = Buffer.byteLength(initialLog, 'utf8');
    await fs.appendFile(logPath, liveOutput);
    const events = await waitForEvents(stream, (items) => {
      const text = items.filter((event) => event.event === 'append').map((event) => event.data.text).join('');
      return text.length >= liveOutput.length;
    }, 3000);
    const appendEvents = events.filter((event) => event.event === 'append');
    assert.ok(appendEvents.length >= 3, 'large live output should be split into bounded append events');
    let nextOffset = liveStartOffset;
    let reconstructedLive = '';
    for (const event of appendEvents) {
      assert.equal(event.data.offset, nextOffset);
      assert.equal(event.data.bytes, Buffer.byteLength(event.data.text, 'utf8'));
      assert.ok(event.data.bytes <= 256 * 1024);
      nextOffset = event.data.nextOffset;
      reconstructedLive += event.data.text;
      if (reconstructedLive.length >= liveOutput.length) break;
    }
    assert.equal(reconstructedLive, liveOutput);
    assert.equal(nextOffset, liveStartOffset + Buffer.byteLength(liveOutput, 'utf8'));
  } finally {
    await closeStreamResponse(stream);
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
