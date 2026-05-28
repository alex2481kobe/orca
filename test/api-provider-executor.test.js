import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandDeckRegistry } from '../src/registry.js';

async function withIsolatedRegistry() {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-api-provider-test-'));
  process.chdir(tempDir);
  const registry = new CommandDeckRegistry({ heartbeatIntervalMs: 25, autoCompleteMs: 250 });
  const cleanup = async () => {
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') {
      await registry.drainPendingWrites();
    }
    process.chdir(previousCwd);
    await fs.rm(tempDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 25 });
  };
  return { registry, cleanup };
}

function snapshotEnv() {
  const snapshot = { ...process.env };
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
  };
}

async function startDummyApi(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : null;
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      await handler(record, res);
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

async function waitForLane(registry, laneId, predicate) {
  for (let i = 0; i < 80; i += 1) {
    const lane = registry.getLane(laneId);
    if (predicate(lane)) return lane;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return registry.getLane(laneId);
}

function createApiLane(registry, executorType = 'openai-compatible') {
  const project = registry.createProject({ name: `API ${executorType}` }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, { name: `Session ${executorType}` }, { actor: 'test', approved: true });
  return registry.createLane(session.id, {
    title: `provider ${executorType}`,
    executorType,
    taskPrompt: 'Summarize the Command Deck provider smoke.',
    model: 'command-deck-test-model',
  }, { actor: 'test', approved: true });
}

test('OpenAI-compatible API provider lane executes through dummy server and redacts secrets', async () => {
  const restore = snapshotEnv();
  const secret = 'api-provider-test-secret';
  const dummy = await startDummyApi(async (record, res) => {
    assert.equal(record.method, 'POST');
    assert.equal(record.url, '/v1/chat/completions');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            content: `dummy ok with ${record.headers.authorization}`,
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }));
  });
  process.env.COMMAND_DECK_OPENAI_COMPATIBLE_BASE_URL = dummy.baseUrl;
  process.env.COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY = secret;
  process.env.COMMAND_DECK_OPENAI_COMPATIBLE_MODEL = 'env-default-model';

  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const lane = createApiLane(registry, 'openai-compatible');
    assert.equal(lane.executorType, 'openai-compatible');

    await registry.advanceLanes();
    const completed = await waitForLane(registry, lane.id, (item) => ['done', 'failed'].includes(item?.state));
    assert.equal(completed.state, 'done', completed.exitReason || 'lane should complete');
    assert.equal(dummy.requests.length, 1);
    assert.equal(dummy.requests[0].headers.authorization, `Bearer ${secret}`);
    assert.equal(dummy.requests[0].body.model, 'command-deck-test-model');
    assert.equal(dummy.requests[0].body.messages.at(-1).content, 'Summarize the Command Deck provider smoke.');
    assert.equal(completed.processMeta.apiKeyEnv, 'COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY');
    assert.equal(completed.processMeta.httpStatus, 200);
    assert.equal(completed.apiProviderResult.providerId, 'openai-compatible');
    assert.match(completed.apiProviderResult.outputPreview, /\[REDACTED\]/);

    const serializedLane = JSON.stringify(completed);
    const serializedAudit = JSON.stringify(registry.auditEvents);
    assert.equal(serializedLane.includes(secret), false, 'lane state leaked API secret');
    assert.equal(serializedAudit.includes(secret), false, 'audit events leaked API secret');
  } finally {
    await cleanup();
    await dummy.close();
    restore();
  }
});

test('API provider lane fails closed when the env secret is missing', async () => {
  const restore = snapshotEnv();
  process.env.COMMAND_DECK_OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:65530/v1';
  delete process.env.COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY;

  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const lane = createApiLane(registry, 'openai-compatible');
    await registry.advanceLanes();
    const failed = await waitForLane(registry, lane.id, (item) => item?.state === 'failed');
    assert.equal(failed.state, 'failed');
    assert.match(failed.exitReason, /missing required env secret COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY/);
    assert.equal(JSON.stringify(failed).includes('api-provider-test-secret'), false);
  } finally {
    await cleanup();
    restore();
  }
});

test('Gemini API profile is first-class but fails closed until its native adapter exists', async () => {
  const restore = snapshotEnv();
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const lane = createApiLane(registry, 'gemini');
    assert.equal(lane.executorType, 'gemini');
    await registry.advanceLanes();
    const failed = await waitForLane(registry, lane.id, (item) => item?.state === 'failed');
    assert.equal(failed.state, 'failed');
    assert.match(failed.exitReason, /API style gemini is not executable yet/);
  } finally {
    await cleanup();
    restore();
  }
});
