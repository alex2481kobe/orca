import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import { CredentialStore, ProviderProfileStore } from '../src/provider-profiles.js';

async function withIsolatedRegistry(options = {}) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-api-provider-test-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ heartbeatIntervalMs: 25, autoCompleteMs: 250, ...options });
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
    taskPrompt: 'Summarize the Orca provider smoke.',
    model: 'orca-test-model',
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
  process.env.ORCA_OPENAI_COMPATIBLE_BASE_URL = dummy.baseUrl;
  process.env.ORCA_OPENAI_COMPATIBLE_API_KEY = secret;
  process.env.ORCA_OPENAI_COMPATIBLE_MODEL = 'env-default-model';

  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const lane = createApiLane(registry, 'openai-compatible');
    assert.equal(lane.executorType, 'openai-compatible');

    await registry.advanceLanes();
    const completed = await waitForLane(registry, lane.id, (item) => ['done', 'failed'].includes(item?.state));
    assert.equal(completed.state, 'done', completed.exitReason || 'lane should complete');
    assert.equal(dummy.requests.length, 1);
    assert.equal(dummy.requests[0].headers.authorization, `Bearer ${secret}`);
    assert.equal(dummy.requests[0].body.model, 'orca-test-model');
    assert.equal(dummy.requests[0].body.messages.at(-1).content, 'Summarize the Orca provider smoke.');
    assert.equal(completed.processMeta.apiKeyEnv, 'ORCA_OPENAI_COMPATIBLE_API_KEY');
    assert.equal(completed.processMeta.httpStatus, 200);
    assert.equal(completed.apiProviderResult.providerId, 'openai-compatible');
    assert.match(completed.apiProviderResult.outputPreview, /\[REDACTED\]/);
    const assistantEvent = completed.agentEvents.find((event) => event.type === 'message.assistant.final');
    assert.ok(assistantEvent, 'API provider output is also recorded as assistant chat output');
    assert.deepEqual(assistantEvent.usage, { prompt_tokens: 12, completion_tokens: 4 });

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
  process.env.ORCA_OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:65530/v1';
  delete process.env.ORCA_OPENAI_COMPATIBLE_API_KEY;

  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const lane = createApiLane(registry, 'openai-compatible');
    await registry.advanceLanes();
    const failed = await waitForLane(registry, lane.id, (item) => item?.state === 'failed');
    assert.equal(failed.state, 'failed');
    assert.match(failed.exitReason, /missing required credential provider:openai-compatible or env secret ORCA_OPENAI_COMPATIBLE_API_KEY/);
    assert.equal(JSON.stringify(failed).includes('api-provider-test-secret'), false);
  } finally {
    await cleanup();
    restore();
  }
});

test('API provider lane uses dashboard-stored credential backend before env fallback', async () => {
  const restore = snapshotEnv();
  const secret = 'memory-provider-secret';
  const dummy = await startDummyApi(async (record, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'memory credential ok' } }] }));
  });
  process.env.ORCA_OPENAI_COMPATIBLE_BASE_URL = dummy.baseUrl;
  delete process.env.ORCA_OPENAI_COMPATIBLE_API_KEY;

  const credentialStore = new CredentialStore({ backend: 'memory' });
  await credentialStore.set('provider:openai-compatible', secret);
  const { registry, cleanup } = await withIsolatedRegistry({ credentialStore });
  try {
    const lane = createApiLane(registry, 'openai-compatible');
    await registry.advanceLanes();
    const completed = await waitForLane(registry, lane.id, (item) => ['done', 'failed'].includes(item?.state));
    assert.equal(completed.state, 'done', completed.exitReason || 'lane should complete');
    assert.equal(dummy.requests[0].headers.authorization, `Bearer ${secret}`);
    assert.equal(completed.processMeta.secretRef, 'provider:openai-compatible');
    assert.equal(completed.processMeta.credentialBackend, 'memory');
    assert.equal(JSON.stringify(completed).includes(secret), false);
    assert.equal(JSON.stringify(registry.auditEvents).includes(secret), false);
  } finally {
    await cleanup();
    await dummy.close();
    restore();
  }
});

