import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrcaRegistry } from './registry.js';
import { PrivateAccessStore } from './private-access.js';
import { ProviderProfileStore } from './provider-profiles.js';
import {
  AuthSessionStore,
  SESSION_COOKIE_NAME,
} from './auth-sessions.js';
import {
  buildAgentToolDiscovery,
  buildNextActionEnvelope,
} from './agent-tools.js';
import {
  applyAppImport,
  buildAppExport,
  buildSupportBundle,
  validateAppImport,
} from './app-backup.js';
import { buildRouteInventory } from './route-inventory.js';
import { handleLaneRoutes, FALL_THROUGH as LANE_FALL_THROUGH } from './server-routes/lanes.js';
import { handleSessionRoutes } from './server-routes/sessions.js';
import { handleProjectRoutes } from './server-routes/projects.js';
import { handleMcpRoutes } from './server-routes/mcp.js';
import { handleNotificationRoutes } from './server-routes/notifications.js';
import { handleExecutorRoutes } from './server-routes/executors.js';
import { handleAppRoutes } from './server-routes/app.js';
import { handlePrivateAccessApi } from './server-routes/private-access.js';
import { handleProvidersApi } from './server-routes/providers.js';
import {
  classifyRequestForRateLimit,
  createRateLimiter,
} from './rate-limiter.js';
import {
  buildStreamSnapshot,
  streamHeartbeatMs,
  writeSse,
} from './event-streams.js';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.ORCA_HOST || '127.0.0.1';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const providerProfiles = new ProviderProfileStore();
const registry = new OrcaRegistry({
  credentialStore: providerProfiles.credentialStore,
  providerProfileStore: providerProfiles,
});
const privateAccess = new PrivateAccessStore();
const authSessions = new AuthSessionStore();
const rateLimiter = createRateLimiter({
  disabled: process.env.ORCA_RATE_LIMIT_DISABLED === 'true',
});
const API_TOKEN = process.env.ORCA_API_TOKEN || '';
const WORKER_TOKEN = process.env.ORCA_WORKER_TOKEN || '';
const MAX_JSON_BODY_BYTES = (() => {
  const raw = Number.parseInt(process.env.ORCA_MAX_JSON_BYTES || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 256 * 1024;
})();
const SPOOFABLE_ACTORS = new Set(['scheduler', 'system', 'cron', 'worker']);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=(self), clipboard-write=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const SENSITIVE_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, private';
const STATIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';
const requestOrigin = (req) => {
  const host = req.headers.host || `localhost:${PORT}`;
  // Only trust x-forwarded-proto from an actual proxy (Tailscale Serve). A
  // direct loopback client must not be able to spoof https and trick us into
  // setting Secure cookies over plain http or widening the same-origin check.
  const proto = (requestIsProxied(req) && req.headers['x-forwarded-proto'])
    ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
    : 'http';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
};

function applySecurityHeaders(res) {
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => {
    res.setHeader(name, value);
  });
}

function setCacheHeaders(res, value = SENSITIVE_CACHE_CONTROL) {
  res.setHeader('Cache-Control', value);
  if (value.includes('no-store')) {
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}

function staticCachePolicy(filePath) {
  const basename = path.basename(filePath || '').toLowerCase();
  const ext = path.extname(filePath || '').toLowerCase();
  if (!basename || basename === 'index.html' || basename === 'service-worker.js' || ext === '.html') {
    return SENSITIVE_CACHE_CONTROL;
  }
  return STATIC_CACHE_CONTROL;
}

function getRequestToken(req) {
  const headerToken = req.headers['x-orca-token'];
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return headerToken;
}

// Constant-time string comparison that does not leak length via early exit.
function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run a comparison against a same-length buffer to avoid an obvious
    // length-based early return; result is forced false.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function hasValidApiToken(req) {
  const token = getRequestToken(req);
  if (!token || !API_TOKEN) return false;
  return constantTimeEqual(token, API_TOKEN);
}

function sameOriginAllowed(req) {
  const origin = req.headers.origin || '';
  if (!origin) return true;
  return origin === requestOrigin(req);
}

function currentBrowserSession(req) {
  return authSessions.sessionFromCookieHeader(req.headers.cookie || '');
}

// Tailscale Serve and every reverse proxy inject these. A genuine, direct
// connection to the loopback listener (the workstation's own browser) carries
// none of them, which is how we tell "on the host" apart from "remote over the
// tailnet" even though Serve makes every proxied request appear to originate
// from 127.0.0.1.
const FORWARDED_HEADER_KEYS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
];

function requestIsProxied(req) {
  return FORWARDED_HEADER_KEYS.some((key) => Boolean(req.headers[key]));
}

function remoteAddressIsLoopback(req) {
  const addr = String(req.socket?.remoteAddress || '');
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
}

// Honored as an admin bootstrap ONLY when no API token is configured, so a
// fresh install is usable on the host itself while remote (proxied) requests
// still receive nothing until they pair. When a token is set there is no
// implicit local trust — the token or a paired session is always required.
function isLocalBootstrapAdmin(req) {
  if (API_TOKEN) return false;
  if (requestIsProxied(req)) return false;
  return remoteAddressIsLoopback(req);
}

function hasBrowserSessionAuth(req) {
  const session = currentBrowserSession(req);
  return Boolean(session && sameOriginAllowed(req));
}

// Admin = full control: host mutation, credentials, network config, devices.
function hasAdminAuth(req) {
  return hasValidApiToken(req) || isLocalBootstrapAdmin(req);
}

