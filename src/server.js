import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CommandDeckRegistry } from './registry.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const registry = new CommandDeckRegistry();
const API_TOKEN = process.env.COMMAND_DECK_API_TOKEN || '';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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

function requireMutatingToken(req, res) {
  if (!API_TOKEN) return true;
  if (req.method === 'GET') return true;
  const token = getRequestToken(req);
  if (token && token === API_TOKEN) return true;
  sendJson(res, 401, {
    error: 'Unauthorized. Supply a valid COMMAND_DECK_API_TOKEN via x-commanddeck-token or Authorization: Bearer.',
  });
  return false;
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
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
  const parsed = new URL(requestUrl, 'http://localhost');
  return decodeURIComponent(parsed.pathname || '/');
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
    const [_, sessionId, laneId, filename] = pathname.split('/');
    const lane = registry.getLane(laneId);
    if (!lane || !filename) {
      return sendText(res, 404, 'Artifact not found');
    }
    const requested = await registry.getArtifactFile(lane.id, pathname.replace(`/artifacts/${sessionId}/${laneId}/`, ''));
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
      auditEventsUrl: `${origin}/api/audit/events`,
      pendingAuditEventsUrl: `${origin}/api/audit/events?status=pending`,
      artifactCleanupUrl: `${origin}/api/artifacts/cleanup`,
      artifactCleanupScheduleUrl: `${origin}/api/artifacts/cleanup/schedule`,
      artifactCleanupNowUrl: `${origin}/api/artifacts/cleanup/run-now`,
      executorProfilesUrl: `${origin}/api/executors/profiles`,
      executorCliInfoUrl: `${origin}/api/executors/{executor}/cli`,
      executorCliReinstallUrl: `${origin}/api/executors/{executor}/cli/reinstall`,
      apiTokenRequired: Boolean(API_TOKEN),
      projects: projects.map((project) => {
      const sessions = registry.listSessions(project.id);
      return {
        projectId: project.id,
        projectName: project.name,
        slug: project.slug,
        route: `${origin}${project.route}`,
        quickLinks: project.quickLinks || [],
        sessions: sessions.map((session) => {
          const lanes = registry.listLanes(session.id);
          return {
            sessionId: session.id,
            sessionName: session.name,
            route: `${origin}${session.route}`,
            lanes: lanes.map((lane) => {
              const laneRoute = lane.route || `/projects/${project.slug}/sessions/${session.id}/lanes/${lane.id}`;
              return {
                laneId: lane.id,
                title: lane.title,
                state: lane.state,
                route: `${origin}${laneRoute}`,
                artifactsUrl: `${origin}/api/lanes/${lane.id}/artifacts`,
                evidenceUrl: `${origin}/api/lanes/${lane.id}/evidence`,
                evidenceLatestUrl: `${origin}/api/lanes/${lane.id}/evidence/latest`,
                auditApi: `${origin}/api/lanes/${lane.id}/audit`,
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

async function handleApi(req, res, pathname, method, parts) {
  if (parts[0] !== 'api') {
    return serveStaticOrIndex(pathname, res);
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
    if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
    try {
      const result = await registry.runExecutorCliReinstall(parts[2], {
        actor: body.actor || 'dashboard',
        approved: body.approved,
        execute: Boolean(body.execute),
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
    if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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
    if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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
    if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
    try {
      const result = await registry.cleanupArtifacts({
        actor: body.actor || 'dashboard',
        approved: body.approved !== undefined ? body.approved : true,
        skipApproval: false,
        sessionId: body.sessionId || null,
        olderThanDays: body.olderThanDays ?? null,
        dryRun: body.dryRun === true,
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
    const status = new URL(req.url, 'http://localhost').searchParams.get('status');
    return sendJson(res, 200, registry.listAuditEvents({ status }));
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 3 && method === 'GET') {
    return sendJson(res, 200, registry.getMcpTools());
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) {
      return sendJson(res, 400, { error: 'Invalid JSON.' });
    }
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
    if (body === null) {
      return sendJson(res, 400, { error: 'Invalid JSON.' });
    }
    try {
      const result = await registry.updateMcpTool(parts[3], {
        ...body,
        actor: body.actor || 'dashboard',
        approved: body.approved,
      });
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
    if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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
      if (body === null) {
        return sendJson(res, 400, { error: 'Invalid JSON.' });
      }
      try {
        const project = registry.createProject(body);
        return sendJson(res, 201, project);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not create project.' });
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
        if (body === null) {
          return sendJson(res, 400, { error: 'Invalid JSON.' });
        }
        try {
          const updated = registry.updateProject(project.id, body, body.actor);
          return sendJson(res, 200, updated);
        } catch (error) {
          return sendJson(res, error.status || 500, { error: error.message || 'Could not update project.' });
        }
      }
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

    if (parts.length === 4 && parts[3] === 'sessions') {
      if (method === 'GET') return sendJson(res, 200, registry.listSessions(project.id));
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
        try {
          const session = registry.createSession(project.id, body);
          return sendJson(res, 201, session);
        } catch (error) {
          return sendJson(res, error.status || 500, { error: error.message || 'Could not create session.' });
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

    if (parts.length === 4 && parts[3] === 'lanes') {
      if (method === 'GET') return sendJson(res, 200, registry.listLanes(session.id));
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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
      if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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
      if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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
      if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
      try {
        const updated = registry.retryLane(lane.id, { ...body, actor: body.actor || 'dashboard' });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not retry lane.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'audit' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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

    if (parts.length === 4 && parts[3] === 'heartbeat' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
      try {
        const updated = await registry.touchHeartbeat(lane.id, { ...body, actor: body.actor || 'dashboard' });
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

    if (parts.length === 5 && parts[3] === 'evidence' && parts[4] === 'latest' && method === 'GET') {
      const mode = new URL(req.url, 'http://localhost').searchParams.get('mode');
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
      if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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

    if (parts.length === 5 && parts[3] === 'evidence' && parts[4] === 'clear' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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
      if (body === null) return sendJson(res, 400, { error: 'Invalid JSON.' });
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
      const status = new URL(req.url, 'http://localhost').searchParams.get('status');
      return sendJson(res, 200, registry.listAuditEvents({ status }));
    }
  }

  return sendJson(res, 404, { error: 'API route not found.' });
}

function routeRequest(req, res) {
  const method = req.method || 'GET';
  const pathname = normalizePathname(req.url || '/');
  const parts = getRouteParts(pathname);
  return handleRequest(req, res, pathname, method, parts);
}

async function handleRequest(req, res, pathname, method, parts) {
  if (parts[0] === 'api') {
    return handleApi(req, res, pathname, method, parts);
  }

  return serveStaticOrIndex(pathname, res);
}

const server = createServer(routeRequest);

server.listen(PORT, () => {
  console.log(`Command Deck prototype listening at http://localhost:${PORT}`);
  console.log(`Dashboard route root: /`);
  console.log(`Health: /api/health`);
});
