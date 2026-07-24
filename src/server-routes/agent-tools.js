// agent-tools API route group extracted from server.js. ctx-threaded; the route
// checks self-guard on parts[1] so the caller gates on parts[1]==='agent-tools'.

import { FALL_THROUGH } from './lanes.js';
import { ROLES } from '../agent-tools/contract.js';

const TOOL_LEASE_ROLE_MESSAGE = 'Tool lease role must be orchestrator, executor, auditor, or dashboard.';

export async function handleAgentToolRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, getSearchParams, buildNextActionEnvelope, requireAdminAuth } = ctx;
  if (parts[1] === 'agent-tools') {
    // No /discovery or /next-action routes any more: the executor capability
    // matrix is gone, and the next-action envelope is served by
    // orchestrator.status (and inline on the lease-mint response below).
    if (parts[2] === 'leases' && parts.length === 3 && method === 'GET') {
      if (!requireAdminAuth(req, res)) return;
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
        const requestedRole = String(body.role || 'orchestrator').trim().toLowerCase() || 'orchestrator';
        if (!ROLES.has(requestedRole)) {
          return sendJson(res, 422, { error: TOOL_LEASE_ROLE_MESSAGE });
        }
        const nextAction = buildNextActionEnvelope(registry, {
          role: requestedRole,
          projectId: body.projectId,
          sessionId: body.sessionId,
          laneId: body.laneId,
        });
        // Dashboard/orchestrator leases are off-origin host credentials
        // with broad workflow/host power. Minting them here must
        // require admin too, or a paired operator (phone) could escalate by asking
        // for role:"dashboard"/"orchestrator". Executor/auditor
        // leases stay operator-level.
        if (['dashboard', 'orchestrator'].includes(nextAction.role) && !requireAdminAuth(req, res)) return;
        const result = registry.createToolLease({
          role: nextAction.role,
          projectId: body.projectId || null,
          sessionId: body.sessionId || null,
          laneId: body.laneId || null,
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
