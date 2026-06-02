// settings API route group extracted from server.js. ctx-threaded; the route
// checks self-guard on parts[1] so the caller gates on parts[1]==='settings'.

import { FALL_THROUGH } from './lanes.js';

export async function handleSettingsRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, getSearchParams } = ctx;
  if (parts[1] === 'settings' && parts[2] === 'effective' && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) {
      return sendJson(res, 400, { error: 'Invalid request query string.' });
    }
    try {
      return sendJson(res, 200, registry.getEffectiveSettings({
        projectId: searchParams.get('projectId'),
        sessionId: searchParams.get('sessionId'),
        laneId: searchParams.get('laneId'),
      }));
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not resolve effective settings.',
      });
    }
  }

  if (parts[1] === 'settings' && ['project', 'session', 'lane'].includes(parts[2]) && parts[3] && method === 'PATCH') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = registry.updateSettingsOverrides({
        scope: parts[2],
        locator: decodeURIComponent(parts[3]),
        settingsOverrides: body.settingsOverrides || body.overrides || {},
        actor: body.actor || 'dashboard',
        approved: body.approved,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not update settings overrides.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  return FALL_THROUGH;
}
