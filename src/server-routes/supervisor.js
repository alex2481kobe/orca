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
      return sendJson(res, 200, registry.supervisorOverview({
        projectId: searchParams.get('projectId') || null,
      }));
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not read supervisor overview.' });
    }
  }

  return sendJson(res, 404, { error: 'Supervisor route not found.' });
}
