// Tailnet detection, setup plan, and bounded health checks. Extracted from
// private-access.js.

import { spawnSync } from 'node:child_process';
import {
  nowIso,
  normalizeText,
  normalizePort,
  validateAccessUrl,
  commandText,
  rejectPrototypeKeys,
} from './validation.js';

export function buildSetupPlan(input = {}) {
  rejectPrototypeKeys(input, 'setupPlan');
  const localPort = normalizePort(input.localPort || input.port || process.env.PORT || 3000, 3000);
  let localUrl;
  try {
    localUrl = validateAccessUrl(input.localUrl || `http://127.0.0.1:${localPort}`, {
      mode: 'local',
      field: 'localUrl',
    });
  } catch {
    localUrl = validateAccessUrl(`http://127.0.0.1:${localPort}`, {
      mode: 'local',
      field: 'localUrl',
    });
  }
  const httpsPort = normalizePort(input.httpsPort || 443, 443);
  const httpPort = normalizePort(input.httpPort || 80, 80);

  const commands = [
    {
      id: 'local',
      label: 'Local browser URL',
      mode: 'local',
      command: null,
      copyText: localUrl,
      mutatesMachine: false,
      status: 'ready',
      note: 'Use this on the host machine before tailnet setup.',
    },
    {
      id: 'tailnet-http',
      label: 'Tailscale Serve private HTTP',
      mode: 'tailnet-http',
      command: ['tailscale', 'serve', '--bg', `--http=${httpPort}`, localUrl],
      copyText: commandText(['tailscale', 'serve', '--bg', `--http=${httpPort}`, localUrl]),
      mutatesMachine: true,
      status: 'dry_run_only',
      note: 'Private to the tailnet. Tailscale encrypts transport, but browser may not treat it as a secure context.',
    },
    {
      id: 'tailnet-https-serve',
      label: 'Tailscale Serve private HTTPS',
      mode: 'tailnet-https-serve',
      command: ['tailscale', 'serve', '--bg', `--https=${httpsPort}`, localUrl],
      copyText: commandText(['tailscale', 'serve', '--bg', `--https=${httpsPort}`, localUrl]),
      mutatesMachine: true,
      status: 'dry_run_only',
      note: 'Private to the tailnet and enables browser secure-context/PWA features; .ts.net hostname metadata may appear in certificate transparency.',
    },
    {
      id: 'serve-status',
      label: 'Inspect Tailscale Serve status',
      mode: 'inspect',
      command: ['tailscale', 'serve', 'status'],
      copyText: commandText(['tailscale', 'serve', 'status']),
      mutatesMachine: false,
      status: 'read_only',
      note: 'Read-only status check.',
    },
  ];

  return {
    generatedAt: nowIso(),
    localUrl,
    httpPort,
    httpsPort,
    commands,
    docs: {
      source: 'Tailscale Serve CLI supports --http=<port>, --https=<port>, --bg, and local service targets.',
      funnelForbidden: true,
    },
  };
}

export function fakeTailnetState(state = 'missing') {
  const normalized = normalizeText(state || 'missing').toLowerCase();
  const base = {
    provider: 'fake',
    checkedAt: nowIso(),
    binaryAvailable: false,
    loggedIn: false,
    hostname: null,
    serveConfigured: false,
    serveMode: null,
    setupStatus: 'setup_pending',
    blockers: [],
    nextStep: 'Install Tailscale, sign in, then configure private Serve from the dry-run command.',
    readOnly: true,
  };
  if (normalized === 'installed') {
    return { ...base, binaryAvailable: true, nextStep: 'Sign in to Tailscale.' };
  }
  if (normalized === 'logged-in') {
    return { ...base, binaryAvailable: true, loggedIn: true, hostname: 'orca.test-tailnet.ts.net', nextStep: 'Configure Tailscale Serve.' };
  }
  if (normalized === 'serve-http') {
    return { ...base, binaryAvailable: true, loggedIn: true, hostname: 'orca.test-tailnet.ts.net', serveConfigured: true, serveMode: 'tailnet-http', setupStatus: 'configured_unchecked', nextStep: 'Open the HTTP tailnet URL from another device and mark external verification.' };
  }
  if (normalized === 'serve-https') {
    return { ...base, binaryAvailable: true, loggedIn: true, hostname: 'orca.test-tailnet.ts.net', serveConfigured: true, serveMode: 'tailnet-https-serve', setupStatus: 'configured_unchecked', nextStep: 'Open the HTTPS Serve URL from another device and verify PWA behavior.' };
  }
  if (normalized === 'funnel') {
    return { ...base, binaryAvailable: true, loggedIn: true, hostname: 'orca.test-tailnet.ts.net', serveConfigured: false, serveMode: 'funnel', setupStatus: 'unreachable', blockers: ['Funnel detected and rejected. Use private Tailscale Serve only.'], nextStep: 'Disable Funnel and configure private Serve.' };
  }
  return { ...base, blockers: ['Tailscale binary missing or not detected.'] };
}

