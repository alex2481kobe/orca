// capture API route group extracted from server.js. ctx-threaded; the route
// checks self-guard on parts[1] so the caller gates on parts[1]==='capture'.

import { FALL_THROUGH } from './lanes.js';

export async function handleCaptureRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, requireAdminAuth } = ctx;
  if (parts[1] === 'capture' && parts[2] === 'status' && parts.length === 3 && method === 'GET') {
    const playwrightAvailable = await registry.evidenceRunner.ensurePlaywrightDetected().catch(() => false);
    return sendJson(res, 200, registry.captureStatus({ playwrightAvailable }));
  }

  if (parts[1] === 'capture' && parts[2] === 'install' && parts.length === 3 && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.setupCaptureBackend({
        actor: body.actor || 'dashboard',
        approved: Boolean(body.approved),
        confirmed: Boolean(body.confirmed),
        preferSystemChrome: body.preferSystemChrome !== false,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not set up capture backend.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  return FALL_THROUGH;
}
