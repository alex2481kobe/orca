// artifacts API route group extracted from server.js. ctx-threaded; the route
// checks self-guard on parts[1] so the caller gates on parts[1]==='artifacts'.

import { FALL_THROUGH } from './lanes.js';

export async function handleArtifactRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor } = ctx;
  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && parts.length === 3 && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.cleanupArtifacts({
        ...body,
        actor: body.actor || 'dashboard',
        // skipApproval is an internal scheduler-only flag; never honor it from a request body.
        skipApproval: false,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not run artifact cleanup.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && parts[3] === 'schedule' && method === 'GET') {
    return sendJson(res, 200, { schedule: registry.getCleanupSchedule() });
  }

  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && parts[3] === 'schedule' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.updateCleanupSchedule(body, {
        actor: body.actor || 'dashboard',
        approved: body.approved,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not update artifact cleanup schedule.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'artifacts' && parts[2] === 'cleanup' && parts[3] === 'run-now' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    const schedule = registry.getCleanupSchedule?.() || {};
    const hasSessionOverride = body && Object.prototype.hasOwnProperty.call(body, 'sessionId');
    const hasRetentionOverride = body && Object.prototype.hasOwnProperty.call(body, 'olderThanDays');
    const hasDryRunOverride = body && Object.prototype.hasOwnProperty.call(body, 'dryRun');
    const normalizedSessionId = hasSessionOverride
      ? (body.sessionId && String(body.sessionId).trim()) || null
      : schedule.sessionId;
    const normalizedRetention = hasRetentionOverride
      ? body.olderThanDays
      : schedule.olderThanDays;
    const normalizedDryRun = hasDryRunOverride
      ? body.dryRun
      : schedule.dryRun;
    const approved = body && body.approved !== undefined ? body.approved : false;
    try {
      const result = await registry.cleanupArtifacts({
        actor: body.actor || 'dashboard',
        approved: approved,
        skipApproval: false,
        sessionId: normalizedSessionId || null,
        olderThanDays: normalizedRetention ?? null,
        dryRun: Boolean(normalizedDryRun),
        confirmed: Boolean(body.confirmed),
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not run artifact cleanup.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  return FALL_THROUGH;
}
