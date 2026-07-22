#!/usr/bin/env node
/*
 * Orca SSRF/private URL smoke.
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
  validateNetworkUrl('https://orca.example.ts.net');
  validateNetworkUrl('http://100.64.1.2:3000');
  assertThrowsPolicy('metadata IP rejected', () => validateNetworkUrl('http://169.254.169.254/latest/meta-data'), /blocked private/);
  assertThrowsPolicy('rfc1918 IP rejected', () => validateNetworkUrl('http://192.168.1.12:3000'), /blocked private/);
  assertThrowsPolicy('credential URL rejected', () => validateNetworkUrl('https://user:pass@orca.example.ts.net'), /credentials/);
  assertThrowsPolicy('funnel URL rejected', () => validateNetworkUrl('https://orca.funnel.ts.net'), /Funnel/);
  assertThrowsPolicy('unsaved evidence URL rejected', () => validateEvidenceUrl('http://127.0.0.1:5173', {
    allowedUrls: ['http://127.0.0.1:4173'],
  }), /one-time/);
  log('module policy', 'ok');

  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-ssrf-smoke-'));
  const realTempDir = await fs.realpath(tempDir);
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  process.env.ORCA_REPO_ROOTS = realTempDir;
  let stopServer = null;
  try {
    const moduleUrl = `${pathToFileURL(serverPath).href}?ssrf-smoke=${Date.now()}`;
    const serverModule = await import(moduleUrl);
    const routeRequest = serverModule.routeRequest;
    stopServer = serverModule.stopServer;

    // v2: no session container. Register an orchestrator by cwd (implicitly
    // creating the project keyed by cwd) and spawn executor lanes under it. The
    // lane's targetUrl still runs through the same validateNetworkUrl SSRF policy.
    const register = await request(routeRequest, '/api/orchestrators', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'ssrf-smoke',
        cwd: realTempDir,
        title: 'SSRF Smoke Orchestrator',
      },
    });
    if (register.status !== 200 || !String(register.body?.id || '').startsWith('orc_')) {
      fail('orchestrator register', JSON.stringify(register.body));
    }
    const orchestratorId = register.body.id;

    const badTargetLane = await request(routeRequest, `/api/orchestrators/${orchestratorId}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'ssrf-smoke',
        approved: true,
        title: 'Bad target',
        role: 'executor',
        executorType: 'mock',
        targetUrl: 'http://169.254.169.254/latest/meta-data',
      },
    });
    if (badTargetLane.status !== 422) fail('metadata lane target must be rejected', JSON.stringify(badTargetLane.body));

    const lane = await request(routeRequest, `/api/orchestrators/${orchestratorId}/executors`, {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'ssrf-smoke',
        approved: true,
        title: 'Safe target',
        role: 'executor',
        executorType: 'mock',
        targetUrl: 'http://127.0.0.1:4173/',
      },
    });
    if (lane.status !== 201) fail('safe lane create', JSON.stringify(lane.body));

    const badPrivateTarget = await request(routeRequest, '/api/private-access/targets', {
      method: 'POST',
      headers: { 'x-orca-token': token },
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
