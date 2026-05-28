#!/usr/bin/env node
/*
 * Deterministic API-provider lane smoke. It never calls public networks or
 * writes real credentials. The provider secret is a temporary process env var
 * and the provider endpoint is a local dummy OpenAI-compatible server.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CommandDeckRegistry } from '../src/registry.js';

const log = (message) => console.log(`[api-provider-smoke] ${message}`);

async function startDummyApi(secret) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: `local dummy completed with ${secret}`,
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
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

async function waitForLane(registry, laneId) {
  for (let i = 0; i < 80; i += 1) {
    const lane = registry.getLane(laneId);
    if (['done', 'failed'].includes(lane?.state)) return lane;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return registry.getLane(laneId);
}

const previousCwd = process.cwd();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-api-provider-smoke-'));
const previousEnv = { ...process.env };
const secret = 'api-provider-smoke-secret';
const dummy = await startDummyApi(secret);

try {
  process.chdir(tempDir);
  process.env.COMMAND_DECK_OPENAI_COMPATIBLE_BASE_URL = dummy.baseUrl;
  process.env.COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY = secret;
  process.env.COMMAND_DECK_OPENAI_COMPATIBLE_MODEL = 'smoke-model';

  const registry = new CommandDeckRegistry({ heartbeatIntervalMs: 25, autoCompleteMs: 250 });
  try {
    const project = registry.createProject({ name: 'API Provider Smoke' }, { actor: 'smoke', approved: true });
    const session = registry.createSession(project.id, { name: 'API Provider Session' }, { actor: 'smoke', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'OpenAI-compatible API lane',
      executorType: 'openai-compatible',
      taskPrompt: 'Run the local API provider smoke.',
      model: 'smoke-explicit-model',
    }, { actor: 'smoke', approved: true });

    await registry.advanceLanes();
    const completed = await waitForLane(registry, lane.id);
    assert.equal(completed.state, 'done', completed.exitReason || 'lane did not complete');
    assert.equal(dummy.requests.length, 1);
    assert.equal(dummy.requests[0].headers.authorization, `Bearer ${secret}`);
    assert.equal(dummy.requests[0].body.model, 'smoke-explicit-model');
    assert.equal(completed.processMeta.apiKeyEnv, 'COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY');
    assert.equal(completed.processMeta.httpStatus, 200);
    assert.match(completed.apiProviderResult.outputPreview, /\[REDACTED\]/);
    assert.equal(JSON.stringify(completed).includes(secret), false);
    assert.equal(JSON.stringify(registry.auditEvents).includes(secret), false);
    log('openai-compatible lane executed and redacted local secret');
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
  }
} finally {
  await dummy.close();
  process.chdir(previousCwd);
  await fs.rm(tempDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 25 });
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previousEnv)) {
    process.env[key] = value;
  }
}

log('done');