test('API provider lane uses edited provider profile base URL before static defaults', async () => {
  const restore = snapshotEnv();
  const secret = 'profile-store-provider-secret';
  const dummy = await startDummyApi(async (record, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'profile URL ok' } }] }));
  });
  delete process.env.ORCA_OPENAI_COMPATIBLE_BASE_URL;
  delete process.env.ORCA_OPENAI_COMPATIBLE_API_KEY;

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-provider-profile-test-'));
  const credentialStore = new CredentialStore({ backend: 'memory' });
  const providerStore = new ProviderProfileStore({
    stateFile: path.join(profileDir, 'providers.json'),
    credentialStore,
  });
  await providerStore.updateProfile('openai-compatible', {
    enabled: true,
    baseUrl: dummy.baseUrl,
    apiStyle: 'openai-compatible',
    secretRef: 'provider:openai-compatible',
    apiKeyEnv: 'ORCA_OPENAI_COMPATIBLE_API_KEY',
  }, { actor: 'test', approved: true });
  await providerStore.setSecret('openai-compatible', secret, { actor: 'test', approved: true });
  const { registry, cleanup } = await withIsolatedRegistry({ credentialStore, providerProfileStore: providerStore });
  try {
    const lane = createApiLane(registry, 'openai-compatible');
    await registry.advanceLanes();
    const completed = await waitForLane(registry, lane.id, (item) => ['done', 'failed'].includes(item?.state));
    assert.equal(completed.state, 'done', completed.exitReason || 'lane should complete');
    assert.equal(dummy.requests.length, 1);
    assert.equal(dummy.requests[0].headers.authorization, `Bearer ${secret}`);
    assert.equal(completed.processMeta.endpointHost, new URL(dummy.baseUrl).host);
    assert.equal(JSON.stringify(completed).includes(secret), false);
  } finally {
    await cleanup();
    await fs.rm(profileDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 25 });
    await dummy.close();
    restore();
  }
});

test('Gemini API provider lane executes through native dummy endpoint and redacts secrets', async () => {
  const restore = snapshotEnv();
  const secret = 'gemini-provider-secret';
  const dummy = await startDummyApi(async (record, res) => {
    assert.equal(record.method, 'POST');
    assert.equal(record.url, '/v1/models/orca-test-model:generateContent');
    assert.equal(record.headers['x-goog-api-key'], secret);
    assert.equal(record.headers.authorization, undefined);
    assert.equal(record.body.contents[0].parts[0].text, 'Summarize the Orca provider smoke.');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: `gemini dummy ok with ${secret}`,
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3 },
    }));
  });
  process.env.ORCA_GEMINI_BASE_URL = dummy.baseUrl;
  delete process.env.ORCA_GEMINI_API_KEY;

  const credentialStore = new CredentialStore({ backend: 'memory' });
  await credentialStore.set('provider:gemini', secret);
  const { registry, cleanup } = await withIsolatedRegistry({ credentialStore });
  try {
    const lane = createApiLane(registry, 'gemini');
    assert.equal(lane.executorType, 'gemini');
    await registry.advanceLanes();
    const completed = await waitForLane(registry, lane.id, (item) => ['done', 'failed'].includes(item?.state));
    assert.equal(completed.state, 'done', completed.exitReason || 'lane should complete');
    assert.equal(dummy.requests.length, 1);
    assert.equal(completed.processMeta.apiStyle, 'gemini');
    assert.equal(completed.processMeta.endpointPath, '/v1/models/orca-test-model:generateContent');
    assert.equal(completed.apiProviderResult.providerId, 'gemini');
    assert.equal(completed.apiProviderResult.model, 'orca-test-model');
    assert.match(completed.apiProviderResult.outputPreview, /\[REDACTED\]/);
    assert.equal(JSON.stringify(completed).includes(secret), false);
    assert.equal(JSON.stringify(registry.auditEvents).includes(secret), false);
  } finally {
    await cleanup();
    await dummy.close();
    restore();
  }
});

