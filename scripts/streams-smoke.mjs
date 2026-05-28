#!/usr/bin/env node
/*
 * Command Deck stream smoke.
 *
 * Validates the SSE event stream contract against a running local server:
 * compact payloads, heartbeat/snapshot events, no token leakage, and no API
 * token in the URL.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const args = process.argv.slice(2);
let explicitBase = Boolean(process.env.COMMAND_DECK_BASE_URL);
let base = process.env.COMMAND_DECK_BASE_URL || 'http://127.0.0.1:3000';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base' && args[i + 1]) {
    base = args[i + 1];
    explicitBase = true;
  }
}
let token = process.env.COMMAND_DECK_API_TOKEN || '';
const tempDir = explicitBase ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-streams-smoke-'));
let server = null;
let stopServer = null;
const log = (label, info = '') => console.log(`[streams] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[streams FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

async function startIsolatedServerIfNeeded() {
  if (explicitBase) return;
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.COMMAND_DECK_HOST = '127.0.0.1';
  process.env.COMMAND_DECK_API_TOKEN = 'streams-smoke-token';
  process.env.COMMAND_DECK_RATE_LIMIT_DISABLED = 'true';
  token = process.env.COMMAND_DECK_API_TOKEN;
  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
  log('server', `started isolated local server at ${base}`);
}

async function cleanupStartedServer() {
  if (stopServer) await stopServer();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) {
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previousEnv)) {
    process.env[key] = value;
  }
}

function parseSseEvents(text) {
  return text.split(/\n\n+/).map((frame) => {
    const lines = frame.split(/\n/).filter(Boolean);
    const out = { event: 'message', data: '' };
    for (const line of lines) {
      if (line.startsWith('event:')) out.event = line.slice(6).trim();
      if (line.startsWith('data:')) out.data += line.slice(5).trim();
    }
    if (!out.data) return null;
    try {
      out.json = JSON.parse(out.data);
    } catch {
      out.json = null;
    }
    return out;
  }).filter(Boolean);
}

async function fetchOnceStream() {
  const url = new URL('/api/streams/events', base);
  url.searchParams.set('once', 'true');
  if (url.search.includes('token') || url.search.includes('apiToken')) {
    fail('stream URL must not include token parameters', url.toString());
  }
  const response = await fetch(url, {
    headers: token ? { 'x-commanddeck-token': token } : {},
  });
  if (!response.ok) fail('stream request failed', `${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) fail('stream content-type is not SSE', contentType);
  const text = await response.text();
  if (token && text.includes(token)) fail('stream payload leaked API token');
  for (const forbidden of ['COMMAND_DECK_API_TOKEN', 'COMMAND_DECK_WORKER_TOKEN', 'secret', 'apiKey', 'sessionToken']) {
    if (text.includes(forbidden)) fail('stream payload leaked forbidden marker', forbidden);
  }
  const events = parseSseEvents(text);
  const eventNames = events.map((event) => event.event);
  for (const expected of ['stream_open', 'snapshot', 'stream_close']) {
    if (!eventNames.includes(expected)) fail('stream missing event', expected);
  }
  const snapshot = events.find((event) => event.event === 'snapshot')?.json;
  if (!snapshot || snapshot.contractVersion !== 'command-deck.streams.v1') {
    fail('snapshot contract missing');
  }
  if (!snapshot.counts || typeof snapshot.counts.projects !== 'number') fail('snapshot counts missing');
  if (!Array.isArray(snapshot.activeLanes) || !Array.isArray(snapshot.pendingAudits)) {
    fail('snapshot arrays missing');
  }
  const tooLarge = events.some((event) => event.data.length > 32_000);
  if (tooLarge) fail('stream event payload too large');
  log('once', `events=${eventNames.join(',')} counts=${JSON.stringify(snapshot.counts)}`);
}

async function main() {
  await startIsolatedServerIfNeeded();
  await fetchOnceStream();
  log('done', 'ok');
}

await main().catch((error) => {
  console.error('[streams ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
}).finally(async () => {
  await cleanupStartedServer();
});
