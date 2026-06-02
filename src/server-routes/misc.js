// Miscellaneous singleton API routes (health, policy, route-inventory,
// system blockers, audit events list/ack, mobile manifest) extracted from
// server.js. ctx-threaded; each route self-guards on parts[1]. Returns
// FALL_THROUGH when none matched so the caller continues to the global 404.

import { FALL_THROUGH } from './lanes.js';

export async function handleMiscRoutes(ctx, req, res, method, parts) {
  const {
    registry,
    sendJson,
    sendBodyError,
    parseJsonBody,
    rejectSpoofedActor,
    getSearchParams,
    hasOperatorAuth,
    buildRouteInventory,
    buildMobileManifest,
  } = ctx;
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

  if (parts[1] === 'route-inventory' && method === 'GET') {
    return sendJson(res, 200, buildRouteInventory());
  }

  if (parts[1] === 'system' && parts[2] === 'blockers' && method === 'GET') {
    try {
      const data = await registry.describeSystemBlockers();
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 500, { error: error?.message || 'Could not load blockers.' });
    }
  }

  if (parts[1] === 'system' && parts[2] === 'dirs' && parts.length === 3 && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) {
      return sendJson(res, 400, { error: 'Invalid request query string.' });
    }
    try {
      const data = await registry.listWorkstationDirs({ path: searchParams.get('path') || '' });
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not list workstation directories.' });
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

  if (parts[1] === 'mobile' && parts[2] === 'manifest' && method === 'GET') {
    return sendJson(res, 200, buildMobileManifest(req));
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

  return FALL_THROUGH;
}
