// agent-tools API route group extracted from server.js. ctx-threaded; the route
// checks self-guard on parts[1] so the caller gates on parts[1]==='agent-tools'.

import { FALL_THROUGH } from './lanes.js';
import { ROLES } from '../agent-tools/contract.js';

const TOOL_LEASE_ROLE_MESSAGE = 'Tool lease role must be supervisor, orchestrator, executor, auditor, critique, or dashboard.';

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
      const lease = req._toolLease || null;
      if (lease) {
        const requestedLaneId = searchParams.get('laneId') || null;
        const requestedSessionId = searchParams.get('sessionId') || null;
        const requestedProjectId = searchParams.get('projectId') || null;
        const leaseLane = lease.laneId ? registry.getLane(lease.laneId) : null;
        const leaseSession = lease.sessionId ? registry.getSession(lease.sessionId) : (leaseLane?.sessionId ? registry.getSession(leaseLane.sessionId) : null);
        const leaseProjectId = lease.projectId || leaseSession?.projectId || leaseLane?.projectId || null;
        if (requestedLaneId) {
          const requestedLane = registry.getLane(requestedLaneId);
          if (!requestedLane) return sendJson(res, 404, { error: 'Lane not found.' });
          if ((lease.laneId && requestedLane.id !== lease.laneId)
            || (lease.sessionId && requestedLane.sessionId !== lease.sessionId)) {
            return sendJson(res, 403, { error: 'Tool lease lane mismatch.' });
          }
          if (leaseProjectId && requestedLane.projectId !== leaseProjectId) {
            return sendJson(res, 403, { error: 'Tool lease project mismatch.' });
          }
        }
        if (requestedSessionId) {
          const requestedSession = registry.getSession(requestedSessionId);
          if (!requestedSession) return sendJson(res, 404, { error: 'Session not found.' });
          if (lease.sessionId && requestedSession.id !== lease.sessionId) {
            return sendJson(res, 403, { error: 'Tool lease session mismatch.' });
          }
          if (leaseProjectId && requestedSession.projectId !== leaseProjectId) {
            return sendJson(res, 403, { error: 'Tool lease project mismatch.' });
          }
        }
        if (requestedProjectId) {
          const requestedProject = registry.getProject(requestedProjectId);
          if (!requestedProject) return sendJson(res, 404, { error: 'Project not found.' });
          if (leaseProjectId && requestedProject.id !== leaseProjectId) {
            return sendJson(res, 403, { error: 'Tool lease project mismatch.' });
          }
        }
        return sendJson(res, 200, buildNextActionEnvelope(registry, {
          role: lease.role,
          projectId: requestedProjectId || leaseProjectId,
          sessionId: requestedSessionId || lease.sessionId || leaseLane?.sessionId || null,
          laneId: requestedLaneId || lease.laneId || null,
        }));
      }
      return sendJson(res, 200, buildNextActionEnvelope(registry, {
        role: searchParams.get('role'),
        projectId: searchParams.get('projectId'),
        sessionId: searchParams.get('sessionId'),
        laneId: searchParams.get('laneId'),
      }));
    }
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
        // Dashboard/orchestrator/supervisor leases are off-origin host credentials
        // with broad workflow/host power. Minting them here must
        // require admin too, or a paired operator (phone) could escalate by asking
        // for role:"dashboard"/"orchestrator"/"supervisor". Executor/auditor/
        // critique leases stay operator-level.
        if (['dashboard', 'orchestrator', 'supervisor'].includes(nextAction.role) && !requireAdminAuth(req, res)) return;
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
