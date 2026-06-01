#!/usr/bin/env node
/*
 * Orca security-header smoke.
 *
 * Verifies centralized response headers for browser remote-control safety:
 * CSP/frame/permissions headers on all surfaces, no-store on sensitive API,
 * auth, stream, and artifact responses, and short-lived caching only for safe
 * static assets.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const root = process.cwd();
const token = 'security-header-smoke-token';
const serverPath = path.resolve(root, 'src', 'server.js');

const log = (label, info = '') => console.log(`[security-headers] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[security-headers FAIL] ${label}${info ? ' — ' + info : ''}`);
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
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
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
  if (body === undefined) {
    req.end();
  } else {
    req.end(body);
  }
  await handler;

  const text = bodyText();
  return {
    status: res.statusCode,
    headers: res.headers,
    text,
    body: parseJsonBody(text),
  };
}

function assertSecurityHeaders(label, headers) {
  const csp = headers['content-security-policy'] || '';
  const requiredCsp = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "connect-src 'self'",
  ];
  for (const marker of requiredCsp) {
    if (!csp.includes(marker)) fail(`${label} missing CSP marker`, marker);
  }
  if (headers['x-frame-options'] !== 'DENY') fail(`${label} missing X-Frame-Options DENY`);
  if (headers['x-content-type-options'] !== 'nosniff') fail(`${label} missing nosniff`);
  if (headers['referrer-policy'] !== 'no-referrer') fail(`${label} missing no-referrer`);
  if (!String(headers['permissions-policy'] || '').includes('camera=()')) fail(`${label} missing Permissions-Policy camera block`);
  if (!String(headers['permissions-policy'] || '').includes('microphone=()')) fail(`${label} missing Permissions-Policy microphone block`);
  if (headers['cross-origin-opener-policy'] !== 'same-origin') fail(`${label} missing COOP same-origin`);
  if (headers['cross-origin-resource-policy'] !== 'same-origin') fail(`${label} missing CORP same-origin`);
  if ('access-control-allow-origin' in headers) fail(`${label} must not emit permissive CORS`);
}

function assertSensitiveCache(label, headers) {
  const cache = headers['cache-control'] || '';
  if (!cache.includes('no-store')) fail(`${label} must be no-store`, cache);
  if (!cache.includes('private')) fail(`${label} must be private`, cache);
  if (headers.pragma !== 'no-cache') fail(`${label} must set pragma no-cache`);
  if (headers.expires !== '0') fail(`${label} must set expires 0`);
}

function assertStaticCache(label, headers) {
  const cache = headers['cache-control'] || '';
  if (!cache.includes('public')) fail(`${label} static asset should use public cache`, cache);
  if (!cache.includes('max-age=300')) fail(`${label} static asset cache must be short-lived`, cache);
  if (cache.includes('no-store')) fail(`${label} static asset should not be no-store`, cache);
}

async function main() {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-security-headers-'));
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';

  let stopServer = null;
  try {
    const moduleUrl = `${pathToFileURL(serverPath).href}?security-headers-smoke=${Date.now()}`;
    const serverModule = await import(moduleUrl);
    const routeRequest = serverModule.routeRequest;
    stopServer = serverModule.stopServer;
    if (typeof routeRequest !== 'function') fail('server must export routeRequest');

    const checks = [
      ['app shell', await request(routeRequest, '/')],
      ['static app.js', await request(routeRequest, '/app.js')],
      ['service worker', await request(routeRequest, '/service-worker.js')],
      ['health API', await request(routeRequest, '/api/health')],
      ['auth status API', await request(routeRequest, '/api/auth/status')],
      ['mobile manifest API', await request(routeRequest, '/api/mobile/manifest', { headers: { 'x-orca-token': token } })],
    ];

    for (const [label, response] of checks) {
      if (response.status !== 200) fail(`${label} expected 200`, String(response.status));
      assertSecurityHeaders(label, response.headers);
    }
    assertSensitiveCache('app shell', checks[0][1].headers);
    assertStaticCache('static app.js', checks[1][1].headers);
    assertSensitiveCache('service worker', checks[2][1].headers);
    assertSensitiveCache('health API', checks[3][1].headers);
    assertSensitiveCache('auth status API', checks[4][1].headers);
    assertSensitiveCache('mobile manifest API', checks[5][1].headers);

    const pairing = await request(routeRequest, '/api/auth/pairing-codes', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'security-smoke',
        label: 'header smoke browser',
      },
    });
    if (pairing.status !== 201) fail('pairing code create expected 201', JSON.stringify(pairing.body));
    assertSecurityHeaders('pairing create', pairing.headers);
    assertSensitiveCache('pairing create', pairing.headers);
    if (JSON.stringify(pairing.body).includes(token)) fail('pairing response leaked API token');

    const paired = await request(routeRequest, '/api/auth/pair', {
      method: 'POST',
      body: {
        actor: 'security-smoke',
        code: pairing.body?.pairing?.code,
        label: 'header smoke phone',
      },
    });
    if (paired.status !== 200) fail('browser pair expected 200', JSON.stringify(paired.body));
    assertSecurityHeaders('pair browser', paired.headers);
    assertSensitiveCache('pair browser', paired.headers);
    const cookie = paired.headers['set-cookie'] || '';
    if (!cookie.includes('HttpOnly')) fail('paired browser cookie must be HttpOnly');
    if (!cookie.includes('SameSite=Strict')) fail('paired browser cookie must be SameSite=Strict');
    if (JSON.stringify(paired.body).includes('sessionToken')) fail('pair response leaked raw session token');

    const crossOrigin = await request(routeRequest, '/api/projects', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://evil.example',
      },
      body: {
        actor: 'security-smoke',
        approved: true,
        name: 'Cross Origin Should Fail',
      },
    });
    if (crossOrigin.status !== 401) fail('cross-origin cookie mutation must be unauthorized', String(crossOrigin.status));
    assertSecurityHeaders('cross-origin refusal', crossOrigin.headers);
    assertSensitiveCache('cross-origin refusal', crossOrigin.headers);

    const stream = await request(routeRequest, '/api/streams/events?once=true', {
      headers: { 'x-orca-token': token },
    });
    if (stream.status !== 200) fail('event stream once expected 200', String(stream.status));
    assertSecurityHeaders('event stream', stream.headers);
    assertSensitiveCache('event stream', stream.headers);
    if (stream.headers['content-type'] !== 'text/event-stream; charset=utf-8') fail('event stream content type mismatch', stream.headers['content-type']);

    log('checked', `${checks.length + 4} route/header surfaces`);
    log('done', 'security headers and cache policy verified');
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
  console.error('[security-headers ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
});
