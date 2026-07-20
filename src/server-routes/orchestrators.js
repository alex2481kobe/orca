// v2 orchestrator registration routes. An agent mints an (unscoped) orchestrator
// lease, then POSTs its working directory here to register — Orca implicitly
// creates the project (keyed by realpath(cwd)) and an orchestrator record bound
// to the lease. Replaces the session-scoped enroll flow.
import { FALL_THROUGH } from './lanes.js';
import { agentMethods } from '../registry-agents.js';

export async function handleOrchestratorRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, getToolLeaseToken } = ctx;
  if (parts[1] !== 'orchestrators') return FALL_THROUGH;

  // POST /api/orchestrators — register (or takeover / stale-dedupe).
  if (parts.length === 2 && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    const token = typeof getToolLeaseToken === 'function' ? getToolLeaseToken(req) : null;
    let leaseId = 'dashboard';
    let actor = String(body.actor || 'orchestrator').trim() || 'orchestrator';
    let source = 'dashboard';
    if (token) {
      try {
        const lease = registry.validateToolLease(token, { toolId: 'orchestrator.register' });
        leaseId = lease.id;
        actor = lease.actor || actor;
        source = 'mcp';
      } catch (error) {
        return sendJson(res, error.status || 403, { error: error.message || 'Tool lease rejected.' });
      }
    }
    try {
      const orchestrator = await registry.registerOrchestrator(
        {
          cwd: body.cwd,
          actor,
          title: body.title ?? null,
          focus: body.focus ?? null,
          takeoverOrchestratorId: body.takeoverOrchestratorId ?? null,
        },
        { leaseId, source },
      );
      return sendJson(res, 200, orchestrator);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not register orchestrator.' });
    }
  }

  // PATCH /api/orchestrators/{id} — update self-authored title/focus.
  if (parts.length === 3 && method === 'PATCH') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    const leaseId = leaseIdFor(ctx, req, registry, 'orchestrator.update');
    if (leaseId && leaseId.error) return sendJson(res, leaseId.status, { error: leaseId.error });
    try {
      const updated = registry.updateOrchestrator(parts[2], { title: body.title, focus: body.focus }, { leaseId: leaseId?.id || 'dashboard' });
      return sendJson(res, 200, updated);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not update orchestrator.' });
    }
  }

  // POST /api/orchestrators/{id}/resign — leave; another agent may take over.
  if (parts.length === 4 && parts[3] === 'resign' && method === 'POST') {
    const body = await parseJsonBody(req).catch(() => ({}));
    if (rejectSpoofedActor(body || {}, res)) return;
    const leaseId = leaseIdFor(ctx, req, registry, 'orchestrator.resign');
    if (leaseId && leaseId.error) return sendJson(res, leaseId.status, { error: leaseId.error });
    try {
      // The v2 resignOrchestrator lives in agentMethods; the old session-based
      // resignOrchestrator still shadows it on the prototype until the session
      // model is removed, so call the v2 implementation explicitly.
      const result = agentMethods.resignOrchestrator.call(
        registry,
        parts[2],
        { reason: (body && body.reason) || 'resigned' },
        { leaseId: leaseId?.id || 'dashboard' },
      );
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not resign orchestrator.' });
    }
  }

  return FALL_THROUGH;
}

function leaseIdFor(ctx, req, registry, toolId) {
  const token = typeof ctx.getToolLeaseToken === 'function' ? ctx.getToolLeaseToken(req) : null;
  if (!token) return { id: 'dashboard' };
  try {
    const lease = registry.validateToolLease(token, { toolId });
    return { id: lease.id };
  } catch (error) {
    return { error: error.message || 'Tool lease rejected.', status: error.status || 403 };
  }
}
