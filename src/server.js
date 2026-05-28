import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CommandDeckRegistry } from './registry.js';
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
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.COMMAND_DECK_HOST || '127.0.0.1';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const registry = new CommandDeckRegistry();
const privateAccess = new PrivateAccessStore();
const providerProfiles = new ProviderProfileStore();
const authSessions = new AuthSessionStore();
const API_TOKEN = process.env.COMMAND_DECK_API_TOKEN || '';
const WORKER_TOKEN = process.env.COMMAND_DECK_WORKER_TOKEN || '';
const MAX_JSON_BODY_BYTES = (() => {
  const raw = Number.parseInt(process.env.COMMAND_DECK_MAX_JSON_BYTES || '', 10);
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
const requestOrigin = (req) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
};

function getRequestToken(req) {
  const headerToken = req.headers['x-commanddeck-token'];
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return headerToken;
}

function hasValidApiToken(req) {
  const token = getRequestToken(req);
  return Boolean(token && API_TOKEN && token === API_TOKEN);
}

function sameOriginAllowed(req) {
  const origin = req.headers.origin || '';
  if (!origin) return true;
  return origin === requestOrigin(req);
}

function currentBrowserSession(req) {
  return authSessions.sessionFromCookieHeader(req.headers.cookie || '');
}

function requireMutatingToken(req, res) {
  if (!API_TOKEN) return true;
  if (req.method === 'GET') return true;
  if (hasValidApiToken(req)) return true;
  const session = currentBrowserSession(req);
  if (session && sameOriginAllowed(req)) return true;
  sendJson(res, 401, {
    error: 'Unauthorized. Supply a valid COMMAND_DECK_API_TOKEN or pair this browser with a valid Command Deck session.',
  });
  return false;
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
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-cache');
  res.end(String(text));
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

async function serveStaticOrIndex(pathname, res) {
  if (!pathname || pathname === '/') {
    return serveFile('/index.html', res);
  }

  const hasExtension = pathname.includes('.');
  if (pathname.startsWith('/artifacts/')) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length < 4 || parts[0] !== 'artifacts') {
      return sendText(res, 404, 'Artifact not found');
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
      res.setHeader('Content-Type', artifactContentType(requested.filePath));
      res.setHeader('Cache-Control', 'no-cache');
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
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, 'Forbidden');
  }
  try {
    const buffer = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
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
    projectsUrl: `${origin}/api/projects`,
    privateAccessUrl: `${origin}/api/private-access`,
    agentToolsDiscoveryUrl: `${origin}/api/agent-tools/discovery`,
    agentToolsNextActionUrl: `${origin}/api/agent-tools/next-action`,
    agentToolsLeaseUrl: `${origin}/api/agent-tools/leases`,
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
        quickLinks: project.quickLinks || [],
        sessions: sessions.map((session) => {
          const lanes = registry.listLanes(session.id);
          return {
            sessionId: session.id,
            sessionName: session.name,
            route: `${origin}${session.route}`,
            lanesUrl: `${origin}/api/sessions/${session.id}/lanes`,
            capacityUrl: `${origin}/api/sessions/${session.id}/capacity`,
            capacityRequestUrl: `${origin}/api/sessions/${session.id}/capacity/request`,
            capacityPolicyUrl: `${origin}/api/sessions/${session.id}/capacity/policy`,
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
                stopUrl: `${origin}/api/lanes/${lane.id}/stop`,
                retryUrl: `${origin}/api/lanes/${lane.id}/retry`,
                heartbeatUrl: `${origin}/api/lanes/${lane.id}/heartbeat`,
                artifactsUrl: `/api/lanes/${lane.id}/artifacts`,
                evidenceUrl: `/api/lanes/${lane.id}/evidence`,
                evidenceLatestUrl: `/api/lanes/${lane.id}/evidence/latest`,
                evidencePresetsUrl: `${origin}/api/lanes/${lane.id}/evidence/presets`,
                evidenceClearUrl: `${origin}/api/lanes/${lane.id}/evidence/clear`,
                auditApi: `/api/lanes/${lane.id}/audit`,
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

async function handlePrivateAccessApi(req, res, method, parts) {
  if (parts.length === 2 && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
    const fakeState = searchParams.get('fakeTailnetState') || searchParams.get('fake') || null;
    const data = await privateAccess.describe({
      origin: requestOrigin(req),
      fakeTailnetState: fakeState,
    });
    return sendJson(res, 200, data);
  }

  if (parts.length === 3 && parts[2] === 'tailnet' && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
    return sendJson(res, 200, privateAccess.tailnetState(searchParams.get('fake') || null));
  }

  if (parts.length === 3 && parts[2] === 'setup-plan' && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
    try {
      const plan = await privateAccess.setupPlan({
        localUrl: searchParams.get('localUrl') || requestOrigin(req),
        httpPort: searchParams.get('httpPort') || 80,
        httpsPort: searchParams.get('httpsPort') || 443,
      });
      return sendJson(res, 200, plan);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not build setup plan.' });
    }
  }

  if (parts.length === 3 && parts[2] === 'settings' && method === 'PATCH') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const settings = await privateAccess.updateSettings(body, { actor: body.actor || 'dashboard' });
      return sendJson(res, 200, settings);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not update private access settings.' });
    }
  }

  if (parts.length === 3 && parts[2] === 'targets' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const target = await privateAccess.createTarget(body, { actor: body.actor || 'dashboard' });
      return sendJson(res, 201, target);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not create private access target.' });
    }
  }

  if (parts.length === 4 && parts[2] === 'targets' && method === 'PATCH') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const target = await privateAccess.updateTarget(parts[3], body, { actor: body.actor || 'dashboard' });
      return sendJson(res, 200, target);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not update private access target.' });
    }
  }

  if (parts.length === 4 && parts[2] === 'targets' && method === 'DELETE') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await privateAccess.deleteTarget(parts[3], { actor: body.actor || 'dashboard' });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not delete private access target.' });
    }
  }

  if (parts.length === 5 && parts[2] === 'targets' && parts[4] === 'check' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await privateAccess.checkTarget(parts[3], { actor: body.actor || 'dashboard' });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not check private access target.' });
    }
  }

  return sendJson(res, 404, { error: 'Private access API route not found.' });
}

