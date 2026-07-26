// v2 orchestrator registration routes. An agent mints an (unscoped) orchestrator
// lease, then POSTs its working directory here to register — Orca implicitly
// creates the project (keyed by realpath(cwd)) and an orchestrator record bound
// to the lease. Replaces the session-scoped enroll flow.
import { FALL_THROUGH } from './lanes.js';
import { makeUnsandboxedGate, UNSANDBOXED_DENIAL } from './permission-gate.js';

export async function handleOrchestratorRoutes(ctx, req, res, method, parts) {
  const {
    registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor,
    getToolLeaseToken, getSearchParams, hasAdminAuth,
  } = ctx;
  if (parts[1] !== 'orchestrators') return FALL_THROUGH;

  // UNSANDBOXED agent modes grant full FS/network access and must NOT be available
  // to a paired-device operator (workflow-only boundary). Shared with the lane
  // controls route, which can change the mode of an already-created lane.
  const unsandboxedBlocked = makeUnsandboxedGate(ctx, req);

  // GET /api/orchestrators — list them.
  //
  // Without this there was NO way to enumerate orchestrators: /api/health happily
  // reported `counts.orchestrators`, but any caller trying to sweep for open work
  // got "API route not found". A cleanup sweep that silently found nothing then
  // reported "all clear" while five lanes were still awaiting audit — the failure
  // this route exists to prevent.
  //
  // Active-only by default (a resigned orchestrator is not open work); pass
  // ?all=1 to include resigned ones.
  if (parts.length === 2 && method === 'GET') {
    const params = typeof getSearchParams === 'function' ? getSearchParams(req.url) : null;
    const includeAll = params ? ['1', 'true', 'yes'].includes(String(params.get('all') || '').toLowerCase()) : false;
    const projectId = params ? String(params.get('projectId') || '').trim() : '';
    const rows = (registry.orchestrators || [])
      .filter((item) => (includeAll ? true : !item.resignedAt))
      .filter((item) => (projectId ? item.projectId === projectId : true))
      .map((item) => ({
        id: item.id,
        projectId: item.projectId,
        actor: item.actor,
        title: item.title,
        focus: item.focus,
        source: item.source,
        registeredAt: item.registeredAt,
        lastSeenAt: item.lastSeenAt,
        resignedAt: item.resignedAt ?? null,
      }));
    return sendJson(res, 200, { orchestrators: rows, count: rows.length });
  }

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

  // (No PATCH /api/orchestrators/{id}: title/focus are folded into POST
  // /api/orchestrators — re-registering the same cwd on the owning lease
  // refreshes them idempotently.)

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
    // Inherited from the deleted POST .../lanes route: this is now the ONLY way to
    // create a lane, so the unsandboxed-mode gate has to live here or it is gone.
    if (unsandboxedBlocked(body.executorType, body.permissionsProfile)) {
      return sendJson(res, 403, { error: UNSANDBOXED_DENIAL });
    }
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
        // Lease actor wins over a body-supplied one so a scoped lease cannot
        // author work under someone else's name (carried over from the deleted
        // POST .../lanes route, which is now this route's only caller shape).
        actor: req._toolLease?.actor || body.actor || orchestrator.actor || 'orchestrator',
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

  // GET /api/orchestrators/{id}/lanes — compact lane list. There is no POST:
  // executor.spawn (POST .../executors) is the single way to create a lane.
  if (parts.length === 4 && parts[3] === 'lanes') {
    if (!orchestratorExists(parts[2])) return sendJson(res, 404, { error: 'Orchestrator not found.' });
    if (method === 'GET') return sendJson(res, 200, registry.listLanesCompact(parts[2]));
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  // GET /api/orchestrators/{id}/events/drain — durable agent-event wakeups.
  // Draining CONSUMES: whatever it hands back is acknowledged for this consumer,
  // so the next drain returns only what is new. (No separate ack/replay routes.)
  if (parts.length === 5 && parts[3] === 'events') {
    if (!orchestratorExists(parts[2])) return sendJson(res, 404, { error: 'Orchestrator not found.' });
    if (parts[4] === 'drain' && method === 'GET') {
      const sp = typeof getSearchParams === 'function' ? getSearchParams(req.url || '/') : null;
      if (!sp) return sendJson(res, 400, { error: 'Invalid request query string.' });
      try {
        return sendJson(res, 200, registry.drainAgentEvents(parts[2], {
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
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }


  // POST /api/orchestrators/{id}/emergency-stop — break-glass: stop all live lanes
  // under this orchestrator at once. Body {all:true} stops EVERY executor fleet-
  // wide and is admin/owner-only (a paired-device/lease caller can't fan it out).
  if (parts.length === 4 && parts[3] === 'emergency-stop' && method === 'POST') {
    if (!orchestratorExists(parts[2])) return sendJson(res, 404, { error: 'Orchestrator not found.' });
    const body = await parseJsonBody(req).catch(() => ({}));
    if (rejectSpoofedActor(body || {}, res)) return;
    const actor = req._toolLease?.actor || (body && body.actor) || 'operator';
    try {
      if (body && body.all) {
        const privileged = typeof hasAdminAuth === 'function' && hasAdminAuth(req);
        if (!privileged) {
          return sendJson(res, 403, {
            error: 'Stopping ALL lanes fleet-wide requires workstation admin auth. Omit all:true to stop just this orchestrator\'s lanes.',
          });
        }
        const count = await registry.stopAllExecutors('emergency stop (operator break-glass)');
        return sendJson(res, 200, { stopped: 'all', count: count ?? null });
      }
      const result = await registry.emergencyStopContainer(parts[2], {
        actor,
        reason: 'emergency stop (orchestrator break-glass)',
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not emergency-stop lanes.' });
    }
  }

  // GET /api/orchestrators/{id}/status — ownership + lane tree + next tool.
  if (parts.length === 4 && parts[3] === 'status' && method === 'GET') {
    try {
      // Pass the caller's lease so status doubles as the ownership heartbeat
      // (the standalone orchestrator.heartbeat tool/route is gone).
      const lease = leaseIdFor(ctx, req, registry, 'orchestrator.status');
      return sendJson(res, 200, registry.orchestratorStatus(parts[2], {
        leaseId: lease && !lease.error ? lease.id : null,
      }));
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
