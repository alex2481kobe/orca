// Supervisor API route group (/api/supervisor/*). A supervisor is a top-level
// coordinator for many project orchestrators.

import { FALL_THROUGH } from './lanes.js';

export async function handleSupervisorRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, getSearchParams } = ctx;
  if (parts[1] !== 'supervisor') return FALL_THROUGH;

  if (parts[2] === 'overview' && parts.length === 3 && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) {
      return sendJson(res, 400, { error: 'Invalid request query string.' });
    }
    try {
      const lease = req._toolLease || null;
      const leaseLane = lease?.laneId ? registry.getLane(lease.laneId) : null;
      const leaseSession = lease?.sessionId
        ? registry.getSession(lease.sessionId)
        : (leaseLane?.sessionId ? registry.getSession(leaseLane.sessionId) : null);
      const leaseProjectId = lease?.projectId || leaseSession?.projectId || leaseLane?.projectId || null;
      const requestedProjectId = searchParams.get('projectId') || null;
      if (leaseProjectId && requestedProjectId) {
        const requestedProject = registry.getProject(requestedProjectId);
        if (!requestedProject || requestedProject.id !== leaseProjectId) {
          return sendJson(res, 403, { error: 'Tool lease project mismatch.' });
        }
      }
      return sendJson(res, 200, registry.supervisorOverview({
        projectId: requestedProjectId || leaseProjectId || null,
        sessionId: lease?.sessionId || leaseLane?.sessionId || null,
      }));
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not read supervisor overview.' });
    }
  }

  if (parts[2] === 'resign' && parts.length === 3 && method === 'POST') {
    const lease = req._toolLease || null;
    if (!lease || lease.role !== 'supervisor') {
      return sendJson(res, 403, { error: 'Supervisor resign requires a supervisor tool lease.' });
    }
    try {
      const revoked = registry.revokeToolLease(lease.id, { actor: lease.actor || 'supervisor' });
      return sendJson(res, 200, { resigned: true, lease: revoked });
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not resign supervisor.' });
    }
  }

  return sendJson(res, 404, { error: 'Supervisor route not found.' });
}
