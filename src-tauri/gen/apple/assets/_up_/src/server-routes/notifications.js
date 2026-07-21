// Notifications API route group (/api/notifications/*) extracted from server.js.
// ctx-threaded; see server-routes/lanes.js for the contract.

import { FALL_THROUGH } from './lanes.js';

export async function handleNotificationRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, getSearchParams } = ctx;
    if (parts.length === 2 && method === 'GET') {
      const searchParams = getSearchParams(req.url || '/');
      if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
      return sendJson(res, 200, registry.getNotifications({
        unreadOnly: searchParams.get('unreadOnly') === 'true',
        limit: searchParams.get('limit') || 50,
      }));
    }

    if (parts.length === 3 && parts[2] === 'settings' && method === 'PATCH') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.updateNotificationSettings(body, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not update notification settings.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 3 && parts[2] === 'read-all' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, registry.markAllNotificationsRead({
          actor: body.actor || 'dashboard',
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not mark notifications read.',
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'read' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, registry.markNotificationRead(parts[2], {
          actor: body.actor || 'dashboard',
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not mark notification read.',
        });
      }
    }

  return FALL_THROUGH;
}
