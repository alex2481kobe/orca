#!/usr/bin/env node
const DEFAULT_BASE = 'http://127.0.0.1:3000';
const DEFAULT_TTL_SECONDS = 30 * 60;

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`Usage: npm run operator:pair -- [--base http://127.0.0.1:3000] [--label phone] [--ttl-seconds 1800]\n\nRequires COMMAND_DECK_API_TOKEN in the environment. Prints only the one-time pairing code and expiry; it never prints the API token.`);
  process.exit(0);
}

const base = (argValue('--base') || process.env.COMMAND_DECK_LOCAL_URL || DEFAULT_BASE).replace(/\/$/, '');
const label = argValue('--label') || process.env.COMMAND_DECK_PAIRING_LABEL || 'phone-handoff';
const ttlSecondsRaw = argValue('--ttl-seconds') || process.env.COMMAND_DECK_PAIRING_TTL_SECONDS || String(DEFAULT_TTL_SECONDS);
const ttlSeconds = Number.parseInt(ttlSecondsRaw, 10);
const token = process.env.COMMAND_DECK_API_TOKEN || '';

function fail(message) {
  console.error(`[operator-pair] fail — ${message}`);
  process.exit(1);
}

if (!token) {
  fail('COMMAND_DECK_API_TOKEN is required in the environment. Do not pass tokens in URLs or commit them.');
}

if (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 1800) {
  fail('--ttl-seconds must be between 30 and 1800');
}

const safeLabel = String(label).slice(0, 80);

let response;
try {
  response = await fetch(`${base}/api/auth/pairing-codes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-commanddeck-token': token,
    },
    body: JSON.stringify({ label: safeLabel, ttlMs: ttlSeconds * 1000 }),
  });
} catch (error) {
  fail(`could not reach ${base}: ${error.message}`);
}

const text = await response.text();
let body = null;
try {
  body = text ? JSON.parse(text) : null;
} catch {
  fail(`server returned non-JSON response: ${text.slice(0, 160)}`);
}

if (!response.ok) {
  fail(`server returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 220)}`);
}

const pairing = body?.pairing;
if (!pairing?.code || !pairing?.expiresAt) {
  fail(`server response did not include a pairing code: ${JSON.stringify(body).slice(0, 220)}`);
}

console.log('[operator-pair] ready — one-time phone/browser pairing code created');
console.log(`code: ${pairing.code}`);
console.log(`expiresAt: ${pairing.expiresAt}`);
console.log(`ttlSeconds: ${pairing.ttlSeconds}`);
console.log('warning: pairing codes are one-time secrets; do not put them in URLs, docs, screenshots, logs, or issue comments.');
