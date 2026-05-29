#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const DEFAULT_LOCAL = 'http://127.0.0.1:3000';
const DEFAULT_TAILSCALE = 'http://alexs-mac-mini.tailf87358.ts.net';

const localBase = (process.env.COMMAND_DECK_LOCAL_URL || DEFAULT_LOCAL).replace(/\/$/, '');
const privateBase = (process.env.COMMAND_DECK_PRIVATE_URL || DEFAULT_TAILSCALE).replace(/\/$/, '');

function ok(label, detail) {
  console.log(`[operator-status] ok — ${label}${detail ? `: ${detail}` : ''}`);
}

function warn(label, detail) {
  console.log(`[operator-status] warn — ${label}${detail ? `: ${detail}` : ''}`);
}

function fail(label, detail) {
  console.error(`[operator-status] fail — ${label}${detail ? `: ${detail}` : ''}`);
  process.exitCode = 1;
}

async function fetchJson(label, url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const text = await response.text();
    if (!response.ok) {
      fail(label, `HTTP ${response.status} ${text.slice(0, 160)}`);
      return null;
    }
    const body = JSON.parse(text);
    if (body.status !== 'ok') {
      fail(label, `unexpected body ${JSON.stringify(body).slice(0, 160)}`);
      return null;
    }
    ok(label, `projects=${body.counts?.projects ?? 'n/a'} sessions=${body.counts?.sessions ?? 'n/a'} lanes=${body.counts?.lanes ?? 'n/a'}`);
    return body;
  } catch (error) {
    fail(label, error.message);
    return null;
  }
}

function runTailscale(args) {
  try {
    return execFileSync('tailscale', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim();
    fail(`tailscale ${args.join(' ')}`, output || error.message);
    return '';
  }
}

await fetchJson('local health', `${localBase}/api/health`);
await fetchJson('private health', `${privateBase}/api/health`);

const serve = runTailscale(['serve', 'status']);
if (serve) {
  if (/tailnet only/i.test(serve) && /localhost:3000/.test(serve)) {
    ok('tailscale serve', serve.replace(/\n/g, ' | '));
  } else {
    fail('tailscale serve', `unexpected config: ${serve.replace(/\n/g, ' | ')}`);
  }
}

const funnel = runTailscale(['funnel', 'status']);
if (funnel) {
  if (/No serve config/i.test(funnel) || /tailnet only/i.test(funnel)) {
    ok('tailscale funnel', 'no public Funnel exposure reported');
  } else {
    fail('tailscale funnel', `review output: ${funnel.replace(/\n/g, ' | ')}`);
  }
} else if (!process.exitCode) {
  warn('tailscale funnel', 'no output returned');
}

if (!process.exitCode) {
  console.log(`[operator-status] ready — open ${privateBase}/ on a phone in the same tailnet and pair with a fresh one-time code.`);
}
