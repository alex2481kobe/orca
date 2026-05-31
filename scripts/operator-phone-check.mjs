#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_LOCAL = 'http://127.0.0.1:3000';
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
  console.log(`Usage: npm run operator:phone-check -- [--private-url <tailnet-url>] [--create-pairing-code] [--ttl-seconds 1800]\n\nRuns a live local/private readiness check and writes artifacts/operator-phone-check/phone-check-summary.json. The summary never stores API tokens, cookies, or pairing codes.`);
  process.exit(0);
}

const localBase = (argValue('--local-url') || process.env.COMMAND_DECK_LOCAL_URL || DEFAULT_LOCAL).replace(/\/$/, '');
const configuredPrivateBase = (argValue('--private-url') || process.env.COMMAND_DECK_PRIVATE_URL || '').replace(/\/$/, '');
const createPairingCode = hasFlag('--create-pairing-code') || process.env.COMMAND_DECK_CREATE_PAIRING_CODE === '1';
const ttlSeconds = Number.parseInt(argValue('--ttl-seconds') || process.env.COMMAND_DECK_PAIRING_TTL_SECONDS || String(DEFAULT_TTL_SECONDS), 10);
const token = process.env.COMMAND_DECK_API_TOKEN || '';
const root = process.cwd();
const artifactDir = path.join(root, 'artifacts', 'operator-phone-check');
const artifactPath = path.join(artifactDir, 'phone-check-summary.json');

const summary = {
  kind: 'command-deck.operator-phone-check',
  generatedAt: new Date().toISOString(),
  status: 'passed',
  localBase: redactUrl(localBase),
  privateBase: configuredPrivateBase ? redactUrl(configuredPrivateBase) : null,
  checks: [],
  pairing: {
    requested: createPairingCode,
    created: false,
    expiresAt: null,
    ttlSeconds: null,
    codeStored: false,
  },
  manualPhoneSteps: [
    'Open the private URL on a phone connected to the same tailnet.',
    'Pair with a fresh one-time code.',
    'Confirm the project rail loads.',
    'Open a project, a session, and a lane.',
    'Open settings, providers, private access, and evidence routes.',
    'Confirm no horizontal overflow or unusable controls on the phone.',
  ],
};

function record(id, status, detail = {}) {
  summary.checks.push({ id, status, ...redactDetail(detail) });
  const line = detail.message || detail.url || '';
  console.log(`[operator-phone-check] ${status} — ${id}${line ? `: ${line}` : ''}`);
  if (status === 'failed') summary.status = 'failed';
}

function redactUrl(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    const host = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
      ? url.host
      : '<private-host>';
    return `${url.protocol}//${host}${url.pathname}${url.search ? '<query>' : ''}`;
  } catch {
    return value.replace(/https?:\/\/[^\s|]+/g, (match) => redactUrl(match));
  }
}

function redactDetail(detail) {
  const redacted = {};
  for (const [key, value] of Object.entries(detail || {})) {
    redacted[key] = typeof value === 'string' ? redactUrl(value) : value;
  }
  return redacted;
}

function runTailscale(args) {
  try {
    return execFileSync('tailscale', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim();
    record(`tailscale ${args.join(' ')}`, 'failed', { message: output || error.message });
    return '';
  }
}

async function fetchJson(id, url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const text = await response.text();
    if (!response.ok) {
      record(id, 'failed', { url, message: `HTTP ${response.status} ${text.slice(0, 160)}` });
      return null;
    }
    const body = JSON.parse(text);
    record(id, 'passed', { url });
    return body;
  } catch (error) {
    record(id, 'failed', { url, message: error.message });
    return null;
  }
}

async function expectHttpStatus(id, url, expectedStatus, { forbiddenText = [] } = {}) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const text = await response.text();
    if (response.status !== expectedStatus) {
      record(id, 'failed', { url, message: `expected HTTP ${expectedStatus}, got HTTP ${response.status} ${text.slice(0, 160)}` });
      return null;
    }
    for (const marker of forbiddenText) {
      if (marker && text.includes(marker)) {
        record(id, 'failed', { url, message: `response contained forbidden marker: ${marker}` });
        return null;
      }
    }
    record(id, 'passed', { url, message: `HTTP ${expectedStatus}` });
    return text;
  } catch (error) {
    record(id, 'failed', { url, message: error.message });
    return null;
  }
}

