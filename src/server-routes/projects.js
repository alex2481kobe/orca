// Project API route group (/api/projects/*) extracted from server.js into a
// ctx-threaded handler. See server-routes/lanes.js for the ctx/FALL_THROUGH
// contract. Returns FALL_THROUGH when no project sub-route matched.

import { FALL_THROUGH } from './lanes.js';

export async function handleProjectRoutes(ctx, req, res, method, parts) {
  const {
    registry,
    sendJson,
    sendBodyError,
    parseJsonBody,
    rejectSpoofedActor,
  } = ctx;
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

    if (parts.length === 4 && (parts[3] === 'archive' || parts[3] === 'restore') && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      const nextState = parts[3] === 'archive' ? 'archived' : 'active';
      try {
        const updated = registry.updateProject(project.id, { state: nextState }, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || `Could not ${parts[3]} project.`,
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
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
      if (method === 'DELETE') {
        const body = await parseJsonBody(req).catch(() => ({}));
        if (rejectSpoofedActor(body || {}, res)) return;
        try {
          const result = await registry.deleteProject(project.id, { actor: (body && body.actor) || 'dashboard' });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, error.status || 500, { error: error.message || 'Could not delete project.' });
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

    if (parts.length >= 4 && parts[3] === 'quick-links') {
      if (parts.length === 4 && method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
        if (rejectSpoofedActor(body, res)) return;
        try {
          const result = registry.upsertProjectQuickLink(project.id, body, {
            actor: body.actor || 'dashboard',
            approved: body.approved,
          });
          return sendJson(res, 201, result);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not save quick link.',
            requiresApproval: error.requiresApproval || false,
            risk: error.risk || null,
          });
        }
      }

      let linkId = '';
      if (parts[4]) {
        try {
          linkId = decodeURIComponent(parts[4]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid URL encoding in quick link id.' });
        }
      }
      if (parts.length === 5 && method === 'PATCH') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
        if (rejectSpoofedActor(body, res)) return;
        try {
          const result = registry.upsertProjectQuickLink(project.id, { ...body, id: linkId }, {
            actor: body.actor || 'dashboard',
            approved: body.approved,
          });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not update quick link.',
            requiresApproval: error.requiresApproval || false,
            risk: error.risk || null,
          });
        }
      }

      if (parts.length === 5 && method === 'DELETE') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
        if (rejectSpoofedActor(body, res)) return;
        try {
          const result = registry.deleteProjectQuickLink(project.id, linkId, {
            actor: body.actor || 'dashboard',
            approved: body.approved,
          });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not delete quick link.',
            requiresApproval: error.requiresApproval || false,
            risk: error.risk || null,
          });
        }
      }

      if (parts.length === 6 && parts[5] === 'check' && method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
        if (rejectSpoofedActor(body, res)) return;
        try {
          const result = await registry.checkProjectQuickLink(project.id, linkId, {
            actor: body.actor || 'dashboard',
            prefer: body.prefer || 'auto',
          });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not check quick link.',
          });
        }
      }

      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

  return FALL_THROUGH;
}
