// v2 orchestrator registration routes. An agent mints an (unscoped) orchestrator
// lease, then POSTs its working directory here to register — Orca implicitly
// creates the project (keyed by realpath(cwd)) and an orchestrator record bound
// to the lease. Replaces the session-scoped enroll flow.
import { FALL_THROUGH } from './lanes.js';

export async function handleOrchestratorRoutes(ctx, req, res, method, parts) {
  const {
    registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor,
    getToolLeaseToken, getSearchParams, hasAdminAuth,
  } = ctx;
  if (parts[1] !== 'orchestrators') return FALL_THROUGH;

  // UNSANDBOXED agent modes (bypass/yolo/force) grant full FS/network access and
  // must NOT be available to a paired-device operator (workflow-only boundary).
  const UNSANDBOXED_MODES = new Set(['bypass', 'bypass-permissions', 'bypasspermissions', 'yolo', 'force', 'danger', 'danger-full-access']);
  const unsandboxedBlocked = (permissionsProfile) => {
    if (!UNSANDBOXED_MODES.has(String(permissionsProfile || '').trim().toLowerCase())) return false;
    const privileged = (typeof hasAdminAuth === 'function' && hasAdminAuth(req))
      || Boolean(typeof getToolLeaseToken === 'function' && getToolLeaseToken(req));
    return !privileged;
  };

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
      const updated = registry.updateOrchestrator(parts[2], {
        title: body.title,
        focus: body.focus,
        approvedCapacity: body.approvedCapacity,
        laneConcurrencyLimit: body.laneConcurrencyLimit,
        spawnPolicy: body.spawnPolicy,
      }, { leaseId: leaseId?.id || 'dashboard' });
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
      const result = registry.resignOrchestrator(
        parts[2],
        { reason: (body && body.reason) || 'resigned' },
        { leaseId: leaseId?.id || 'dashboard' },
      );
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not resign orchestrator.' });
    }
  }

  // POST /api/orchestrators/{id}/executors — spawn an executor lane under this
  // orchestrator (container = the orchestrator, workdir = its project's cwd).
  if (parts.length === 4 && parts[3] === 'executors' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    const orchestratorId = parts[2];
    const orchestrator = (registry.orchestrators || []).find((o) => o.id === orchestratorId);
    if (!orchestrator) return sendJson(res, 404, { error: 'Orchestrator not found.' });
    const lease = leaseIdFor(ctx, req, registry, 'executor.spawn');
    if (lease && lease.error) return sendJson(res, lease.status, { error: lease.error });
    const leaseId = lease?.id || 'dashboard';
    // Only the lease that owns the orchestrator may spawn its executors.
    if (leaseId !== 'dashboard' && orchestrator.leaseId !== leaseId) {
      return sendJson(res, 403, { error: 'Lease does not own this orchestrator.' });
    }
    try {
      const lanePayload = { ...body, owner: body.owner || 'executor' };
      const lane = await registry.createLane(orchestratorId, lanePayload, {
        actor: body.actor || orchestrator.actor || 'orchestrator',
        approved: body.approved,
      });
      return sendJson(res, 201, lane);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not spawn executor.',
        requiresApproval: error.requiresApproval || false,
      });
    }
  }

  // --- Re-homed session capabilities onto the orchestrator container ---------
  // Everything below scopes to an orchestrator id (parts[2]) which IS the lane
  // container id. The tool-lease gate + ownership check already ran in server.js.
  const orchestratorExists = (id) => (registry.orchestrators || []).some((o) => o.id === id);

  // GET /api/orchestrators/{id}/lanes — compact lane list.
  // POST /api/orchestrators/{id}/lanes — create a governed lane in the container.
  if (parts.length === 4 && parts[3] === 'lanes') {
    if (!orchestratorExists(parts[2])) return sendJson(res, 404, { error: 'Orchestrator not found.' });
    if (method === 'GET') return sendJson(res, 200, registry.listLanesCompact(parts[2]));
    if (method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      if (unsandboxedBlocked(body.permissionsProfile)) {
        return sendJson(res, 403, { error: 'Unsandboxed agent permissions (bypass/yolo/force) require workstation admin auth, not a paired device. Use a sandboxed mode (plan/auto-edit).' });
      }
      try {
        const lanePayload = { ...body };
        if (!lanePayload.owner && req._toolLease?.role === 'orchestrator') {
          lanePayload.owner = 'executor';
        }
        const lane = await registry.createLane(parts[2], lanePayload, {
          actor: req._toolLease?.actor || body.actor || 'dashboard',
          approved: body.approved,
        });
        return sendJson(res, 201, lane);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not create lane.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  // POST /api/orchestrators/{id}/audit-done-lanes — queue audits for done lanes.
  if (parts.length === 4 && parts[3] === 'audit-done-lanes' && method === 'POST') {
    if (!orchestratorExists(parts[2])) return sendJson(res, 404, { error: 'Orchestrator not found.' });
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.queueDoneLanesAudit(parts[2], {
        ...body,
        actor: req._toolLease?.actor || body.actor || 'dashboard',
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not queue audit.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  // Durable agent-event queue: drain/replay (GET) + ack (POST).
  if (parts.length === 5 && parts[3] === 'events') {
    if (!orchestratorExists(parts[2])) return sendJson(res, 404, { error: 'Orchestrator not found.' });
    if (['drain', 'replay'].includes(parts[4]) && method === 'GET') {
      const sp = typeof getSearchParams === 'function' ? getSearchParams(req.url || '/') : null;
      if (!sp) return sendJson(res, 400, { error: 'Invalid request query string.' });
      try {
        const reader = parts[4] === 'drain' ? registry.drainAgentEvents : registry.replayAgentEvents;
        return sendJson(res, 200, reader.call(registry, parts[2], {
          role: req._toolLease?.role || 'dashboard',
          actor: req._toolLease?.actor || 'dashboard',
          limit: sp.get('limit') || 50,
          type: sp.get('type') || null,
          afterSeq: sp.get('afterSeq') || null,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not read agent events.' });
      }
    }
    if (parts[4] === 'ack' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.ackAgentEvents(parts[2], {
          eventIds: body.eventIds,
          actor: req._toolLease?.actor || 'dashboard',
          role: req._toolLease?.role || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not acknowledge agent event.' });
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  // POST /api/orchestrators/{id}/heartbeat — refresh the lease-owner's lastSeenAt
  // so read-only monitoring doesn't let ownership go stale (~15 min).
  if (parts.length === 4 && parts[3] === 'heartbeat' && method === 'POST') {
    if (!orchestratorExists(parts[2])) return sendJson(res, 404, { error: 'Orchestrator not found.' });
    const body = await parseJsonBody(req).catch(() => ({}));
    if (rejectSpoofedActor(body || {}, res)) return;
    const leaseId = leaseIdFor(ctx, req, registry, 'orchestrator.heartbeat');
    if (leaseId && leaseId.error) return sendJson(res, leaseId.status, { error: leaseId.error });
    try {
      const result = registry.touchOrchestrator(parts[2], { leaseId: leaseId?.id || 'dashboard' });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not refresh orchestrator heartbeat.' });
    }
  }

  // GET /api/orchestrators/{id}/status — ownership + lane tree + next tool.
  if (parts.length === 4 && parts[3] === 'status' && method === 'GET') {
    try {
      return sendJson(res, 200, registry.orchestratorStatus(parts[2]));
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not read orchestrator status.' });
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
