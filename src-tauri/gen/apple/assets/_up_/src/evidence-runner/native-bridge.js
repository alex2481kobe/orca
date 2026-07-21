// Evidence-capture helpers + the native (WKWebView) capture bridge. Extracted
// from evidence-runner.js; the PlaywrightEvidenceRunner lives in runner.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CAPTURE = ['screenshot'];
export const MIME_HINT = {
  screenshot: 'png',
  trace: 'zip',
  video: 'webm',
  log: 'txt',
};
export const EVIDENCE_PREFIX = 'evidence-';

function sanitizeMode(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['screenshot', 'trace', 'video', 'log'].includes(normalized)) {
    return normalized;
  }
  return null;
}

export function normalizeModes(rawModes) {
  if (!rawModes) return DEFAULT_CAPTURE;
  if (!Array.isArray(rawModes)) {
    const single = sanitizeMode(rawModes);
    return single ? [single] : DEFAULT_CAPTURE;
  }
  const dedup = new Set();
  for (const mode of rawModes) {
    const normalized = sanitizeMode(mode);
    if (normalized) dedup.add(normalized);
  }
  return dedup.size ? [...dedup] : DEFAULT_CAPTURE;
}

// lane.sessionId / lane.id are server-generated, but treat them as untrusted
// path segments anyway so a crafted/corrupt lane can never escape artifacts/.
function safePathSegment(value, fallback) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9._-]{1,128}$/.test(text) && text !== '.' && text !== '..'
    ? text
    : fallback;
}

export function resolveArtifactDir(lane) {
  const sessionSeg = safePathSegment(lane.sessionId, 'orphan');
  const laneSeg = safePathSegment(lane.id, 'unknown-lane');
  const root = path.join(process.cwd(), 'artifacts');
  const dir = path.join(root, sessionSeg, laneSeg);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw { status: 400, message: 'Invalid artifact path.' };
  }
  return dir;
}

export function nowIso() {
  return new Date().toISOString();
}

let _playwrightCache;
export async function safeImportPlaywright() {
  if (_playwrightCache !== undefined) return _playwrightCache;
  // Prefer an on-demand install location (set by the governed capture-setup
  // installer) so the read-only app bundle can stay Playwright-free. Fall back
  // to a normally-resolvable 'playwright' (source/dev installs).
  const onDemandDir = String(process.env.ORCA_PLAYWRIGHT_DIR || '').trim();
  if (onDemandDir) {
    try {
      const entry = path.join(onDemandDir, 'node_modules', 'playwright', 'index.js');
      _playwrightCache = await import(pathToFileURL(entry).href);
      return _playwrightCache;
    } catch {
      // Fall through to the default resolver.
    }
  }
  try {
    _playwrightCache = await import('playwright');
  } catch (error) {
    _playwrightCache = null;
  }
  return _playwrightCache;
}

// Optional system-browser channel (e.g. 'chrome') chosen by capture setup to
// avoid downloading Chromium. Empty => use Playwright's bundled Chromium.
export function captureChannel() {
  const channel = String(process.env.ORCA_CAPTURE_CHANNEL || '').trim();
  return /^[a-z-]{1,32}$/.test(channel) ? channel : null;
}

// Native WKWebView capture is advertised by the Tauri shell via env. The shell
// runs a loopback bridge with a shared token; we ask it to snapshot a URL to a
// file. Screenshots only — video/traces stay on Playwright.
export function nativeCaptureAvailable() {
  return Boolean(String(process.env.ORCA_NATIVE_CAPTURE_URL || '').trim());
}

// Issue the loopback POST with node:http and `agent: false` so every capture
// opens a fresh socket. The bridge (tiny_http) closes the connection after each
// response; the global fetch/undici pool would otherwise try to reuse that dead
// socket on the next capture and fail with ECONNRESET ("native-error"). A new
// connection per request sidesteps the keep-alive race entirely.
function postCaptureRequest({ endpoint, token, payload, timeoutMs }) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL('/capture', endpoint);
    } catch (error) {
      resolve({ ok: false, reason: `native-error: ${error?.message || 'bad endpoint'}` });
      return;
    }
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        agent: false, // fresh socket per request — no keep-alive reuse
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          connection: 'close',
          'x-orca-native-token': token,
        },
      },
      (res) => {
        res.resume(); // drain so the socket can close cleanly
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      },
    );
    req.setTimeout(timeoutMs + 3000, () => {
      req.destroy(new Error('native capture request timed out'));
    });
    req.on('error', (error) => {
      const timedOut = error?.message?.includes('timed out');
      resolve({ ok: false, reason: timedOut ? 'native-timeout' : `native-error: ${error?.message || 'request failed'}` });
    });
    req.end(body);
  });
}

export async function captureViaNativeBridge({ url, outPath, timeoutMs = 15000 }) {
  const endpoint = String(process.env.ORCA_NATIVE_CAPTURE_URL || '').trim();
  if (!endpoint) return { ok: false, reason: 'native-unavailable' };
  const token = String(process.env.ORCA_NATIVE_CAPTURE_TOKEN || '');
  const result = await postCaptureRequest({
    endpoint,
    token,
    payload: { url, outPath, timeoutMs },
    timeoutMs,
  });
  if (!result.ok) {
    return result.reason ? result : { ok: false, reason: `native-status-${result.status}` };
  }
  try {
    await fs.access(outPath); // the shell writes the PNG; confirm it landed
  } catch {
    return { ok: false, reason: 'native-missing-output' };
  }
  return { ok: true };
}

export async function detectPlaywright() {
  const pw = await safeImportPlaywright();
  if (!pw?.chromium) return false;
  try {
    await fs.access(pw.chromium.executablePath());
    return true;
  } catch {
    return false;
  }
}

export function outputText(payload) {
  return `${JSON.stringify(payload, null, 2)}
`;
}

export function safeFire(callback, ...args) {
  try {
    return Promise.resolve(callback(...args)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}
