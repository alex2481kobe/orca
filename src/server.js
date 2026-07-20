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
import { handleLaneRoutes, FALL_THROUGH as LANE_FALL_THROUGH } from './server-routes/lanes.js';
import { handleSessionRoutes } from './server-routes/sessions.js';
import { handleProjectRoutes } from './server-routes/projects.js';
import { handleMcpRoutes } from './server-routes/mcp.js';
import { handleNotificationRoutes } from './server-routes/notifications.js';
import { handleExecutorRoutes } from './server-routes/executors.js';
import { handlePrivateAccessApi } from './server-routes/private-access.js';
import { handleProvidersApi } from './server-routes/providers.js';
import { handleSettingsRoutes } from './server-routes/settings.js';
import { handleAgentToolRoutes } from './server-routes/agent-tools.js';
import { handleOperatorTerminalRoutes } from './server-routes/operator-terminals.js';
import { handleCaptureRoutes } from './server-routes/capture.js';
import { handleArtifactRoutes } from './server-routes/artifacts.js';
import { handleMiscRoutes } from './server-routes/misc.js';
import { createStaticServer } from './server-routes/static-server.js';
import { createAuthApi } from './server-routes/auth-api.js';
import { createEventStream } from './server-routes/event-stream.js';
import { createLaneStream } from './server-routes/lane-stream.js';
import { createOperatorTerminalManager } from './operator-terminal.js';
import {
  classifyRequestForRateLimit,
  createRateLimiter,
} from './rate-limiter.js';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.ORCA_HOST || '127.0.0.1';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const providerProfiles = new ProviderProfileStore();
const registry = new OrcaRegistry({
  credentialStore: providerProfiles.credentialStore,
  providerProfileStore: providerProfiles,
  // Optional tuning (mainly for tests/smokes): speed up the scheduler heartbeat
  // and the mock executor's auto-complete. Unset -> registry defaults.
  heartbeatIntervalMs: Number.parseInt(process.env.ORCA_HEARTBEAT_MS, 10) || undefined,
  autoCompleteMs: Number.parseInt(process.env.ORCA_AUTO_COMPLETE_MS, 10) || undefined,
});
const operatorTerminals = createOperatorTerminalManager({ registry });
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
const MUTATING_API_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
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
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=(self), clipboard-write=(self)',
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