const serve = runTailscale(['serve', 'status']);
let discoveredPrivateBase = '';
if (serve) {
  if (/tailnet only/i.test(serve) && /localhost:3000/.test(serve)) {
    record('tailscale-serve-tailnet-only', 'passed', { message: serve.replace(/\n/g, ' | ') });
    const match = serve.match(/https?:\/\/[^\s]+/);
    discoveredPrivateBase = match?.[0]?.replace(/\/$/, '') || '';
  } else {
    record('tailscale-serve-tailnet-only', 'failed', { message: serve.replace(/\n/g, ' | ') });
  }
}

const funnel = runTailscale(['funnel', 'status']);
if (funnel) {
  if (/No serve config/i.test(funnel) || /tailnet only/i.test(funnel)) {
    record('tailscale-funnel-off', 'passed', { message: 'no public Funnel exposure reported' });
  } else {
    record('tailscale-funnel-off', 'failed', { message: funnel.replace(/\n/g, ' | ') });
  }
}

const privateBase = configuredPrivateBase || discoveredPrivateBase;
summary.privateBase = privateBase || null;
summary.privateBase = privateBase ? redactUrl(privateBase) : null;
if (!privateBase) {
  record('private-url', 'failed', { message: 'set COMMAND_DECK_PRIVATE_URL or configure Tailscale Serve' });
}

const localHealth = await fetchJson('local-health', `${localBase}/api/health`);
if (localHealth?.status !== 'ok') record('local-health-body', 'failed', { message: 'health body did not report ok' });

if (privateBase) {
  const privateHealth = await fetchJson('private-health', `${privateBase}/api/health`);
  if (privateHealth?.status !== 'ok') record('private-health-body', 'failed', { message: 'health body did not report ok' });

  await expectHttpStatus('private-projects-prepair-auth', `${privateBase}/api/projects`, 401, {
    forbiddenText: ['projects', 'sessions', 'lanes'],
  });
  await expectHttpStatus('private-mobile-manifest-prepair-auth', `${privateBase}/api/mobile/manifest`, 401, {
    forbiddenText: ['projects', 'sessions', 'lanes'],
  });
}

if (createPairingCode) {
  if (!token) {
    record('pairing-code', 'failed', { message: 'COMMAND_DECK_API_TOKEN is required to create a pairing code' });
  } else if (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 1800) {
    record('pairing-code', 'failed', { message: '--ttl-seconds must be between 30 and 1800' });
  } else {
    try {
      const response = await fetch(`${localBase}/api/auth/pairing-codes`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-commanddeck-token': token,
        },
        body: JSON.stringify({ label: 'phone-check', ttlMs: ttlSeconds * 1000 }),
      });
      const body = await response.json();
      if (!response.ok || !body?.pairing?.code) {
        record('pairing-code', 'failed', { message: `HTTP ${response.status} ${JSON.stringify(body).slice(0, 180)}` });
      } else {
        summary.pairing.created = true;
        summary.pairing.expiresAt = body.pairing.expiresAt;
        summary.pairing.ttlSeconds = body.pairing.ttlSeconds;
        record('pairing-code', 'passed', { message: 'created; code printed to terminal only, not written to summary' });
        console.log(`code: ${body.pairing.code}`);
        console.log(`expiresAt: ${body.pairing.expiresAt}`);
      }
    } catch (error) {
      record('pairing-code', 'failed', { message: error.message });
    }
  }
}

mkdirSync(artifactDir, { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[operator-phone-check] summary — ${artifactPath}`);

if (summary.status !== 'passed') {
  process.exitCode = 1;
} else {
  console.log('[operator-phone-check] ready — phone-side confirmation is the remaining manual proof.');
}
