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
    WORKER_TOKEN,
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

  return { serveStaticOrIndex, buildMobileManifest };
}
