#!/usr/bin/env node
/*
 * Command Deck SSRF/private URL smoke.
 *
 * Deterministically verifies local/tailnet-only URL policy for private access,
 * lane targets, and evidence capture without opening browsers or touching
 * real network targets.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  validateEvidenceUrl,
  validateNetworkUrl,
} from '../src/url-policy.js';

const root = process.cwd();
const serverPath = path.resolve(root, 'src', 'server.js');
const token = 'ssrf-smoke-token';

const log = (label, info = '') => console.log(`[ssrf] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[ssrf FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

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
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    on() {},
  };
  return {
    res,
    bodyText: () => Buffer.concat(chunks).toString('utf8'),
  };
}

async function request(routeRequest, requestPath, options = {}) {
  const headers = {
    'content-type': 'application/json',
    host: '127.0.0.1:3000',
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
  req.end(body);
  await handler;
  return {
    status: res.statusCode,
    body: parseJsonBody(bodyText()),
  };
}

function assertThrowsPolicy(label, callback, messagePattern) {
  try {
    callback();
  } catch (error) {
    if (error.status !== 422 || !messagePattern.test(error.message || '')) {
      fail(label, `unexpected error ${JSON.stringify(error)}`);
    }
    return;
  }
  fail(label, 'expected policy rejection');
}

async function main() {
  validateNetworkUrl('http://127.0.0.1:3000');
  validateNetworkUrl('https://command-deck.example.ts.net');
  validateNetworkUrl('http://100.64.1.2:3000');
  assertThrowsPolicy('metadata IP rejected', () => validateNetworkUrl('http://169.254.169.254/latest/meta-data'), /blocked private/);
  assertThrowsPolicy('rfc1918 IP rejected', () => validateNetworkUrl('http://192.168.1.12:3000'), /blocked private/);
  assertThrowsPolicy('credential URL rejected', () => validateNetworkUrl('https://user:pass@command-deck.example.ts.net'), /credentials/);
  assertThrowsPolicy('funnel URL rejected', () => validateNetworkUrl('https://command-deck.funnel.ts.net'), /Funnel/);
  assertThrowsPolicy('unsaved evidence URL rejected', () => validateEvidenceUrl('http://127.0.0.1:5173', {
    allowedUrls: ['http://127.0.0.1:4173'],
  }), /one-time/);
  log('module policy', 'ok');

  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-ssrf-smoke-'));
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.COMMAND_DECK_API_TOKEN = token;
  process.env.COMMAND_DECK_RATE_LIMIT_DISABLED = 'true';
  let stopServer = null;
  try {
    const moduleUrl = `${pathToFileURL(serverPath).href}?ssrf-smoke=${Date.now()}`;
    const serverModule = await import(moduleUrl);
    const routeRequest = serverModule.routeRequest;
    stopServer = serverModule.stopServer;

    const project = await request(routeRequest, '/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'ssrf-smoke',
        approved: true,
        name: 'SSRF Smoke Project',
        quickLinks: [{ label: 'Safe app', url: 'http://127.0.0.1:4173/' }],
      },
    });
    if (project.status !== 201) fail('project create', JSON.stringify(project.body));
    const session = await request(routeRequest, `/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'ssrf-smoke',
        approved: true,
        name: 'SSRF Smoke Session',
      },
    });
    if (session.status !== 201) fail('session create', JSON.stringify(session.body));

    const badTargetLane = await request(routeRequest, `/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'ssrf-smoke',
        approved: true,
        title: 'Bad target',
        executorType: 'mock',
        targetUrl: 'http://169.254.169.254/latest/meta-data',
      },
    });
    if (badTargetLane.status !== 422) fail('metadata lane target must be rejected', JSON.stringify(badTargetLane.body));

    const lane = await request(routeRequest, `/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'ssrf-smoke',
        approved: true,
        title: 'Safe target',
        executorType: 'mock',
        targetUrl: 'http://127.0.0.1:4173/',
      },
    });
    if (lane.status !== 201) fail('safe lane create', JSON.stringify(lane.body));

    const badEvidence = await request(routeRequest, `/api/lanes/${lane.body.id}/evidence`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'ssrf-smoke',
        approved: true,
        url: 'http://169.254.169.254/latest/meta-data',
      },
    });
    if (badEvidence.status !== 422) fail('metadata evidence must be rejected', JSON.stringify(badEvidence.body));

    const unsavedEvidence = await request(routeRequest, `/api/lanes/${lane.body.id}/evidence`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'ssrf-smoke',
        approved: true,
        url: 'http://127.0.0.1:5173/',
      },
    });
    if (unsavedEvidence.status !== 422) fail('unsaved evidence URL must need one-time approval', JSON.stringify(unsavedEvidence.body));

    const badPrivateTarget = await request(routeRequest, '/api/private-access/targets', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'ssrf-smoke',
        label: 'Bad private target',
        mode: 'tailnet-http',
        localUrl: 'http://127.0.0.1:3000',
        tailnetHttpUrl: 'http://192.168.1.12:3000',
      },
    });
    if (badPrivateTarget.status !== 422) fail('private target rfc1918 tailnet URL must be rejected', JSON.stringify(badPrivateTarget.body));
    log('api policy', 'ok');
    log('done', 'SSRF/private URL policy verified');
  } finally {
    if (typeof stopServer === 'function') await stopServer();
    Object.keys(process.env).forEach((key) => {
      if (!(key in previousEnv)) delete process.env[key];
    });
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

await main().catch((error) => {
  console.error('[ssrf ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
});
