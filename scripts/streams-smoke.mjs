#!/usr/bin/env node
/*
 * Command Deck stream smoke.
 *
 * Validates the SSE event stream contract against a running local server:
 * compact payloads, heartbeat/snapshot events, no token leakage, and no API
 * token in the URL.
 */
import process from 'node:process';

const base = process.env.COMMAND_DECK_BASE_URL || 'http://127.0.0.1:3000';
const token = process.env.COMMAND_DECK_API_TOKEN || '';
const log = (label, info = '') => console.log(`[streams] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[streams FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

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
  await fetchOnceStream();
  log('done', 'ok');
}

await main().catch((error) => {
  console.error('[streams ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
});
