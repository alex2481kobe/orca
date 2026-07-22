// Artifact garbage-collection routes: run cleanup now + read/update the retention
// schedule. These wrap the registry cleanup capability (registry-cleanup.js) that
// previously ran ONLY from the scheduler tick — now it is reachable from an
// operator surface and an orchestrator MCP tool.
//
// Destructive (removes archived terminal-lane artifacts from disk), so every route
// is deny-by-default: the caller is already operator- or orchestrator-lease-gated
// upstream (requireApiAuth), and the registry policy gate refuses the run/patch
// unless the caller passes explicit approval/confirmation. Dispatched on
// parts[1] === 'artifacts'. Returns FALL_THROUGH when nothing matched so the
// caller continues to the global 404.

import { FALL_THROUGH } from './lanes.js';

export async function handleArtifactRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor } = ctx;
  if (parts[1] !== 'artifacts' || parts[2] !== 'cleanup') return FALL_THROUGH;

  // GET /api/artifacts/cleanup/schedule — read the retention schedule.
  if (parts[3] === 'schedule' && parts.length === 4 && method === 'GET') {
    return sendJson(res, 200, { schedule: registry.getCleanupSchedule() });
  }

  // PATCH /api/artifacts/cleanup/schedule — update the retention schedule.
  if (parts[3] === 'schedule' && parts.length === 4 && method === 'PATCH') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const schedule = registry.updateCleanupSchedule(body, {
        actor: body.actor || 'operator',
        approved: body.approved === true,
      });
      return sendJson(res, 200, { schedule });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not update cleanup schedule.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  // POST /api/artifacts/cleanup          — run cleanup now (destructive)
  // POST /api/artifacts/cleanup/run-now  — explicit alias the mobile manifest advertises
  const isRunNow = (parts.length === 3 && method === 'POST')
    || (parts[3] === 'run-now' && parts.length === 4 && method === 'POST');
  if (isRunNow) {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      // Never inject skipApproval from a route: the client must supply
      // {approved:true, confirmed:true} for a real run (or {dryRun:true} to
      // preview). Missing either -> the registry policy/confirmation gate 409s.
      const summary = await registry.cleanupArtifacts({
        actor: body.actor || 'operator',
        approved: body.approved === true,
        confirmed: body.confirmed === true,
        dryRun: body.dryRun === true,
        sessionId: body.sessionId || null,
        olderThanDays: body.olderThanDays ?? null,
      });
      return sendJson(res, 200, { cleanup: summary });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not clean up artifacts.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  return FALL_THROUGH;
}