// Operator = workflow control plus reads. Paired browser sessions are operators
// but never admins, so a phone can run the workflow without host-level power.
function hasOperatorAuth(req) {
  return hasAdminAuth(req) || hasBrowserSessionAuth(req);
}

function getToolLeaseToken(req) {
  const token = req.headers['x-orca-tool-lease'];
  return Array.isArray(token) ? token[0] : token;
}

function toolLeaseRequirementForRoute(method, parts) {
  if (parts[0] !== 'api') return null;
  if (parts[1] === 'agent-tools' && parts[2] === 'discovery' && method === 'GET') {
    return { toolId: 'executor.capabilities' };
  }
  if (parts[1] === 'agent-tools' && parts[2] === 'next-action' && method === 'GET') {
    return { toolId: 'session.next_action' };
  }
  if (parts[1] === 'projects' && parts.length === 2 && method === 'GET') {
    return { toolId: 'project.list' };
  }
  if (parts[1] === 'projects' && parts[2] && parts.length === 3 && method === 'GET') {
    return { toolId: 'project.describe', projectId: parts[2] };
  }
  if (parts[1] === 'projects' && parts[2] && parts[3] === 'quick-links' && parts.length === 4 && method === 'PATCH') {
    return { toolId: 'project.quick_link.upsert', projectId: parts[2] };
  }
  if (parts[1] === 'projects' && parts[2] && parts[3] === 'quick-links' && parts[4] && parts.length === 5 && method === 'DELETE') {
    return { toolId: 'project.quick_link.delete', projectId: parts[2] };
  }
  if (parts[1] === 'projects' && parts[2] && parts[3] === 'quick-links' && parts[4] && parts[5] === 'check' && method === 'POST') {
    return { toolId: 'project.quick_link.health', projectId: parts[2] };
  }
  if (parts[1] === 'policy' && parts.length === 2 && method === 'GET') {
    return { toolId: 'settings.describe_effective' };
  }
  if (parts[1] === 'providers' && parts.length === 2 && method === 'GET') {
    return { toolId: 'provider.list' };
  }
  if (parts[1] === 'providers' && parts[2] && parts[3] === 'health' && method === 'GET') {
    return { toolId: 'provider.health' };
  }
  if (parts[1] === 'sessions' && parts[2] && parts.length === 3 && method === 'GET') {
    return { toolId: 'session.describe', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'lanes') {
    if (method === 'GET') return { toolId: 'session.describe', sessionId: parts[2] };
    if (method === 'POST') return { toolId: 'lane.create', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'capacity' && parts[4] === 'request' && method === 'POST') {
    return { toolId: 'capacity.request', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'capacity' && parts[4] === 'policy' && method === 'POST') {
    return { toolId: 'capacity.set_policy', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'audit-done-lanes' && method === 'POST') {
    return { toolId: 'audit.queue_all_ready', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'plan' && method === 'POST') {
    return { toolId: 'session.plan.update', sessionId: parts[2] };
  }
  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && method === 'POST') {
    return { toolIds: ['evidence.cleanup_dry_run', 'evidence.cleanup_apply'] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'heartbeat' && method === 'POST') {
    return { toolId: 'lane.heartbeat', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'submit' && method === 'POST') {
    return { toolId: 'lane.submit', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'approvals' && parts.length === 4) {
    if (method === 'POST') return { toolId: 'approval.request', laneId: parts[2] };
    if (method === 'GET') return { toolId: 'approval.list', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'approvals' && parts[4] && parts[5] === 'decide' && method === 'POST') {
    return { toolId: 'approval.respond', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'stop' && method === 'POST') {
    return { toolId: 'lane.shutdown', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'retry' && method === 'POST') {
    return { toolId: 'lane.retry', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'controls' && method === 'PATCH') {
    return { toolId: 'lane.controls.update', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'critique' && parts[4] === 'bundle' && method === 'POST') {
    return { toolId: 'critique.bundle.create', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'critique' && parts[4] === 'findings' && method === 'POST') {
    return { toolId: 'critique.findings.record', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'critique' && parts[4] === 'waive' && method === 'POST') {
    return { toolId: 'critique.waive', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'audit' && parts.length === 4 && method === 'POST') {
    return { toolId: 'audit.queue_one', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'audit' && parts[4] === 'findings' && method === 'POST') {
    return { toolId: 'audit.findings.record', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'audit' && parts[4] === 'accept' && method === 'POST') {
    return { toolId: 'audit.accept', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'audit' && parts[4] === 'request-fix' && method === 'POST') {
    return { toolId: 'audit.request_fix', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'audit' && parts[4] === 'block' && method === 'POST') {
    return { toolId: 'audit.block', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'evidence' && parts.length === 4) {
    if (method === 'GET') return { toolId: 'evidence.list', laneId: parts[2] };
    if (method === 'POST') return { toolIds: ['evidence.capture_screenshot', 'evidence.capture_video'], laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'evidence' && parts[4] === 'latest' && method === 'GET') {
    return { toolId: 'evidence.latest', laneId: parts[2] };
  }
  return null;
}

function hasSpecificToolLeaseAuth(req, requirement) {
  const token = getToolLeaseToken(req);
  if (!token) return false;
  if (!requirement) return false;
  const toolIds = Array.isArray(requirement.toolIds) ? requirement.toolIds : [requirement.toolId];
  for (const toolId of toolIds.filter(Boolean)) {
    try {
      registry.validateToolLease(token, {
        ...requirement,
        toolId,
        toolIds: undefined,
      });
      return true;
    } catch {
      // Keep checking alternate tool ids for shared routes such as evidence capture.
    }
  }
  return false;
}

function hasToolLeaseRouteAuth(req, parts) {
  const requirement = toolLeaseRequirementForRoute(req.method || 'GET', parts);
  return hasSpecificToolLeaseAuth(req, requirement);
}

function hasStreamAuth(req) {
  return hasOperatorAuth(req);
}

function hasDashboardAuth(req) {
  return hasOperatorAuth(req);
}

const UNAUTHORIZED_MESSAGE = 'Unauthorized. Pair this device from the Orca workstation, or supply a valid ORCA_API_TOKEN.';
const ADMIN_ONLY_MESSAGE = 'This action is restricted to the Orca workstation (API token or local host). Paired devices have workflow access only.';

function requireOperatorAuth(req, res) {
  if (hasOperatorAuth(req)) return true;
  sendJson(res, 401, { error: UNAUTHORIZED_MESSAGE });
  return false;
}

function requireDashboardAuth(req, res) {
  return requireOperatorAuth(req, res);
}

// Retained name for the auth/logout paths; semantics are operator-level.
function requireMutatingToken(req, res) {
  return requireOperatorAuth(req, res);
}

function requireAdminAuth(req, res) {
  if (hasAdminAuth(req)) return true;
  const status = hasOperatorAuth(req) ? 403 : 401;
  sendJson(res, status, {
    error: status === 403 ? ADMIN_ONLY_MESSAGE : UNAUTHORIZED_MESSAGE,
  });
  return false;
}

function isPublicReadApiRoute(parts) {
  if (parts[0] !== 'api' || parts.length < 2) return false;
  // Only liveness is public. /api/auth/* (including status) is dispatched
  // before this gate and self-authorizes. Every data/host route requires
  // operator auth so the tailnet URL alone yields nothing before pairing.
  return parts[1] === 'health';
}

// Authoritative workflow enforcement for agent (tool-lease) calls: refuse
// out-of-order tool calls with a 409 + nextAction envelope so the agent learns
// the required next step. Dashboard/admin calls are not routed through here.
function enforceAgentToolStateGate(req, res, parts) {
  const requirement = toolLeaseRequirementForRoute(req.method || 'GET', parts);
  if (!requirement) return true;
  const toolId = requirement.toolId
    || (Array.isArray(requirement.toolIds) ? requirement.toolIds[0] : null);
  if (!toolId) return true;
  try {
    registry.assertAgentToolAllowed(toolId, { laneId: requirement.laneId });
    return true;
  } catch (error) {
    sendJson(res, error.status || 409, {
      error: error.message || 'Tool call refused by workflow state gate.',
      nextAction: error.nextAction || null,
    });
    return false;
  }
}

function requireApiAuth(req, res, parts) {
  if (req.method === 'GET' && isPublicReadApiRoute(parts)) return true;
  if (hasToolLeaseRouteAuth(req, parts)) return enforceAgentToolStateGate(req, res, parts);
  return requireOperatorAuth(req, res);
}

function buildSessionCookie(req, sessionToken, maxAgeSeconds) {
  const secure = requestOrigin(req).startsWith('https://');
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Number.parseInt(maxAgeSeconds, 10) || 0)}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function buildClearSessionCookie(req) {
  return buildSessionCookie(req, '', 0);
}

function parseJsonBody(req, options = {}) {
  const limit = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_JSON_BODY_BYTES;
  return new Promise((resolve) => {
    let bytes = 0;
    const chunks = [];
    let exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buf.length;
      if (bytes > limit) {
        exceeded = true;
        chunks.length = 0;
        // Drain and discard the rest so a large/slow body cannot hold the socket.
        req.resume();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (exceeded) {
        req._jsonBodyTooLarge = true;
        return resolve(null);
      }
      if (!chunks.length) return resolve({});
      try {
        // Defense-in-depth against prototype pollution: a JSON reviver drops any
        // "__proto__" key (JSON.parse otherwise materializes it as an own
        // property that downstream Object.assign/spread could use to pollute).
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value) => (
          key === '__proto__' ? undefined : value
        )));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function sendBodyError(req, res) {
  if (req && req._jsonBodyTooLarge) {
    return sendJson(res, 413, {
      error: `Request body exceeds the ${MAX_JSON_BODY_BYTES}-byte limit.`,
    });
  }
  return sendJson(res, 400, { error: 'Invalid JSON.' });
}

function rejectSpoofedActor(body, res) {
  const requested = String(body?.actor || '').trim().toLowerCase();
  if (SPOOFABLE_ACTORS.has(requested)) {
    sendJson(res, 403, {
      error: `Actor "${requested}" is reserved for internal automation and may not be set from dashboard requests.`,
    });
    return true;
  }
  return false;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  applySecurityHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  setCacheHeaders(res);
  res.end(body);
}

function applyRateLimit(req, res, method, parts) {
  const rateTarget = classifyRequestForRateLimit(req, method, parts);
  const result = rateLimiter.check(rateTarget);
  res.setHeader('X-RateLimit-Policy', result.policyName);
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', result.resetAt);
  if (result.allowed) return true;
  res.setHeader('Retry-After', String(result.retryAfterSeconds));
  sendJson(res, 429, {
    error: 'Rate limit exceeded. Retry after the indicated delay.',
    rateLimit: {
      policy: result.policyName,
      limit: result.limit,
      remaining: result.remaining,
      resetAt: result.resetAt,
      retryAfterSeconds: result.retryAfterSeconds,
    },
  });
  return false;
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  applySecurityHeaders(res);
  res.setHeader('Content-Type', type);
  setCacheHeaders(res);
  res.end(String(text));
}

function handleEventStream(req, res) {
  if (!hasStreamAuth(req)) {
    return sendJson(res, 401, {
      error: 'Unauthorized stream. Supply a valid ORCA_API_TOKEN header or pair this browser session.',
    });
  }
  const searchParams = getSearchParams(req.url || '/');
  if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
  const once = searchParams.get('once') === 'true';
  const startedAt = new Date().toISOString();
  res.statusCode = 200;
  applySecurityHeaders(res);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  setCacheHeaders(res);
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Orca-Stream', 'events');
  writeSse(res, 'stream_open', {
    contractVersion: 'orca.streams.v1',
    startedAt,
    heartbeatMs: streamHeartbeatMs(),
  });
  writeSse(res, 'snapshot', buildStreamSnapshot(registry));
  if (once) {
    writeSse(res, 'stream_close', {
      reason: 'once',
      closedAt: new Date().toISOString(),
    });
    res.end();
    return undefined;
  }
  // Poll the registry revision frequently so changes are pushed live as `update`
  // events; emit `heartbeat` at the slower configured cadence as a keepalive.
  const heartbeatMs = streamHeartbeatMs();
  const pollMs = Math.max(250, Math.min(heartbeatMs, 700));
  let lastRevision = typeof registry.getStreamRevision === 'function' ? registry.getStreamRevision() : 0;
  let lastHeartbeatAt = Date.now();
  const interval = setInterval(() => {
    if (!hasStreamAuth(req)) {
      writeSse(res, 'stream_close', {
        reason: 'auth_revoked',
        closedAt: new Date().toISOString(),
      });
      clearInterval(interval);
      res.end();
      return;
    }
    const revision = typeof registry.getStreamRevision === 'function' ? registry.getStreamRevision() : 0;
    if (revision !== lastRevision) {
      lastRevision = revision;
      writeSse(res, 'update', buildStreamSnapshot(registry));
    }
    if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = Date.now();
      writeSse(res, 'heartbeat', {
        at: new Date().toISOString(),
        revision,
        counts: buildStreamSnapshot(registry).counts,
      });
    }
  }, pollMs);
  if (typeof interval.unref === 'function') interval.unref();
  const stopHeartbeat = () => clearInterval(interval);
  if (typeof res.on === 'function') res.on('close', stopHeartbeat);
  // Guard against the response 'close' not firing (client disconnect): also
  // clear on the request socket closing so the heartbeat interval can't leak.
  if (typeof req.on === 'function') req.on('close', stopHeartbeat);
  return undefined;
}

function normalizePathname(requestUrl) {
  try {
    const parsed = new URL(requestUrl, 'http://localhost');
    return decodeURIComponent(parsed.pathname || '/');
  } catch {
    return null;
  }
}

function getSearchParams(requestUrl) {
  try {
    const url = new URL(requestUrl, 'http://localhost');
    if (url.search) {
      const segments = url.search.slice(1).split('&');
      for (const segment of segments) {
        if (!segment) continue;
        const [key, value = ''] = segment.split('=');
        try {
          decodeURIComponent(key.replace(/\+/g, ' '));
          decodeURIComponent(value.replace(/\+/g, ' '));
        } catch {
          return null;
        }
      }
    }
    return url.searchParams;
  } catch {
    return null;
  }
}

async function readArtifactText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function readArtifactBuffer(filePath) {
  return fs.readFile(filePath);
}

function artifactContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return contentTypes[ext] || 'application/octet-stream';
}

async function serveStaticOrIndex(pathname, res, req = null) {
  if (!pathname || pathname === '/') {
    return serveFile('/index.html', res);
  }

  const hasExtension = pathname.includes('.');
  if (pathname.startsWith('/artifacts/')) {
    // Fail closed: artifacts (evidence, attachments, logs) are operator-gated.
    // Without a request context we cannot authenticate, so deny.
    if (!req) {
      return sendText(res, 401, 'Unauthorized');
    }
    if (!requireDashboardAuth(req, res)) {
      return;
    }

    const parts = pathname.split('/').filter(Boolean);
    if (parts.length < 4 || parts[0] !== 'artifacts') {
      return sendText(res, 404, 'Artifact not found');
    }

    // Session chat attachments: /artifacts/<sessionId>/attachments/<file>
    if (parts[2] === 'attachments') {
      const sessionId = parts[1];
      const attachmentName = parts.slice(3).join('/');
      if (!registry.getSession(sessionId) || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || !attachmentName) {
        return sendText(res, 404, 'Artifact not found');
      }
      const dir = path.join(process.cwd(), 'artifacts', sessionId, 'attachments');
      const filePath = path.join(dir, attachmentName);
      // Reject obvious traversal/absolute names up front...
      if (attachmentName.includes('..') || attachmentName.includes('\\') || path.isAbsolute(attachmentName) || !filePath.startsWith(dir + path.sep)) {
        return sendText(res, 400, 'Invalid artifact path');
      }
      // ...then confirm the real (symlink-resolved) path stays inside the dir, so
      // a symlink planted in the attachments dir can't escape the boundary.
      let realPath;
      try {
        realPath = await fs.realpath(filePath);
        const realDir = await fs.realpath(dir);
        if (realPath !== realDir && !realPath.startsWith(realDir + path.sep)) {
          return sendText(res, 400, 'Invalid artifact path');
        }
      } catch {
        return sendText(res, 404, 'Artifact file not found');
      }
      try {
        const buffer = await readArtifactBuffer(realPath);
        res.statusCode = 200;
        applySecurityHeaders(res);
        res.setHeader('Content-Type', artifactContentType(filePath));
        setCacheHeaders(res);
        return res.end(buffer);
      } catch {
        return sendText(res, 404, 'Artifact file not found');
      }
    }

    const [, , laneId, ...rest] = parts;
    const filename = rest.join('/');
    const lane = registry.getLane(laneId);
    if (!lane || !filename) {
      return sendText(res, 404, 'Artifact not found');
    }
    let requested;
    try {
      requested = await registry.getArtifactFile(lane.id, filename);
    } catch (error) {
      return sendText(res, error?.status || 404, error?.message || 'Artifact file not found');
    }
    try {
      const ext = path.extname(requested.filePath).toLowerCase();
      if (['.txt', '.json', '.log', '.js', '.css', '.html'].includes(ext)) {
        const artifactText = await readArtifactText(requested.filePath);
        return sendText(res, 200, artifactText, artifactContentType(requested.filePath));
      }
      const artifactBuffer = await readArtifactBuffer(requested.filePath);
      res.statusCode = 200;
      applySecurityHeaders(res);
      res.setHeader('Content-Type', artifactContentType(requested.filePath));
      setCacheHeaders(res);
      return res.end(artifactBuffer);
    } catch {
      return sendText(res, 404, 'Artifact file not found');
    }
  }

  if (!hasExtension) {
    return serveFile('/index.html', res);
  }
  return serveFile(pathname, res);
}

async function serveFile(filePath, res) {
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (fullPath !== PUBLIC_DIR && !fullPath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }
  try {
    const buffer = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    res.statusCode = 200;
    applySecurityHeaders(res);
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    setCacheHeaders(res, staticCachePolicy(filePath));
    res.end(buffer);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return sendText(res, 404, 'Not found');
    }
    return sendText(res, 500, 'Server error');
  }
}

function buildMobileManifest(req) {
  const origin = requestOrigin(req);
  const projects = registry.listProjects();
  const payload = {
    generatedAt: new Date().toISOString(),
    origin,
    apiTokenRequired: Boolean(API_TOKEN),
    browserSessionSupported: true,
    workerTokenRequired: Boolean(WORKER_TOKEN),
    authStatusUrl: `${origin}/api/auth/status`,
    authPairingCodeUrl: `${origin}/api/auth/pairing-codes`,
    authPairUrl: `${origin}/api/auth/pair`,
    authLogoutUrl: `${origin}/api/auth/logout`,
    authSessionsUrl: `${origin}/api/auth/sessions`,
    healthUrl: `${origin}/api/health`,
    policyUrl: `${origin}/api/policy`,
    effectiveSettingsUrl: `${origin}/api/settings/effective`,
    auditEventsUrl: `${origin}/api/audit/events`,
    pendingAuditEventsUrl: `${origin}/api/audit/events?status=pending`,
    artifactCleanupUrl: `/api/artifacts/cleanup`,
    artifactCleanupScheduleUrl: `/api/artifacts/cleanup/schedule`,
    artifactCleanupNowUrl: `/api/artifacts/cleanup/run-now`,
    executorProfilesUrl: `/api/executors/profiles`,
    providerProfilesUrl: `${origin}/api/providers`,
    providerExportUrl: `${origin}/api/providers/export`,
    executorCliInfoUrl: `/api/executors/{executor}/cli`,
    executorCliReinstallUrl: `/api/executors/{executor}/cli/reinstall`,
    mcpToolsUrl: `${origin}/api/mcp/tools`,
    notificationsUrl: `${origin}/api/notifications`,
    notificationSettingsUrl: `${origin}/api/notifications/settings`,
    appExportUrl: `${origin}/api/app/export`,
    appImportDryRunUrl: `${origin}/api/app/import/dry-run`,
    appImportApplyUrl: `${origin}/api/app/import/apply`,
    supportBundleUrl: `${origin}/api/app/support-bundle`,
    projectsUrl: `${origin}/api/projects`,
    privateAccessUrl: `${origin}/api/private-access`,
    agentToolsDiscoveryUrl: `${origin}/api/agent-tools/discovery`,
    agentToolsNextActionUrl: `${origin}/api/agent-tools/next-action`,
    agentToolsLeaseUrl: `${origin}/api/agent-tools/leases`,
    routeInventoryUrl: `${origin}/api/route-inventory`,
    eventStreamUrl: `${origin}/api/streams/events`,
    pwaManifestUrl: `${origin}/manifest.webmanifest`,
    serviceWorkerUrl: `${origin}/service-worker.js`,
    mobileManifestUrl: `${origin}/api/mobile/manifest`,
    projects: projects.map((project) => {
      const sessions = registry.listSessions(project.id);
      return {
        projectId: project.id,
        projectName: project.name,
        slug: project.slug,
        route: `${origin}${project.route}`,
        sessionsUrl: `${origin}/api/projects/${project.id}/sessions`,
        effectiveSettingsUrl: `${origin}/api/settings/effective?projectId=${encodeURIComponent(project.id)}`,
        quickLinks: project.quickLinks || [],
        sessions: sessions.map((session) => {
          const lanes = registry.listLanes(session.id);
          return {
            sessionId: session.id,
            sessionName: session.name,
            route: `${origin}${session.route}`,
            lanesUrl: `${origin}/api/sessions/${session.id}/lanes`,
            orchestratorUrl: `${origin}/api/sessions/${session.id}/orchestrator`,
            orchestratorMessagesUrl: `${origin}/api/sessions/${session.id}/orchestrator/messages`,
            capacityUrl: `${origin}/api/sessions/${session.id}/capacity`,
            capacityRequestUrl: `${origin}/api/sessions/${session.id}/capacity/request`,
            capacityPolicyUrl: `${origin}/api/sessions/${session.id}/capacity/policy`,
            effectiveSettingsUrl: `${origin}/api/settings/effective?sessionId=${encodeURIComponent(session.id)}`,
            auditEventsUrl: `${origin}/api/sessions/${session.id}/audit-events`,
            auditDoneLanesUrl: `${origin}/api/sessions/${session.id}/audit-done-lanes`,
            lanes: lanes.map((lane) => {
              const laneRoute = lane.route || `/projects/${project.slug}/sessions/${session.id}/lanes/${lane.id}`;
              return {
                laneId: lane.id,
                title: lane.title,
                state: lane.state,
                executorType: lane.executorType,
                route: `${origin}${laneRoute}`,
                detailUrl: `${origin}/api/lanes/${lane.id}`,
                effectiveSettingsUrl: `${origin}/api/settings/effective?laneId=${encodeURIComponent(lane.id)}`,
                stopUrl: `${origin}/api/lanes/${lane.id}/stop`,
                retryUrl: `${origin}/api/lanes/${lane.id}/retry`,
                heartbeatUrl: `${origin}/api/lanes/${lane.id}/heartbeat`,
                artifactsUrl: `/api/lanes/${lane.id}/artifacts`,
                evidenceUrl: `/api/lanes/${lane.id}/evidence`,
                evidenceLatestUrl: `/api/lanes/${lane.id}/evidence/latest`,
                evidencePresetsUrl: `${origin}/api/lanes/${lane.id}/evidence/presets`,
                evidenceClearUrl: `${origin}/api/lanes/${lane.id}/evidence/clear`,
                auditApi: `/api/lanes/${lane.id}/audit`,
                critiqueBundleUrl: `${origin}/api/lanes/${lane.id}/critique/bundle`,
                critiqueFindingsUrl: `${origin}/api/lanes/${lane.id}/critique/findings`,
                critiqueWaiveUrl: `${origin}/api/lanes/${lane.id}/critique/waive`,
                auditAcceptUrl: `${origin}/api/lanes/${lane.id}/audit/accept`,
                auditFindingsUrl: `${origin}/api/lanes/${lane.id}/audit/findings`,
                auditRequestFixUrl: `${origin}/api/lanes/${lane.id}/audit/request-fix`,
                auditBlockUrl: `${origin}/api/lanes/${lane.id}/audit/block`,
                auditEventsUrl: `${origin}/api/lanes/${lane.id}/audit-events`,
              };
            }),
          };
        }),
      };
    }),
  };
  return payload;
}



function getRouteParts(pathname) {
  return pathname.split('?')[0].replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
}

async function handleAuthApi(req, res, method, parts) {
  if (parts[2] === 'status' && method === 'GET') {
    let session = currentBrowserSession(req);
    // Bridge token/local-bootstrap auth to a cookie session so same-origin asset
    // loads (evidence <img>, artifact downloads) — which cannot carry the token
    // header — authenticate. Only for an already-authenticated, same-origin admin
    // browser without an existing session; never weakens auth (token holder is
    // already an admin).
    if (!session && sameOriginAllowed(req) && (hasValidApiToken(req) || isLocalBootstrapAdmin(req))) {
      try {
        const minted = authSessions.createTrustedSession({
          label: 'Workstation browser',
          userAgent: req.headers['user-agent'] || '',
          remoteAddress: req.socket?.remoteAddress || '',
        });
        res.setHeader('Set-Cookie', buildSessionCookie(req, minted.sessionToken, minted.maxAgeSeconds));
        session = minted.session;
      } catch {
        /* fall through: status still returns token-auth info */
      }
    }
    return sendJson(res, 200, {
      apiTokenRequired: Boolean(API_TOKEN),
      apiTokenAuthenticated: hasValidApiToken(req),
      browserSessionSupported: true,
      browserSessionAuthenticated: Boolean(session),
      session,
      sameOrigin: sameOriginAllowed(req),
      cookieName: SESSION_COOKIE_NAME,
      cookieSecure: requestOrigin(req).startsWith('https://'),
      origin: requestOrigin(req),
    });
  }

  if (parts[2] === 'pairing-codes' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const pairing = authSessions.createPairingCode({
        actor: body.actor || 'dashboard',
        label: body.label || 'Phone/browser pairing',
        ttlMs: body.ttlMs,
      });
      return sendJson(res, 201, {
        pairing,
        warning: 'Pairing codes are one-time secrets. Do not paste them into logs, URLs, screenshots, or docs.',
      });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not create pairing code.',
      });
    }
  }

  if (parts[2] === 'pair' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = authSessions.consumePairingCode(body.code, {
        label: body.label || 'Paired browser',
        userAgent: req.headers['user-agent'] || '',
        remoteAddress: req.socket?.remoteAddress || '',
      });
      res.setHeader('Set-Cookie', buildSessionCookie(req, result.sessionToken, result.maxAgeSeconds));
      return sendJson(res, 200, {
        paired: true,
        session: result.session,
        maxAgeSeconds: result.maxAgeSeconds,
      });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not pair browser session.',
      });
    }
  }

  if (parts[2] === 'sessions' && method === 'GET') {
    // Read-only view of paired devices; any operator may see its own device
    // set. Minting codes and revoking other devices remain admin-only.
    if (!requireOperatorAuth(req, res)) return;
    return sendJson(res, 200, {
      sessions: authSessions.listSessions(),
    });
  }

  if (parts[2] === 'logout' && method === 'POST') {
    if (!requireMutatingToken(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    // Revoking a session OTHER than your own (by id) is device management and
    // requires admin; revoking your own cookie is always allowed for an operator.
    if (body.sessionId && !requireAdminAuth(req, res)) return;
    try {
      const sessionToken = authSessions.sessionTokenFromCookieHeader(req.headers.cookie || '');
      const result = body.sessionId
        ? authSessions.revokeSessionId(String(body.sessionId), { actor: body.actor || 'dashboard' })
        : authSessions.revokeSessionToken(sessionToken, { actor: body.actor || 'dashboard' });
      res.setHeader('Set-Cookie', buildClearSessionCookie(req));
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not revoke browser session.',
      });
    }
  }

  return sendJson(res, 404, { error: 'Auth API route not found.' });
}

// Dependency bundle handed to extracted route-group handlers. The singletons
// (registry, etc.) are module-scoped, so each cache-busted test import builds a
// ctx over its own fresh instances — handlers stay stateless and importable.
const ROUTE_CTX = {
  registry,
  sendJson,
  sendText,
  sendBodyError,
  parseJsonBody,
  rejectSpoofedActor,
  getSearchParams,
  constantTimeEqual,
  hasSpecificToolLeaseAuth,
  WORKER_TOKEN,
  buildNextActionEnvelope,
  requestOrigin,
  requireAdminAuth,
  applyAppImport,
  validateAppImport,
  buildAppExport,
  buildSupportBundle,
  buildRouteInventory,
  privateAccess,
  providerProfiles,
};

async function handleApi(req, res, pathname, method, parts) {
  if (parts[0] !== 'api') {
    return serveStaticOrIndex(pathname, res, req);
  }
  if (!applyRateLimit(req, res, method, parts)) return;
  if (parts[1] === 'auth') {
    return handleAuthApi(req, res, method, parts);
  }
  // The event stream self-authorizes (operator-level) with an SSE-appropriate
  // 401 and revocation semantics, so it bypasses the generic JSON gate.
  if (parts[1] === 'streams' && parts[2] === 'events' && method === 'GET') {
    return handleEventStream(req, res);
  }
  if (!requireApiAuth(req, res, parts)) {
    return;
  }

  if (parts[1] === 'health' && method === 'GET') {
    const payload = {
      status: 'ok',
      now: new Date().toISOString(),
    };
    // Counts are workspace data; only expose them to an authorized caller.
    if (hasOperatorAuth(req)) {
      payload.counts = {
        projects: registry.projects.length,
        sessions: registry.sessions.length,
        lanes: registry.lanes.length,
        auditEvents: registry.auditEvents.length,
      };
    }
    return sendJson(res, 200, payload);
  }

  if (parts[1] === 'policy' && method === 'GET') {
    return sendJson(res, 200, { policies: registry.getPolicyMap() });
  }

  if (parts[1] === 'settings' && parts[2] === 'effective' && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) {
      return sendJson(res, 400, { error: 'Invalid request query string.' });
    }
    try {
      return sendJson(res, 200, registry.getEffectiveSettings({
        projectId: searchParams.get('projectId'),
        sessionId: searchParams.get('sessionId'),
        laneId: searchParams.get('laneId'),
      }));
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not resolve effective settings.',
      });
    }
  }

  if (parts[1] === 'settings' && ['project', 'session', 'lane'].includes(parts[2]) && parts[3] && method === 'PATCH') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = registry.updateSettingsOverrides({
        scope: parts[2],
        locator: decodeURIComponent(parts[3]),
        settingsOverrides: body.settingsOverrides || body.overrides || {},
        actor: body.actor || 'dashboard',
        approved: body.approved,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not update settings overrides.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'notifications') {
    const result = await handleNotificationRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'app') {
    const result = await handleAppRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'route-inventory' && method === 'GET') {
    return sendJson(res, 200, buildRouteInventory());
  }

  if (parts[1] === 'agent-tools') {
    if (parts[2] === 'discovery' && method === 'GET') {
      return sendJson(res, 200, buildAgentToolDiscovery(registry));
    }
    if (parts[2] === 'next-action' && method === 'GET') {
      const searchParams = getSearchParams(req.url || '/');
      if (!searchParams) {
        return sendJson(res, 400, { error: 'Invalid request query string.' });
      }
      return sendJson(res, 200, buildNextActionEnvelope(registry, {
        role: searchParams.get('role'),
        projectId: searchParams.get('projectId'),
        sessionId: searchParams.get('sessionId'),
        laneId: searchParams.get('laneId'),
      }));
    }
    if (parts[2] === 'leases' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const nextAction = buildNextActionEnvelope(registry, {
          role: body.role,
          projectId: body.projectId,
          sessionId: body.sessionId,
          laneId: body.laneId,
        });
        const result = registry.createToolLease({
          role: nextAction.role,
          projectId: nextAction.projectId,
          sessionId: nextAction.sessionId,
          laneId: nextAction.laneId,
          allowedTools: nextAction.allowedTools,
          ttlMs: body.ttlMs,
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 201, {
          ...result,
          nextAction,
        });
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not create agent tool lease.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
    return sendJson(res, 404, { error: 'Agent tool route not found.' });
  }

  if (parts[1] === 'system' && parts[2] === 'blockers' && method === 'GET') {
    try {
      const data = await registry.describeSystemBlockers();
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 500, { error: error?.message || 'Could not load blockers.' });
    }
  }

  if (parts[1] === 'private-access') {
    return handlePrivateAccessApi(ROUTE_CTX, req, res, method, parts);
  }

  if (parts[1] === 'providers') {
    return handleProvidersApi(ROUTE_CTX, req, res, method, parts);
  }

  if (parts[1] === 'executors') {
    const result = await handleExecutorRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'capture' && parts[2] === 'status' && parts.length === 3 && method === 'GET') {
    const playwrightAvailable = await registry.evidenceRunner.ensurePlaywrightDetected().catch(() => false);
    return sendJson(res, 200, registry.captureStatus({ playwrightAvailable }));
  }

  if (parts[1] === 'capture' && parts[2] === 'install' && parts.length === 3 && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.setupCaptureBackend({
        actor: body.actor || 'dashboard',
        approved: Boolean(body.approved),
        confirmed: Boolean(body.confirmed),
        preferSystemChrome: body.preferSystemChrome !== false,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not set up capture backend.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && parts.length === 3 && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.cleanupArtifacts({
        ...body,
        actor: body.actor || 'dashboard',
        // skipApproval is an internal scheduler-only flag; never honor it from a request body.
        skipApproval: false,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not run artifact cleanup.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && parts[3] === 'schedule' && method === 'GET') {
    return sendJson(res, 200, { schedule: registry.getCleanupSchedule() });
  }

  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && parts[3] === 'schedule' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.updateCleanupSchedule(body, {
        actor: body.actor || 'dashboard',
        approved: body.approved,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not update artifact cleanup schedule.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && parts[3] === 'run-now' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    const schedule = registry.getCleanupSchedule?.() || {};
    const hasSessionOverride = body && Object.prototype.hasOwnProperty.call(body, 'sessionId');
    const hasRetentionOverride = body && Object.prototype.hasOwnProperty.call(body, 'olderThanDays');
    const hasDryRunOverride = body && Object.prototype.hasOwnProperty.call(body, 'dryRun');
    const normalizedSessionId = hasSessionOverride
      ? (body.sessionId && String(body.sessionId).trim()) || null
      : schedule.sessionId;
    const normalizedRetention = hasRetentionOverride
      ? body.olderThanDays
      : schedule.olderThanDays;
    const normalizedDryRun = hasDryRunOverride
      ? body.dryRun
      : schedule.dryRun;
    const approved = body && body.approved !== undefined ? body.approved : false;
    try {
      const result = await registry.cleanupArtifacts({
        actor: body.actor || 'dashboard',
        approved: approved,
        skipApproval: false,
        sessionId: normalizedSessionId || null,
        olderThanDays: normalizedRetention ?? null,
        dryRun: Boolean(normalizedDryRun),
        confirmed: Boolean(body.confirmed),
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not run artifact cleanup.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'audit' && parts[2] === 'events' && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) {
      return sendJson(res, 400, {
        error: 'Invalid request query string.',
      });
    }
    const status = searchParams.get('status');
    return sendJson(res, 200, registry.listAuditEvents({ status }));
  }

  if (parts[1] === 'mcp') {
    const result = await handleMcpRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'projects') {
    const result = await handleProjectRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'mobile' && parts[2] === 'manifest' && method === 'GET') {
    return sendJson(res, 200, buildMobileManifest(req));
  }

  if (parts[1] === 'sessions') {
    const result = await handleSessionRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'lanes') {
    const result = await handleLaneRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'audit' && parts[2] === 'events') {
    if (parts.length === 5 && parts[4] === 'ack' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const event = registry.acknowledgeAuditEvent(parts[3], {
          actor: body.actor || 'dashboard',
          notes: body.notes,
        });
        return sendJson(res, 200, event);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not acknowledge audit event.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
    if (parts.length === 3 && method === 'GET') {
      const searchParams = getSearchParams(req.url || '/');
      if (!searchParams) {
        return sendJson(res, 400, {
          error: 'Invalid request query string.',
        });
      }
      const status = searchParams.get('status');
      return sendJson(res, 200, registry.listAuditEvents({ status }));
    }
  }

  return sendJson(res, 404, { error: 'API route not found.' });
}

function routeRequest(req, res) {
  applySecurityHeaders(res);
  const method = req.method || 'GET';
  const pathname = normalizePathname(req.url || '/');
  if (!pathname) {
    sendText(res, 400, 'Invalid request URL.');
    return Promise.resolve();
  }
  const parts = getRouteParts(pathname);
  return handleRequest(req, res, pathname, method, parts).catch((error) => {
    // Last-resort guard: never let a handler rejection hang the socket or crash
    // the process. Respond 500 if nothing has been sent yet.
    try {
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 500, { error: 'Internal server error.' });
      } else if (!res.writableEnded) {
        res.end();
      }
    } catch {
      /* socket already gone */
    }
    console.error('Unhandled request error:', error);
  });
}

async function handleRequest(req, res, pathname, method, parts) {
  if (parts[0] === 'api') {
    return handleApi(req, res, pathname, method, parts);
  }

  return serveStaticOrIndex(pathname, res, req);
}

function startServer(port = PORT, host = HOST) {
  const server = createServer(routeRequest);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const address = server.address();
      const effectivePort = typeof address === 'string' ? address : (address?.port || port);
      console.log(`Orca prototype listening at http://${host}:${effectivePort}`);
      console.log(`Dashboard route root: /`);
      console.log(`Health: /api/health`);
      resolve(server);
    });
  });
}

const thisModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisModulePath)) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function stopServer() {
  registry.stopScheduler();
  if (typeof registry.drainPendingWrites === 'function') {
    await registry.drainPendingWrites();
  }
}

export {
  routeRequest,
  handleRequest,
  startServer,
  stopServer,
};
