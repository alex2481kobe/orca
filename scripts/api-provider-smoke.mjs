#!/usr/bin/env node
/*
 * Deterministic API-provider lane smoke. It never calls public networks or
 * writes real credentials. Provider secrets use the in-memory credential
 * backend and provider endpoints are local dummy OpenAI-compatible and Gemini
 * servers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CommandDeckRegistry } from '../src/registry.js';
import { CredentialStore } from '../src/provider-profiles.js';

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

async function startDummyGeminiApi(secret) {
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
        candidates: [
          {
            content: {
              parts: [
                {
                  text: `local gemini dummy completed with ${secret}`,
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
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
const geminiSecret = 'gemini-provider-smoke-secret';
const geminiDummy = await startDummyGeminiApi(geminiSecret);

try {
  process.chdir(tempDir);
  process.env.COMMAND_DECK_OPENAI_COMPATIBLE_BASE_URL = dummy.baseUrl;
  delete process.env.COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY;
  process.env.COMMAND_DECK_OPENAI_COMPATIBLE_MODEL = 'smoke-model';
  process.env.COMMAND_DECK_GEMINI_BASE_URL = geminiDummy.baseUrl;
  delete process.env.COMMAND_DECK_GEMINI_API_KEY;

  const credentialStore = new CredentialStore({ backend: 'memory' });
  await credentialStore.set('provider:openai-compatible', secret);
  await credentialStore.set('provider:gemini', geminiSecret);
  const registry = new CommandDeckRegistry({ heartbeatIntervalMs: 25, autoCompleteMs: 250, credentialStore });
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
    assert.equal(completed.processMeta.secretRef, 'provider:openai-compatible');
    assert.equal(completed.processMeta.credentialBackend, 'memory');
    assert.equal(completed.processMeta.httpStatus, 200);
    assert.match(completed.apiProviderResult.outputPreview, /\[REDACTED\]/);
    assert.equal(JSON.stringify(completed).includes(secret), false);
    assert.equal(JSON.stringify(registry.auditEvents).includes(secret), false);
    log('openai-compatible lane executed and redacted local secret');

    const geminiLane = registry.createLane(session.id, {
      title: 'Gemini API lane',
      executorType: 'gemini',
      taskPrompt: 'Run the local Gemini provider smoke.',
      model: 'gemini-1.5-flash',
    }, { actor: 'smoke', approved: true });

    await registry.advanceLanes();
    const completedGemini = await waitForLane(registry, geminiLane.id);
    assert.equal(completedGemini.state, 'done', completedGemini.exitReason || 'Gemini lane did not complete');
    assert.equal(geminiDummy.requests.length, 1);
    assert.equal(geminiDummy.requests[0].url, '/v1/models/gemini-1.5-flash:generateContent');
    assert.equal(geminiDummy.requests[0].headers['x-goog-api-key'], geminiSecret);
    assert.equal(geminiDummy.requests[0].headers.authorization, undefined);
    assert.equal(geminiDummy.requests[0].body.contents[0].parts[0].text, 'Run the local Gemini provider smoke.');
    assert.equal(completedGemini.processMeta.apiStyle, 'gemini');
    assert.equal(completedGemini.processMeta.credentialBackend, 'memory');
    assert.equal(completedGemini.processMeta.httpStatus, 200);
    assert.match(completedGemini.apiProviderResult.outputPreview, /\[REDACTED\]/);
    assert.equal(JSON.stringify(completedGemini).includes(geminiSecret), false);
    assert.equal(JSON.stringify(registry.auditEvents).includes(geminiSecret), false);
    log('gemini lane executed and redacted local secret');
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
  }
} finally {
  await dummy.close();
  await geminiDummy.close();
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