async function handleProvidersApi(req, res, method, parts) {
  if (parts.length === 2 && method === 'GET') {
    try {
      return sendJson(res, 200, await providerProfiles.listProfiles());
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not list provider profiles.' });
    }
  }

  if (parts.length === 3 && parts[2] === 'export' && method === 'GET') {
    try {
      return sendJson(res, 200, await providerProfiles.exportProfiles());
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not export provider profiles.' });
    }
  }

  if (parts.length === 4 && parts[2] === 'import' && parts[3] === 'dry-run' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      return sendJson(res, 200, await providerProfiles.importDryRun(body));
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not dry-run provider import.',
        errors: error.errors || [],
      });
    }
  }

  if (parts.length === 4 && parts[2] === 'import' && parts[3] === 'apply' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      return sendJson(res, 200, await providerProfiles.importApply(body, {
        actor: body.actor || 'dashboard',
        approved: body.approved,
      }));
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not apply provider import.',
        errors: error.errors || [],
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts.length >= 3) {
    const providerId = parts[2];
    if (parts.length === 3 && method === 'GET') {
      try {
        return sendJson(res, 200, await providerProfiles.getProfile(providerId));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load provider profile.' });
      }
    }
    if (parts.length === 3 && method === 'PATCH') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, await providerProfiles.updateProfile(providerId, body, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not update provider profile.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
    if (parts.length === 4 && parts[3] === 'health' && method === 'GET') {
      try {
        return sendJson(res, 200, await providerProfiles.health(providerId));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not check provider health.' });
      }
    }
    if (parts.length === 4 && parts[3] === 'secret' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, await providerProfiles.setSecret(providerId, body.secret, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not set provider secret.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
    if (parts.length === 4 && parts[3] === 'secret' && method === 'DELETE') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, await providerProfiles.deleteSecret(providerId, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not delete provider secret.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
  }

  return sendJson(res, 404, { error: 'Provider API route not found.' });
}

function getRouteParts(pathname) {
  return pathname.split('?')[0].replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
}

async function handleAuthApi(req, res, method, parts) {
  if (parts[2] === 'status' && method === 'GET') {
    const session = currentBrowserSession(req);
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
    if (!requireMutatingToken(req, res)) return;
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
    if (!requireMutatingToken(req, res)) return;
    return sendJson(res, 200, {
      sessions: authSessions.listSessions(),
    });
  }

  if (parts[2] === 'logout' && method === 'POST') {
    if (!requireMutatingToken(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
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

async function handleApi(req, res, pathname, method, parts) {
  if (parts[0] !== 'api') {
    return serveStaticOrIndex(pathname, res);
  }
  if (parts[1] === 'auth') {
    return handleAuthApi(req, res, method, parts);
  }
  if (!requireMutatingToken(req, res)) {
    return;
  }

  if (parts[1] === 'health' && method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok',
      now: new Date().toISOString(),
      counts: {
        projects: registry.projects.length,
        sessions: registry.sessions.length,
        lanes: registry.lanes.length,
        auditEvents: registry.auditEvents.length,
      },
    });
  }

  if (parts[1] === 'policy' && method === 'GET') {
    return sendJson(res, 200, { policies: registry.getPolicyMap() });
  }

  if (parts[1] === 'agent-tools') {
    if (parts[2] === 'discovery' && method === 'GET') {
      return sendJson(res, 200, buildAgentToolDiscovery());
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
    return handlePrivateAccessApi(req, res, method, parts);
  }

  if (parts[1] === 'providers') {
    return handleProvidersApi(req, res, method, parts);
  }

  if (parts[1] === 'executors' && parts[2] === 'profiles' && method === 'GET') {
    return sendJson(res, 200, {
      profiles: registry.getExecutorProfiles(),
      commandDeckApiEndpoint: '/api/executors/profiles',
    });
  }

  if (parts[1] === 'executors' && ['codex', 'claude'].includes(parts[2]) && parts[3] === 'cli' && method === 'GET' && parts.length === 4) {
    try {
      const info = registry.getExecutorCliInfo(parts[2]);
      return sendJson(res, 200, info);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not load executor CLI info.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'executors' && ['codex', 'claude'].includes(parts[2]) && parts[3] === 'cli' && parts[4] === 'reinstall' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.runExecutorCliReinstall(parts[2], {
        actor: body.actor || 'dashboard',
        approved: body.approved,
        execute: Boolean(body.execute),
        command: body.command,
        confirmed: body.confirmed,
        useSource: Boolean(body.useSource),
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not run CLI management action.',
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

  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 3 && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) {
      return sendJson(res, 400, {
        error: 'Invalid request query string.',
      });
    }
    const scopeRaw = searchParams.get('scope');
    const scope = String(scopeRaw || '').trim().toLowerCase();
    const tools = registry.getMcpTools(null);
    if (!scope) {
      return sendJson(res, 200, tools);
    }
    const filtered = tools.filter((tool) => Array.isArray(tool.scope) && tool.scope.includes(scope));
    return sendJson(res, 200, filtered);
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.createMcpTool(body, {
        actor: body.actor || 'dashboard',
        approved: body.approved,
      });
      return sendJson(res, 201, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not create MCP tool.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 4 && method === 'GET') {
    const tool = registry.getMcpTool(parts[3]);
    if (!tool) return sendJson(res, 404, { error: 'MCP tool not found.' });
    return sendJson(res, 200, tool);
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 4 && method === 'PATCH') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    const { actor, approved, ...patch } = body;
    try {
      const result = await registry.updateMcpTool(
        parts[3],
        patch,
        {
          actor: actor || 'dashboard',
          approved,
        },
      );
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not update MCP tool.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 4 && method === 'DELETE') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.deleteMcpTool(parts[3], {
        actor: body.actor || 'dashboard',
        approved: body.approved,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not delete MCP tool.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'projects') {
    if (parts.length === 2 && method === 'GET') {
      return sendJson(res, 200, registry.listProjects());
    }

    if (parts.length === 2 && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const project = registry.createProject(body, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        });
        return sendJson(res, 201, project);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not create project.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    const project = registry.getProject(parts[2]);
    if (!project) {
      return sendJson(res, 404, { error: 'Project not found.' });
    }

    if (parts.length === 3) {
      if (method === 'GET') return sendJson(res, 200, project);
      if (method === 'PATCH') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
        try {
          const updated = registry.updateProject(project.id, body, {
            actor: body.actor || 'dashboard',
            approved: body.approved,
          });
          return sendJson(res, 200, updated);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not update project.',
            requiresApproval: error.requiresApproval || false,
            risk: error.risk || null,
          });
        }
      }
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

    if (parts.length === 4 && parts[3] === 'sessions') {
      if (method === 'GET') return sendJson(res, 200, registry.listSessions(project.id));
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
        try {
          const session = registry.createSession(project.id, body, {
            actor: body.actor || 'dashboard',
            approved: body.approved,
          });
          return sendJson(res, 201, session);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not create session.',
            requiresApproval: error.requiresApproval || false,
            risk: error.risk || null,
          });
        }
      }
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }
  }

  if (parts[1] === 'mobile' && parts[2] === 'manifest' && method === 'GET') {
    return sendJson(res, 200, buildMobileManifest(req));
  }

  if (parts[1] === 'sessions') {
    const session = registry.getSession(parts[2]);
    if (!session) {
      return sendJson(res, 404, { error: 'Session not found.' });
    }

    if (parts.length === 3 && method === 'GET') {
      return sendJson(res, 200, session);
    }

    if (parts.length === 4 && parts[3] === 'capacity' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.getSessionCapacity(session.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load session capacity.' });
      }
    }

    if (parts.length === 5 && parts[3] === 'capacity' && parts[4] === 'request' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.requestCapacity(session.id, {
          ...body,
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 201, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not request capacity.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'capacity' && parts[4] === 'policy' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.setCapacityPolicy(session.id, {
          ...body,
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not update capacity policy.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 7 && parts[3] === 'capacity' && parts[4] === 'requests' && ['approve', 'reject'].includes(parts[6]) && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = parts[6] === 'approve'
          ? registry.approveCapacityRequest(session.id, parts[5], {
            actor: body.actor || 'dashboard',
            approved: body.approved,
            reason: body.reason,
          })
          : registry.rejectCapacityRequest(session.id, parts[5], {
            actor: body.actor || 'dashboard',
            approved: body.approved,
            reason: body.reason,
          });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not decide capacity request.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'lanes') {
      if (method === 'GET') return sendJson(res, 200, registry.listLanes(session.id));
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
        try {
          const lane = await registry.createLane(session.id, body, body);
          return sendJson(res, 201, lane);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not create lane.',
            requiresApproval: error.requiresApproval || false,
            risk: error.risk || null,
          });
        }
      }
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

    if (parts.length === 4 && parts[3] === 'audit-done-lanes' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const result = await registry.queueDoneLanesAudit(session.id, { ...body, actor: body.actor || 'dashboard' });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not queue audit.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'audit-events' && method === 'GET') {
      const searchParams = getSearchParams(req.url || '/');
      if (!searchParams) {
        return sendJson(res, 400, {
          error: 'Invalid request query string.',
        });
      }
      const status = searchParams.get('status');
      try {
        return sendJson(res, 200, registry.listAuditEvents({
          status,
          sessionId: session.id,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not list session audit events.' });
      }
    }
  }

  if (parts[1] === 'lanes') {
    const lane = registry.getLane(parts[2]);
    if (!lane) {
      return sendJson(res, 404, { error: 'Lane not found.' });
    }

    if (parts.length === 3 && method === 'GET') {
      return sendJson(res, 200, lane);
    }

    if (parts.length === 4 && parts[3] === 'stop' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const updated = await registry.stopLane(lane.id, { ...body, actor: body.actor || 'dashboard' });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not stop lane.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'retry' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const updated = registry.retryLane(lane.id, { ...body, actor: body.actor || 'dashboard' });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not retry lane.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'audit' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const audit = registry.queueLaneAudit(lane.id, { ...body, actor: body.actor || 'dashboard' });
        return sendJson(res, 201, audit);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not queue lane audit.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'audit-events' && method === 'GET') {
      const searchParams = getSearchParams(req.url || '/');
      if (!searchParams) {
        return sendJson(res, 400, {
          error: 'Invalid request query string.',
        });
      }
      const status = searchParams.get('status');
      try {
        return sendJson(res, 200, registry.listAuditEvents({
          status,
          laneId: lane.id,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not list lane audit events.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'heartbeat' && method === 'POST') {
      if (WORKER_TOKEN) {
        const workerToken = req.headers['x-commanddeck-worker-token'];
        if (!workerToken || workerToken !== WORKER_TOKEN) {
          return sendJson(res, 401, {
            error: 'Heartbeat requires the worker token (set COMMAND_DECK_WORKER_TOKEN and pass x-commanddeck-worker-token).',
          });
        }
      }
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      const actor = String(body.actor || 'worker').trim() || 'worker';
      // Heartbeat is worker-scoped; the dashboard cannot impersonate other actors here.
      try {
        const updated = await registry.touchHeartbeat(lane.id, { ...body, actor });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not touch heartbeat.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'artifacts' && method === 'GET') {
      try {
        const files = await registry.listArtifactFiles(lane.id);
        return sendJson(res, 200, {
          laneId: lane.id,
          sessionId: lane.sessionId,
          files: files.map((filename) => ({
            name: filename,
            url: `/artifacts/${lane.sessionId}/${lane.id}/${filename}`,
          })),
        });
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not list artifacts.' });
      }
    }

    if (parts.length === 5 && parts[3] === 'evidence' && parts[4] === 'presets' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.getEvidencePresets(lane.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load evidence presets.' });
      }
    }

    if (parts.length === 5 && parts[3] === 'evidence' && parts[4] === 'latest' && method === 'GET') {
      const searchParams = getSearchParams(req.url || '/');
      if (!searchParams) {
        return sendJson(res, 400, {
          error: 'Invalid request query string.',
        });
      }
      const mode = searchParams.get('mode');
      try {
        const latestEvidence = await registry.getLatestEvidence(lane.id, { mode });
        return sendJson(res, 200, latestEvidence);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load latest evidence.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'evidence' && method === 'GET') {
      try {
        const files = await registry.listArtifactFiles(lane.id);
        const evidenceFiles = files.filter((filename) => filename.startsWith('evidence-') || filename === 'evidence.json');
        return sendJson(res, 200, {
          laneId: lane.id,
          sessionId: lane.sessionId,
          files: evidenceFiles.map((filename) => ({
            name: filename,
            url: `/artifacts/${lane.sessionId}/${lane.id}/${filename}`,
          })),
        });
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not list evidence files.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'evidence' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const result = await registry.captureLaneEvidence(lane.id, {
          ...body,
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not capture evidence.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'worktree' && parts[4] === 'remove' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = await registry.removeLaneWorktree(lane.id, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
          removeBranch: Boolean(body.removeBranch),
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not remove worktree.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'evidence' && parts[4] === 'clear' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const result = await registry.clearLaneEvidenceArtifacts(lane.id, {
          ...body,
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not clear evidence artifacts.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
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
  const method = req.method || 'GET';
  const pathname = normalizePathname(req.url || '/');
  if (!pathname) {
    sendText(res, 400, 'Invalid request URL.');
    return Promise.resolve();
  }
  const parts = getRouteParts(pathname);
  return handleRequest(req, res, pathname, method, parts);
}

async function handleRequest(req, res, pathname, method, parts) {
  if (parts[0] === 'api') {
    return handleApi(req, res, pathname, method, parts);
  }

  return serveStaticOrIndex(pathname, res);
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
      console.log(`Command Deck prototype listening at http://${host}:${effectivePort}`);
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
