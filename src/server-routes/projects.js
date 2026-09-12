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
    if (parts.length === 2 && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const project = registry.createProject(body, {
          actor: req._toolLease?.actor || body.actor || 'dashboard',
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

    // POST /api/projects/{projectId}/name — rename the DISPLAY NAME.
    //
    // A dedicated sub-route, not a field on PATCH /api/projects/{id}: that one is
    // operator-only and approval-gated, and it can also change the slug (and so
    // the route). This capability is deliberately narrower than that, so it gets
    // its own address the tool-lease map can scope (server.js
    // toolLeaseRequirementForRoute -> project.rename).
    //
    // WHO the registry sees. req._toolLease is set only when the caller presented
    // a valid tool lease for THIS route; an operator (workstation token, paired
    // device, dashboard session) has none, and gets the 'dashboard' pseudo-id that
    // renameProject treats as operator authority. A lease acts as its owner, so a
    // lease obtained from a refresh credential still owns what that credential
    // registered.
    if (parts.length === 4 && parts[3] === 'name' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const renamed = registry.renameProject(project.id, { name: body.name }, {
          actor: req._toolLease?.actor || body.actor || 'dashboard',
          leaseId: req._toolLease ? (req._toolLease.ownerId || req._toolLease.id) : 'dashboard',
        });
        return sendJson(res, 200, renamed);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not rename project.' });
      }
    }

    if (parts.length === 4 && (parts[3] === 'archive' || parts[3] === 'restore') && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      const nextState = parts[3] === 'archive' ? 'archived' : 'active';
      try {
        const updated = registry.updateProject(project.id, { state: nextState }, {
          actor: req._toolLease?.actor || body.actor || 'dashboard',
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
        const body = await parseJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return sendBodyError(req, res);
        if (rejectSpoofedActor(body, res)) return;
        try {
          const result = await registry.deleteProject(project.id, {
            actor: req._toolLease?.actor || body.actor || 'dashboard',
            approved: body.approved,
          });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not delete project.',
            requiresApproval: error.requiresApproval || false,
            risk: error.risk || null,
          });
        }
      }
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

    // v2: sessions are gone. Orchestrators register implicitly via POST
    // /api/orchestrators (keyed by cwd); executor lanes live under the orchestrator
    // container, not a project/session sub-route.

    if (parts.length >= 4 && parts[3] === 'quick-links') {
      if (parts.length === 4 && method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
        if (rejectSpoofedActor(body, res)) return;
        try {
          const result = registry.upsertProjectQuickLink(project.id, body, {
            actor: req._toolLease?.actor || body.actor || 'dashboard',
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
            actor: req._toolLease?.actor || body.actor || 'dashboard',
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

      // (No DELETE and no /check: one write path is the whole preview surface.)
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

  return FALL_THROUGH;
}