test('API provider lane fails with a size-cap error when the response streams past the byte cap', async () => {
  const restore = snapshotEnv();
  const secret = 'oversized-provider-secret';
  // Stream well past the 4KiB cap we set below, in chunks, WITHOUT calling
  // res.end() until we've flushed more than the cap — the adapter must abort on
  // the running byte count rather than buffer the whole body first.
  const capBytes = 4096;
  const chunk = 'x'.repeat(1024);
  const totalChunks = 64; // 64 KiB total, 16x the cap
  const dummy = await startDummyApi(async (record, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    let sent = 0;
    const pump = () => {
      // Once the socket is torn down by the adapter's abort, stop pumping.
      if (res.writableEnded || res.destroyed) return;
      if (sent >= totalChunks) {
        try { res.end(); } catch { /* already closed */ }
        return;
      }
      sent += 1;
      try {
        res.write(chunk, () => setTimeout(pump, 1));
      } catch { /* socket closed by abort */ }
    };
    pump();
  });
  process.env.ORCA_OPENAI_COMPATIBLE_BASE_URL = dummy.baseUrl;
  process.env.ORCA_OPENAI_COMPATIBLE_API_KEY = secret;
  process.env.ORCA_OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES = String(capBytes);

  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const lane = createApiLane(registry, 'openai-compatible');
    await registry.advanceLanes();
    const failed = await waitForLane(registry, lane.id, (item) => ['done', 'failed'].includes(item?.state));
    // Assert the ERROR surfaced (not memory): the lane fails with the size-cap message.
    assert.equal(failed.state, 'failed', failed.exitReason || 'oversized response must fail the lane');
    assert.match(failed.exitReason, /exceeded configured size cap/);
    assert.equal(JSON.stringify(failed).includes(secret), false, 'lane leaked API secret');
  } finally {
    await cleanup();
    await dummy.close();
    restore();
  }
});

test('Kimi, DeepSeek, and Composer use the shared OpenAI-compatible provider path safely', async () => {
  const restore = snapshotEnv();
  const providers = [
    ['kimi', 'ORCA_KIMI_BASE_URL', 'provider:kimi', 'kimi-secret'],
    ['deepseek', 'ORCA_DEEPSEEK_BASE_URL', 'provider:deepseek', 'deepseek-secret'],
    ['composer', 'ORCA_COMPOSER_BASE_URL', 'provider:composer', 'composer-secret'],
  ];
  const dummy = await startDummyApi(async (record, res) => {
    assert.equal(record.method, 'POST');
    assert.equal(record.url, '/v1/chat/completions');
    assert.match(record.headers.authorization || '', /^Bearer /);
    assert.equal(record.body.model, 'orca-test-model');
    assert.equal(record.body.messages.at(-1).content, 'Summarize the Orca provider smoke.');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: `ok ${record.headers.authorization}` } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
  });

  const credentialStore = new CredentialStore({ backend: 'memory' });
  for (const [providerId, envName, secretRef, secret] of providers) {
    process.env[envName] = dummy.baseUrl;
    await credentialStore.set(secretRef, secret);
  }

  const { registry, cleanup } = await withIsolatedRegistry({ credentialStore });
  try {
    for (const [providerId, , secretRef, secret] of providers) {
      const lane = createApiLane(registry, providerId);
      assert.equal(lane.executorType, providerId);
      await registry.advanceLanes();
      const completed = await waitForLane(registry, lane.id, (item) => ['done', 'failed'].includes(item?.state));
      assert.equal(completed.state, 'done', `${providerId}: ${completed.exitReason || 'lane should complete'}`);
      assert.equal(completed.processMeta.apiStyle, 'openai-compatible');
      assert.equal(completed.processMeta.providerId, providerId);
      assert.equal(completed.processMeta.providerType, providerId);
      assert.equal(completed.processMeta.secretRef, secretRef);
      assert.equal(completed.processMeta.endpointPath, '/v1/chat/completions');
      assert.equal(completed.apiProviderResult.providerId, providerId);
      assert.equal(completed.apiProviderResult.model, 'orca-test-model');
      assert.match(completed.apiProviderResult.outputPreview, /\[REDACTED\]/);
      assert.equal(JSON.stringify(completed).includes(secret), false, `${providerId} lane leaked secret`);
      assert.equal(JSON.stringify(registry.auditEvents).includes(secret), false, `${providerId} audit leaked secret`);
    }
    assert.equal(dummy.requests.length, providers.length);
  } finally {
    await cleanup();
    await dummy.close();
    restore();
  }
});
