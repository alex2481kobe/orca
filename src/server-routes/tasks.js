// Task API route group (/api/tasks/*) — per-task update/delete. ctx-threaded;
// see server-routes/lanes.js for the ctx/FALL_THROUGH contract. Session-scoped
// task create/list lives in server-routes/sessions.js.

import { FALL_THROUGH } from './lanes.js';

export async function handleTaskRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, getToolLeaseToken } = ctx;

  // The /api/tasks/:id routes have no project/session in the URL, so the generic
  // lease gate can't scope them. Resolve the task and enforce that the caller's
  // lease is scoped to (and is the active orchestrator of) the task's session —
  // otherwise a lease for session A could edit/delete session B's tasks.
  function authorizeTaskMutation(taskId) {
    const task = registry.getTask(taskId);
    if (!task) return { error: { status: 404, message: 'Task not found.' } };
    const token = typeof getToolLeaseToken === 'function' ? getToolLeaseToken(req) : null;
    if (!token) return { task }; // operator/dashboard (cookie) path — trusted
    const toolId = method === 'DELETE' ? 'task.delete' : 'task.update';
    try {
      const lease = registry.validateToolLease(token, { toolId, sessionId: task.sessionId, projectId: task.projectId });
      registry.assertOrchestratorOwnership({ toolId, sessionId: task.sessionId, lease });
    } catch (error) {
      return { error: { status: error.status || 403, message: error.message || 'Not authorized for this task.', nextAction: error.nextAction || null } };
    }
    return { task };
  }

  if (parts.length === 3 && parts[2]) {
    const taskId = decodeURIComponent(parts[2]);
    if (method === 'PATCH') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      const auth = authorizeTaskMutation(taskId);
      if (auth.error) return sendJson(res, auth.error.status, { error: auth.error.message, nextAction: auth.error.nextAction || null });
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
      const auth = authorizeTaskMutation(taskId);
      if (auth.error) return sendJson(res, auth.error.status, { error: auth.error.message, nextAction: auth.error.nextAction || null });
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