function applySecurityHeaders(res, req = null) {
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => {
    res.setHeader(name, value);
  });
  // HSTS ONLY over real HTTPS (Tailscale Serve with HTTPS certs). It tells browsers
  // to force HTTPS for a year — correct once the user enables HTTPS, but harmful on
  // plain http (it would pin a scheme the loopback/http setup can't serve), so gate
  // it on the actual request scheme. requestOrigin trusts x-forwarded-proto only
  // from a real proxy, so a direct http client never trips this.
  if (req && requestOrigin(req).startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
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

function requestContentType(req) {
  const raw = req.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function isJsonContentType(req) {
  const type = requestContentType(req);
  return type === 'application/json' || type.endsWith('+json');
}

function mutatingApiRequestIsSafe(req, res, method, parts) {
  if (parts[0] !== 'api' || !MUTATING_API_METHODS.has(method)) return true;
  const origin = req.headers.origin || '';
  if (origin && !sameOriginAllowed(req)) {
    sendJson(res, 403, {
      error: 'Cross-origin API mutations are not allowed.',
    });
    return false;
  }
  const contentType = requestContentType(req);
  const contentLength = String(req.headers['content-length'] || '').trim();
  const hasBodyHeader = Boolean(
    contentType
    || (contentLength && contentLength !== '0')
    || req.headers['transfer-encoding']
  );
  if (hasBodyHeader && !isJsonContentType(req)) {
    sendJson(res, 415, {
      error: 'API mutations must use Content-Type: application/json.',
    });
    return false;
  }
  return true;
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

// Loopback host names a direct (non-proxied) browser is allowed to send. A
// DNS-rebinding attack works precisely because the victim's browser connects to
// 127.0.0.1 over the loopback socket while the page's Host header stays the
// attacker's domain — so isLocalBootstrapAdmin would otherwise grant implicit
// admin to a foreign origin. Requiring the Host header to be a real loopback
// name forces a rebinding page to send Host: attacker.com, which we reject.
// Proxied requests (Tailscale Serve) carry an arbitrary tailnet Host and never
// get implicit admin (isLocalBootstrapAdmin returns false when proxied), so the
// allowlist only applies to direct connections.
const LOOPBACK_HOST_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const EXTRA_ALLOWED_HOSTS = String(process.env.ORCA_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function directHostAllowed(req) {
  // Only gate direct connections; proxied (tailnet) requests are handled by the
  // normal token/paired-session auth and carry a legitimately foreign Host.
  if (requestIsProxied(req)) return true;
  const rawHost = String(req.headers.host || '').toLowerCase().trim();
  // No Host header => not a browser (fetch/XHR always send one), so it cannot be
  // a DNS-rebinding drive-by — the only threat this gate addresses. The loopback
  // trust model already trusts non-browser local processes, so allow it.
  if (!rawHost) return true;
  const nameOnly = rawHost.startsWith('[')
    ? rawHost.slice(0, rawHost.indexOf(']') + 1) // bracketed IPv6 literal
    : rawHost.split(':')[0];
  if (LOOPBACK_HOST_NAMES.has(nameOnly)) return true;
  if (EXTRA_ALLOWED_HOSTS.includes(nameOnly) || EXTRA_ALLOWED_HOSTS.includes(rawHost)) return true;
  // Allow the configured bind host when it is an explicit non-loopback address.
  if (HOST && HOST !== '0.0.0.0' && HOST !== '::' && nameOnly === String(HOST).toLowerCase()) return true;
  return false;
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
  if (parts[1] === 'projects' && parts.length === 2 && method === 'POST') {
    return { toolId: 'project.create' };
  }
  if (parts[1] === 'projects' && parts[2] && parts.length === 3 && method === 'GET') {
    return { toolId: 'project.describe', projectId: parts[2] };
  }
  if (parts[1] === 'projects' && parts[2] && parts[3] === 'archive' && parts.length === 4 && method === 'POST') {
    return { toolId: 'project.archive', projectId: parts[2] };
  }
  if (parts[1] === 'projects' && parts[2] && parts[3] === 'restore' && parts.length === 4 && method === 'POST') {
    return { toolId: 'project.restore', projectId: parts[2] };
  }
  if (parts[1] === 'projects' && parts[2] && parts[3] === 'quick-links' && parts.length === 4 && method === 'POST') {
    return { toolId: 'project.quick_link.upsert', projectId: parts[2] };
  }
  if (parts[1] === 'projects' && parts[2] && parts[3] === 'quick-links' && parts[4] && parts.length === 5 && method === 'DELETE') {
    return { toolId: 'project.quick_link.delete', projectId: parts[2] };
  }
  if (parts[1] === 'projects' && parts[2] && parts[3] === 'quick-links' && parts[4] && parts[5] === 'check' && method === 'POST') {
    return { toolId: 'project.quick_link.health', projectId: parts[2] };
  }
  if (parts[1] === 'projects' && parts[2] && parts[3] === 'sessions' && parts.length === 4) {
    if (method === 'GET') return { toolId: 'session.list', projectId: parts[2] };
    if (method === 'POST') return { toolId: 'session.create', projectId: parts[2] };
  }
  if (parts[1] === 'settings' && ['project', 'session', 'lane'].includes(parts[2]) && parts[3] && method === 'PATCH') {
    // Scope the requirement to the targeted record so a lease pinned to one
    // project/session/lane cannot edit another's settings (and so the
    // active-orchestrator ownership gate applies to session/lane-scoped settings).
    const key = parts[2] === 'project' ? 'projectId' : parts[2] === 'session' ? 'sessionId' : 'laneId';
    return { toolId: 'settings.update', [key]: parts[3] };
  }
  if (parts[1] === 'policy' && parts.length === 2 && method === 'GET') {
    return { toolId: 'settings.describe_effective' };
  }
  if (parts[1] === 'private-access' && parts[2] === 'tailnet' && parts.length === 3 && method === 'GET') {
    return { toolId: 'tailscale.status' };
  }
  if (parts[1] === 'private-access' && parts[2] === 'setup-plan' && parts.length === 3 && method === 'GET') {
    return { toolId: 'orca.setup_guide' };
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
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'worktree-policy' && method === 'POST') {
    return { toolId: 'session.worktree_policy.update', sessionId: parts[2] };
  }
  if (parts[1] === 'supervisor' && parts[2] === 'overview' && method === 'GET') {
    return { toolId: 'supervisor.overview' };
  }
  if (parts[1] === 'supervisor' && parts[2] === 'resign' && method === 'POST') {
    return { toolId: 'supervisor.resign' };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'supervisor' && parts[4] === 'audit' && method === 'POST') {
    return { toolId: 'session.supervisor_audit', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'audit-done-lanes' && method === 'POST') {
    return { toolId: 'audit.queue_all_ready', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'plan' && method === 'POST') {
    return { toolId: 'session.plan.update', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'agent-memory' && parts.length === 4) {
    if (method === 'GET') return { toolId: 'session.memory.get', sessionId: parts[2] };
    if (method === 'PATCH') return { toolId: 'session.memory.update', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'tasks' && parts.length === 4) {
    if (method === 'GET') return { toolId: 'task.list', sessionId: parts[2] };
    if (method === 'POST') return { toolId: 'task.add', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'tasks' && parts[4] === 'bulk' && method === 'POST') {
    return { toolId: 'task.bulk_add', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'backlog' && method === 'GET') {
    return { toolId: 'backlog.status', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'events') {
    if (parts[4] === 'drain' && method === 'GET') return { toolId: 'event.drain', sessionId: parts[2] };
    if (parts[4] === 'replay' && method === 'GET') return { toolId: 'event.replay', sessionId: parts[2] };
    if (parts[4] === 'ack' && method === 'POST') return { toolId: 'event.ack', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'loops') {
    if (parts.length === 4 && method === 'GET') return { toolId: 'loop.list', sessionId: parts[2] };
    if (parts.length === 4 && method === 'POST') return { toolId: 'loop.create', sessionId: parts[2] };
    if (parts.length === 5 && method === 'GET') return { toolId: 'loop.describe', sessionId: parts[2] };
    if (parts.length === 5 && method === 'PATCH') return { toolId: 'loop.update', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'orchestrator' && parts[4] === 'enroll' && method === 'POST') {
    return { toolId: 'orchestrator.enroll', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'orchestrator' && parts[4] === 'resign' && method === 'POST') {
    return { toolId: 'orchestrator.resign', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'orchestrator' && parts.length === 4 && method === 'GET') {
    return { toolId: 'orchestrator.thread.get', sessionId: parts[2] };
  }
  if (parts[1] === 'sessions' && parts[2] && parts[3] === 'orchestrator' && parts[4] === 'status' && method === 'GET') {
    return { toolId: 'orchestrator.status', sessionId: parts[2] };
  }
  if (parts[1] === 'tasks' && parts[2] && parts.length === 3) {
    if (method === 'PATCH') return { toolId: 'task.update' };
    if (method === 'DELETE') return { toolId: 'task.delete' };
  }
  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && method === 'POST') {
    return { toolIds: ['evidence.cleanup_dry_run', 'evidence.cleanup_apply'] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts.length === 3 && method === 'GET') {
    return { toolId: 'lane.get', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'terminal-tail' && method === 'GET') {
    return { toolId: 'lane.terminal.tail', laneId: parts[2] };
  }
  if (parts[1] === 'lanes' && parts[2] && parts.length === 3 && method === 'DELETE') {
    return { toolId: 'lane.delete', laneId: parts[2] };
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

function resolveToolLeaseRequirementScope(requirement) {
  if (!requirement) return requirement;
  if (requirement.laneId) {
    if (requirement.projectId && requirement.sessionId) return requirement;
    const lane = registry.getLane(requirement.laneId);
    if (!lane) return requirement;
    return {
      ...requirement,
      projectId: requirement.projectId || lane.projectId || null,
      sessionId: requirement.sessionId || lane.sessionId || null,
    };
  }
  if (!requirement.projectId && requirement.sessionId) {
    const session = registry.getSession(requirement.sessionId);
    if (!session) return requirement;
    return {
      ...requirement,
      projectId: session.projectId || null,
    };
  }
  return requirement;
}

function hasSpecificToolLeaseAuth(req, requirement) {
  const token = getToolLeaseToken(req);
  if (!token) return false;
  if (!requirement) return false;
  const scopedRequirement = resolveToolLeaseRequirementScope(requirement);
  const toolIds = Array.isArray(scopedRequirement.toolIds) ? scopedRequirement.toolIds : [scopedRequirement.toolId];
  for (const toolId of toolIds.filter(Boolean)) {
    try {
      const lease = registry.validateToolLease(token, {
        ...scopedRequirement,
        toolId,
        toolIds: undefined,
      });
      // Stash the validated lease so the workflow gate can reuse it for the
      // ownership check instead of re-hashing + re-scanning toolLeases.
      req._toolLease = lease;
      return true;
    } catch {
      // Keep checking alternate tool ids for shared routes such as evidence capture.
    }
  }
  return false;
}

function validateToolLeaseRouteAuth(req, parts) {
  const requirement = resolveToolLeaseRequirementScope(toolLeaseRequirementForRoute(req.method || 'GET', parts));
  const token = getToolLeaseToken(req);
  if (!requirement || !token) {
    return { allowed: false, requirement, error: null };
  }
  const toolIds = Array.isArray(requirement.toolIds) ? requirement.toolIds : [requirement.toolId];
  let lastError = null;
  for (const toolId of toolIds.filter(Boolean)) {
    try {
      const lease = registry.validateToolLease(token, {
        ...requirement,
        toolId,
        toolIds: undefined,
      });
      req._toolLease = lease;
      return { allowed: true, requirement, lease, error: null };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    allowed: false,
    requirement,
    error: lastError || { status: 403, message: 'Tool lease rejected for this route.' },
  };
}

function hasStreamAuth(req) {
  return hasOperatorAuth(req);
}

function hasLaneStreamAuth(req, lane) {
  if (hasStreamAuth(req)) return true;
  if (!lane?.id) return false;
  return hasSpecificToolLeaseAuth(req, {
    toolId: 'lane.get',
    projectId: lane.projectId || null,
    sessionId: lane.sessionId || null,
    laneId: lane.id,
  });
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
  const requirement = resolveToolLeaseRequirementScope(toolLeaseRequirementForRoute(req.method || 'GET', parts));
  if (!requirement) return true;
  const toolId = requirement.toolId
    || (Array.isArray(requirement.toolIds) ? requirement.toolIds[0] : null);
  if (!toolId) return true;
  try {
    registry.assertAgentToolAllowed(toolId, { laneId: requirement.laneId });
    // Exclusive-ownership gate: once a chat has enrolled as the active
    // orchestrator, a different orchestrator lease cannot mutate the session.
    const leaseToken = getToolLeaseToken(req);
    if (leaseToken) {
      // Reuse the lease validated during auth (hasSpecificToolLeaseAuth) when present.
      let lease = req._toolLease || null;
      if (!lease) { try { lease = registry.validateToolLease(leaseToken, { toolId }); } catch { lease = null; } }
      if (lease) {
        const ownerSessionId = requirement.sessionId
          || (requirement.laneId ? registry.getLane(requirement.laneId)?.sessionId : null);
        registry.assertOrchestratorOwnership({ toolId, sessionId: ownerSessionId, lease });
      }
    }
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
  const leaseAuth = validateToolLeaseRouteAuth(req, parts);
  if (leaseAuth.allowed) return enforceAgentToolStateGate(req, res, parts);
  if (leaseAuth.error) {
    sendJson(res, leaseAuth.error.status || 403, {
      error: leaseAuth.error.message || 'Tool lease rejected.',
    });
    return false;
  }
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

const { handleEventStream } = createEventStream({
  registry, applySecurityHeaders, setCacheHeaders, sendJson, getSearchParams, hasStreamAuth,
});
const { handleLaneStream } = createLaneStream({
  registry, applySecurityHeaders, setCacheHeaders, sendJson, hasStreamAuth, hasLaneStreamAuth,
});

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

const { serveStaticOrIndex, buildMobileManifest } = createStaticServer({
  registry,
  PUBLIC_DIR,
  contentTypes,
  applySecurityHeaders,
  setCacheHeaders,
  staticCachePolicy,
  sendText,
  requireDashboardAuth,
  requestOrigin,
  API_TOKEN,
  WORKER_TOKEN,
});



function getRouteParts(pathname) {
  return pathname.split('?')[0].replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
}

const { handleAuthApi } = createAuthApi({
  registry, authSessions, sendJson, sendBodyError, parseJsonBody,
  rejectSpoofedActor, requestOrigin, sameOriginAllowed, currentBrowserSession,
  hasValidApiToken, isLocalBootstrapAdmin, requireAdminAuth, requireOperatorAuth,
  requireMutatingToken, buildSessionCookie, buildClearSessionCookie,
  API_TOKEN, WORKER_TOKEN, SESSION_COOKIE_NAME,
});

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
  getToolLeaseToken,
  WORKER_TOKEN,
  buildNextActionEnvelope,
  requestOrigin,
  requireAdminAuth,
  privateAccess,
  providerProfiles,
  buildAgentToolDiscovery,
  hasOperatorAuth,
  hasAdminAuth,
  buildMobileManifest,
  operatorTerminals,
};

async function handleApi(req, res, pathname, method, parts) {
  if (parts[0] !== 'api') {
    return serveStaticOrIndex(pathname, res, req);
  }
  if (!applyRateLimit(req, res, method, parts)) return;
  if (!mutatingApiRequestIsSafe(req, res, method, parts)) return;
  if (parts[1] === 'auth') {
    return handleAuthApi(req, res, method, parts);
  }
  // The event stream self-authorizes (operator-level) with an SSE-appropriate
  // 401 and revocation semantics, so it bypasses the generic JSON gate.
  if (parts[1] === 'streams' && parts[2] === 'events' && method === 'GET') {
    return handleEventStream(req, res);
  }
  // Per-lane live terminal stream — self-authorizing SSE (operator auth or a
  // scoped lane.get tool lease), so it bypasses the generic JSON gate just like
  // the main event stream.
  if (parts[1] === 'lanes' && parts[2] && parts[3] === 'stream' && parts.length === 4 && method === 'GET') {
    return handleLaneStream(req, res, parts[2]);
  }
  if (!requireApiAuth(req, res, parts)) {
    return;
  }

  if (await handleMiscRoutes(ROUTE_CTX, req, res, method, parts) !== LANE_FALL_THROUGH) return;


  if (parts[1] === 'settings') {
    const result = await handleSettingsRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'notifications') {
    const result = await handleNotificationRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }



  if (parts[1] === 'agent-tools') {
    const result = await handleAgentToolRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'terminals' || (parts[1] === 'sessions' && parts[3] === 'terminals')) {
    const result = await handleOperatorTerminalRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
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

  if (parts[1] === 'capture') {
    const result = await handleCaptureRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'artifacts') {
    const result = await handleArtifactRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }


  if (parts[1] === 'mcp') {
    const result = await handleMcpRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'projects') {
    const result = await handleProjectRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }


  if (parts[1] === 'sessions') {
    const result = await handleSessionRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }

  if (parts[1] === 'lanes') {
    const result = await handleLaneRoutes(ROUTE_CTX, req, res, method, parts);
    if (result !== LANE_FALL_THROUGH) return;
  }


  return sendJson(res, 404, { error: 'API route not found.' });
}

function routeRequest(req, res) {
  applySecurityHeaders(res, req); // req → adds HSTS when the request is HTTPS
  // Anti-DNS-rebinding: a direct request whose Host header is not a recognized
  // loopback/allowlisted name is rejected before any auth or handler runs. This
  // closes the rebinding path that would otherwise hand implicit local admin to
  // a foreign origin resolving to 127.0.0.1.
  if (!directHostAllowed(req)) {
    sendText(res, 403, 'Forbidden: unrecognized Host header.');
    return Promise.resolve();
  }
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
      console.log(`Orca listening at http://${host}:${effectivePort}`);
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
  // Graceful shutdown: on Ctrl-C / kill, stop the scheduler AND kill live executor
  // children before exiting, so detached agent process groups aren't orphaned.
  let shuttingDown = false;
  const gracefulShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}; stopping Orca and its executor agents…`);
    stopServer().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  // Orphan guard: when the Tauri desktop host spawns us (ORCA_DESKTOP_HOSTED), it
  // reaps us via its window-close handler — but a crash or hard kill of the host
  // bypasses that, leaving this process holding the port. The host is our parent;
  // on its death the OS reparents us (ppid changes, → 1/launchd on macOS/Linux),
  // so poll ppid and shut down cleanly when it changes. unref() so this timer
  // never keeps the process alive on its own.
  if (process.env.ORCA_DESKTOP_HOSTED === 'true') {
    const initialPpid = process.ppid;
    const parentWatch = setInterval(() => {
      if (process.ppid !== initialPpid) {
        console.error('Orca desktop host exited; shutting down embedded server.');
        stopServer().finally(() => process.exit(0));
      }
    }, 1500);
    parentWatch.unref();
  }
}

async function stopServer() {
  registry.stopScheduler();
  // Kill live executor children BEFORE we exit, or detached CLI process groups get
  // orphaned to launchd/init (the "codex/claude left running" leak).
  if (typeof registry.stopAllExecutors === 'function') {
    await registry.stopAllExecutors('server shutdown').catch(() => {});
  }
  if (operatorTerminals && typeof operatorTerminals.stopAll === 'function') {
    await operatorTerminals.stopAll('server shutdown').catch(() => {});
  }
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
