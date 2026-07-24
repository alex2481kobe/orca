// Static asset + artifact serving and the mobile manifest, extracted from
// server.js as a factory so the interdependent helpers (serveStaticOrIndex ->
// serveFile -> readArtifact*) keep their original signatures via closure. The
// caller injects request-scoped singletons + header/auth helpers, so the
// cache-busted test harness keeps fresh instances.

import fs from 'node:fs/promises';
import path from 'node:path';

export function createStaticServer(deps) {
  const {
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
  } = deps;

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
    authStatusUrl: `${origin}/api/auth/status`,
    authPairingCodeUrl: `${origin}/api/auth/pairing-codes`,
    authPairUrl: `${origin}/api/auth/pair`,
    authLogoutUrl: `${origin}/api/auth/logout`,
    authSessionsUrl: `${origin}/api/auth/sessions`,
    healthUrl: `${origin}/api/health`,
    policyUrl: `${origin}/api/policy`,
    overviewUrl: `${origin}/api/overview`,
    orchestratorsUrl: `${origin}/api/orchestrators`,
    privateAccessUrl: `${origin}/api/private-access`,
    agentToolsLeaseUrl: `${origin}/api/agent-tools/leases`,
    eventStreamUrl: `${origin}/api/streams/events`,
    pwaManifestUrl: `${origin}/manifest.webmanifest`,
    serviceWorkerUrl: `${origin}/service-worker.js`,
    mobileManifestUrl: `${origin}/api/mobile/manifest`,
    // v2: the mobile client reads the orchestrator-container overview, not a
    // per-session tree. Projects list stays for quick-link previews.
    projects: projects.map((project) => ({
      projectId: project.id,
      projectName: project.name,
      slug: project.slug || null,
      route: project.route ? `${origin}${project.route}` : null,
      quickLinks: project.quickLinks || [],
    })),
  };
  return payload;
}

  return { serveStaticOrIndex, buildMobileManifest };
}
