// agent-tools API route group extracted from server.js. ctx-threaded; the route
// checks self-guard on parts[1] so the caller gates on parts[1]==='agent-tools'.

import { FALL_THROUGH } from './lanes.js';

export async function handleAgentToolRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, getSearchParams, buildAgentToolDiscovery, buildNextActionEnvelope, requireAdminAuth } = ctx;
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
    if (parts[2] === 'leases' && parts.length === 3 && method === 'GET') {
      const searchParams = getSearchParams(req.url || '/');
      if (!searchParams) {
        return sendJson(res, 400, { error: 'Invalid request query string.' });
      }
      const activeOnly = searchParams.get('activeOnly') !== 'false';
      return sendJson(res, 200, { leases: registry.listToolLeases({ activeOnly }) });
    }
    if (parts[2] === 'leases' && parts.length === 4 && method === 'DELETE') {
      if (!requireAdminAuth(req, res)) return;
      try {
        const lease = registry.revokeToolLease(parts[3], { actor: 'dashboard' });
        return sendJson(res, 200, { lease });
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not revoke agent tool lease.',
        });
      }
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
        // Orchestrator/supervisor leases are off-origin host credentials that
        // /api/mcp/orchestrator-bootstrap gates behind ADMIN. Minting it here must
        // require admin too, or a paired operator (phone) could escalate by asking
        // for role:"orchestrator"/"supervisor". Executor/auditor leases stay operator-level.
        if (['orchestrator', 'supervisor'].includes(nextAction.role) && !requireAdminAuth(req, res)) return;
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

  return FALL_THROUGH;
}