// detectTailnetState shells out to `tailscale` up to 3-4 times (version, status
// --json, serve status). /api/private-access is polled on EVERY refresh (1-3s), so
// without a cache that's a continuous pile of synchronous subprocesses blocking the
// event loop. Tailnet state changes rarely → cache the real-probe result briefly.
let _tailnetCache = null; // { value, at }
const TAILNET_TTL_MS = 20 * 1000;

export function detectTailnetState({ fakeState = null, runner = spawnSync, localPort = process.env.PORT || 3000 } = {}) {
  if (fakeState) return fakeTailnetState(fakeState); // tests / injected — never cached
  if (runner === spawnSync && _tailnetCache && (Date.now() - _tailnetCache.at) < TAILNET_TTL_MS) {
    return _tailnetCache.value;
  }
  const value = computeTailnetState(runner, localPort);
  if (runner === spawnSync) _tailnetCache = { value, at: Date.now() };
  return value;
}

function computeTailnetState(runner, localPort) {
  const binary = runner('tailscale', ['version'], {
    encoding: 'utf8',
    timeout: 1500,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (binary.error || binary.status !== 0) return fakeTailnetState('missing');

  const status = runner('tailscale', ['status', '--json'], {
    encoding: 'utf8',
    timeout: 1500,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (status.error || status.status !== 0) {
    return {
      ...fakeTailnetState('installed'),
      provider: 'real-read-only',
      binaryAvailable: true,
      blockers: ['Tailscale status is unavailable or not logged in.'],
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(status.stdout || '{}');
  } catch {
    parsed = null;
  }
  const hostname = parsed?.Self?.DNSName ? String(parsed.Self.DNSName).replace(/\.$/, '') : null;
  // Read the ACTUAL Tailscale Serve config so we show the real reachable URL
  // (e.g. http://host.ts.net with no local port suffix — Serve proxies port
  // 80/443 to Orca's current loopback port). Without this we'd show a tailnet URL
  // with the local app port, which a phone often can't open because Orca only
  // binds loopback.
  const serve = readServeStatus(runner, { localPort });
  const setupStatus = parsed?.Self ? (serve.servedUrl ? 'serving' : 'setup_pending') : 'not_configured';
  return {
    provider: 'real-read-only',
    checkedAt: nowIso(),
    binaryAvailable: true,
    loggedIn: Boolean(parsed?.Self),
    hostname,
    serveConfigured: Boolean(serve.servedUrl),
    serveMode: serve.serveMode,
    servedUrl: serve.servedUrl,
    setupStatus,
    blockers: parsed?.Self ? [] : ['Tailscale is installed but login state could not be confirmed.'],
    nextStep: parsed?.Self
      ? (serve.servedUrl ? 'Tailscale Serve is active.' : 'Enable Tailscale Serve so other devices can reach Orca.')
      : 'Sign in to Tailscale.',
    readOnly: true,
  };
}

// Parse `tailscale serve status` to find the URL Serve actually proxies to Orca.
// Returns { servedUrl, serveMode } or empties when not serving.
function readServeStatus(runner, { localPort = process.env.PORT || 3000 } = {}) {
  try {
    const result = runner('tailscale', ['serve', 'status'], {
      encoding: 'utf8', timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true,
    });
    if (result.error || result.status !== 0) return { servedUrl: null, serveMode: null };
    const text = String(result.stdout || '');
    // Only treat it as ours if it proxies to our local Orca port.
    const port = normalizePort(localPort, 3000);
    const proxiesOrca = new RegExp(`proxy\\s+https?:\\/\\/(localhost|127\\.0\\.0\\.1):${port}(?:\\b|\\/|$)`, 'i').test(text);
    if (!proxiesOrca) return { servedUrl: null, serveMode: null };
    const httpsMatch = text.match(/https:\/\/[^\s]+\.ts\.net[^\s]*/i);
    const httpMatch = text.match(/http:\/\/[^\s]+\.ts\.net[^\s]*/i);
    const url = (httpsMatch && httpsMatch[0]) || (httpMatch && httpMatch[0]) || null;
    if (!url) return { servedUrl: null, serveMode: null };
    return { servedUrl: url.replace(/\/$/, ''), serveMode: url.startsWith('https') ? 'tailnet-https-serve' : 'tailnet-http' };
  } catch {
    return { servedUrl: null, serveMode: null };
  }
}

export async function boundedHealthCheck(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    return {
      status: response.ok ? 'reachable' : 'unreachable',
      httpStatus: response.status,
      detail: response.ok ? 'URL responded successfully.' : `URL responded with HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      status: 'unreachable',
      httpStatus: null,
      detail: error?.name === 'AbortError' ? 'Health check timed out.' : 'Health check failed.',
    };
  } finally {
    clearTimeout(timeout);
  }
}
