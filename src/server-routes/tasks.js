// Task API route group (/api/tasks/*) — per-task update/delete. ctx-threaded;
// see server-routes/lanes.js for the ctx/FALL_THROUGH contract. Session-scoped
// task create/list lives in server-routes/sessions.js.

import { FALL_THROUGH } from './lanes.js';

export async function handleTaskRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor } = ctx;

  if (parts.length === 3 && parts[2]) {
    const taskId = decodeURIComponent(parts[2]);
    if (method === 'PATCH') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const updated = registry.updateTask(taskId, body, { actor: body.actor || 'orchestrator' });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not update task.' });
      }
    }
    if (method === 'DELETE') {
      const body = await parseJsonBody(req).catch(() => ({}));
      if (rejectSpoofedActor(body || {}, res)) return;
      try {
        const result = registry.deleteTask(taskId, { actor: (body && body.actor) || 'orchestrator' });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not delete task.' });
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  return FALL_THROUGH;
}
