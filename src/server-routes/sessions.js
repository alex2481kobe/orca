// Session API route group (/api/sessions/*) extracted from server.js into a
// ctx-threaded handler. See server-routes/lanes.js for the ctx/FALL_THROUGH
// contract. Returns FALL_THROUGH when no session sub-route matched.

import { FALL_THROUGH } from './lanes.js';

export { FALL_THROUGH };

export async function handleSessionRoutes(ctx, req, res, method, parts) {
  const {
    registry,
    sendJson,
    sendBodyError,
    parseJsonBody,
    rejectSpoofedActor,
    getSearchParams,
    buildNextActionEnvelope,
    requestOrigin,
    getToolLeaseToken,
    hasAdminAuth,
  } = ctx;

  // UNSANDBOXED agent modes (bypass/yolo/force) grant full FS/network access and
  // must NOT be available to a paired-device operator (workflow-only boundary).
  // Allow only admin (workstation token/loopback) or a tool-lease (admin-issued).
  const UNSANDBOXED_MODES = new Set(['bypass', 'bypass-permissions', 'bypasspermissions', 'yolo', 'force', 'danger', 'danger-full-access']);
  const unsandboxedBlocked = (permissionsProfile) => {
    if (!UNSANDBOXED_MODES.has(String(permissionsProfile || '').trim().toLowerCase())) return false;
    const privileged = (typeof hasAdminAuth === 'function' && hasAdminAuth(req))
      || Boolean(typeof getToolLeaseToken === 'function' && getToolLeaseToken(req));
    return !privileged;
  };
    const session = registry.getSession(parts[2]);
    if (!session) {
      return sendJson(res, 404, { error: 'Session not found.' });
    }

    if (parts.length === 3 && method === 'GET') {
      return sendJson(res, 200, session);
    }

    if (parts.length === 3 && method === 'PATCH') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const updated = await registry.updateSession(session.id, body, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not update session.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 3 && method === 'DELETE') {
      const body = await parseJsonBody(req).catch(() => ({}));
      if (rejectSpoofedActor(body || {}, res)) return;
      try {
        const result = await registry.deleteSession(session.id, { actor: (body && body.actor) || 'dashboard' });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not delete session.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'capacity' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.getSessionCapacity(session.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load session capacity.' });
      }
    }

    if (parts.length === 5 && parts[3] === 'capacity' && parts[4] === 'request' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.requestCapacity(session.id, {
          ...body,
          actor: req._toolLease?.actor || body.actor || 'dashboard',
        });
        return sendJson(res, 201, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not request capacity.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'capacity' && parts[4] === 'policy' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.setCapacityPolicy(session.id, {
          ...body,
          actor: req._toolLease?.actor || body.actor || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not update capacity policy.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'worktree-policy' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.setSessionWorktreePolicy(session.id, {
          ...body,
          actor: req._toolLease?.actor || body.actor || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not update worktree policy.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'plan' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.updateSessionPlan(session.id, {
          goal: body.goal,
          plan: body.plan,
          actor: req._toolLease?.actor || String(body.actor || 'orchestrator').trim() || 'orchestrator',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not update session plan.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'attachments' && method === 'POST') {
      // Larger cap than normal JSON: attachments (screenshots/docs) arrive base64-encoded.
      const body = await parseJsonBody(req, { maxBytes: 13 * 1024 * 1024 });
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const ref = await registry.saveSessionAttachment(session.id, {
          name: body.name,
          contentType: body.contentType,
          dataBase64: body.dataBase64,
          actor: String(body.actor || 'dashboard').trim() || 'dashboard',
        });
        // Do not expose the server's absolute filesystem path to the client.
        const { path: _absolute, ...publicRef } = ref;
        return sendJson(res, 201, publicRef);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not save attachment.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'git' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.getSessionGitInfo(session.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not read git info.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'orchestrator' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.getOrchestratorThread(session.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load orchestrator thread.' });
      }
    }

    // Become / leave the active orchestrator for this session. The caller's
    // identity is its tool lease (resolved from the header); a dashboard operator
    // (no lease) acts as the 'dashboard' owner.
    if (parts.length === 5 && parts[3] === 'orchestrator' && ['enroll', 'resign'].includes(parts[4]) && method === 'POST') {
      const body = await parseJsonBody(req).catch(() => ({}));
      if (rejectSpoofedActor(body || {}, res)) return;
      const token = typeof getToolLeaseToken === 'function' ? getToolLeaseToken(req) : null;
      let leaseId = 'dashboard';
      let actor = (body && body.actor) || 'dashboard';
      let source = 'dashboard';
      if (token) {
        try {
          const lease = registry.validateToolLease(token, { toolId: `orchestrator.${parts[4]}`, sessionId: session.id });
          leaseId = lease.id;
          actor = lease.actor || 'orchestrator';
          source = 'mcp';
        } catch (error) {
          return sendJson(res, error.status || 403, { error: error.message || 'Tool lease rejected.' });
        }
      }
      try {
        const result = parts[4] === 'enroll'
          ? registry.enrollOrchestrator(session.id, { leaseId, actor, source, takeover: Boolean(body && body.takeover) })
          : registry.resignOrchestrator(session.id, { leaseId, reason: (body && body.reason) || 'resigned' });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not update orchestrator ownership.', current: error.current || null });
      }
    }

    if (parts.length === 5 && parts[3] === 'orchestrator' && parts[4] === 'status' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.orchestratorStatus(session.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not read orchestrator status.' });
      }
    }

    if (parts.length === 5 && parts[3] === 'orchestrator' && parts[4] === 'messages' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      if (unsandboxedBlocked(body.permissionsProfile)) {
        return sendJson(res, 403, { error: 'Unsandboxed agent permissions (bypass/yolo/force) require workstation admin auth, not a paired device. Use a sandboxed mode (plan/auto-edit).' });
      }
      try {
        const origin = requestOrigin(req);
        const nextAction = buildNextActionEnvelope(registry, {
          role: 'orchestrator',
          projectId: session.projectId,
          sessionId: session.id,
        });
        const result = await registry.sendOrchestratorMessage(session.id, {
          message: body.message,
          executorType: body.executorType,
          model: body.model,
          permissionsProfile: body.permissionsProfile,
          intelligenceProfile: body.intelligenceProfile,
          speed: body.speed,
          branch: body.branch,
          executionMode: body.executionMode,
          targetUrl: body.targetUrl,
          attachments: body.attachments,
          baseUrl: origin,
          discoveryUrl: `${origin}/api/agent-tools/discovery`,
          nextActionUrl: `${origin}/api/agent-tools/next-action?role=orchestrator&projectId=${encodeURIComponent(session.projectId)}&sessionId=${encodeURIComponent(session.id)}`,
        }, {
          actor: req._toolLease?.actor || body.actor || 'dashboard',
          approved: body.approved,
          nextAction,
        });
        return sendJson(res, 201, {
          ...result,
          nextAction,
        });
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not queue orchestrator message.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'supervisor' && parts[4] === 'audit' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.recordSupervisorSessionAudit(session.id, {
          ...body,
          actor: req._toolLease?.actor || body.actor || 'supervisor',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not record supervisor audit.' });
      }
    }

    if (parts.length === 7 && parts[3] === 'capacity' && parts[4] === 'requests' && ['approve', 'reject'].includes(parts[6]) && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = parts[6] === 'approve'
          ? registry.approveCapacityRequest(session.id, parts[5], {
            actor: body.actor || 'dashboard',
            approved: body.approved,
            reason: body.reason,
          })
          : registry.rejectCapacityRequest(session.id, parts[5], {
            actor: body.actor || 'dashboard',
            approved: body.approved,
            reason: body.reason,
          });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not decide capacity request.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'lanes') {
      // Compact list (no logs, last-20 agentEvents + counts). The full lane is
      // fetched per-lane via GET /api/lanes/:id when opened. Keeps the poll cheap.
      if (method === 'GET') return sendJson(res, 200, registry.listLanesCompact(session.id));
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
          const lane = await registry.createLane(session.id, lanePayload, {
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

    // Backlog tasks: list / add (and bulk add). The auto-spawn engine fans these
    // out across executor lanes when the session's spawnPolicy is 'auto'.
    if (parts.length === 4 && parts[3] === 'tasks') {
      if (method === 'GET') {
        const sp = getSearchParams(req.url || '/');
        return sendJson(res, 200, registry.listTasks(session.id, { state: sp ? sp.get('state') : null }));
      }
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
        if (rejectSpoofedActor(body, res)) return;
        try {
          const task = registry.addTask(session.id, body, { actor: req._toolLease?.actor || body.actor || 'orchestrator', approved: body.approved });
          return sendJson(res, 201, task);
        } catch (error) {
          return sendJson(res, error.status || 500, { error: error.message || 'Could not add task.' });
        }
      }
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

    if (parts.length === 5 && parts[3] === 'tasks' && parts[4] === 'bulk' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.bulkAddTasks(session.id, body, { actor: req._toolLease?.actor || body.actor || 'orchestrator' });
        // If nothing was added but there were per-task errors, that's a failure —
        // don't report 201 success with the errors buried in the body.
        if (result.added === 0 && Array.isArray(result.errors) && result.errors.length) {
          return sendJson(res, 422, { error: 'No tasks could be added.', ...result });
        }
        return sendJson(res, 201, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not add tasks.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'backlog' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.sessionBacklogStatus(session.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not read backlog status.' });
      }
    }

    if (parts.length >= 4 && parts[3] === 'loops') {
      if (parts.length === 4 && method === 'GET') {
        const sp = getSearchParams(req.url || '/');
        return sendJson(res, 200, registry.listLoops(session.id, { state: sp ? sp.get('state') : null }));
      }
      if (parts.length === 4 && method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
        if (rejectSpoofedActor(body, res)) return;
        try {
          const loop = registry.createLoop(session.id, body, {
            actor: req._toolLease?.actor || body.actor || 'orchestrator',
            approved: body.approved,
          });
          return sendJson(res, 201, loop);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not create loop.',
            requiresApproval: error.requiresApproval || false,
            risk: error.risk || null,
          });
        }
      }
      if (parts.length === 5 && method === 'GET') {
        const loop = registry.getLoop(parts[4]);
        if (!loop || loop.sessionId !== session.id) return sendJson(res, 404, { error: 'Loop not found.' });
        return sendJson(res, 200, registry.publicLoop(loop));
      }
      if (parts.length === 5 && method === 'PATCH') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
        if (rejectSpoofedActor(body, res)) return;
        const loop = registry.getLoop(parts[4]);
        if (!loop || loop.sessionId !== session.id) return sendJson(res, 404, { error: 'Loop not found.' });
        try {
          const updated = registry.updateLoop(loop.id, body, {
            actor: req._toolLease?.actor || body.actor || 'orchestrator',
            approved: body.approved,
          });
          return sendJson(res, 200, updated);
        } catch (error) {
          return sendJson(res, error.status || 500, {
            error: error.message || 'Could not update loop.',
            requiresApproval: error.requiresApproval || false,
            risk: error.risk || null,
          });
        }
      }
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

    if (parts.length === 4 && parts[3] === 'audit-done-lanes' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const result = await registry.queueDoneLanesAudit(session.id, {
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

    if (parts.length === 4 && parts[3] === 'audit-events' && method === 'GET') {
      const searchParams = getSearchParams(req.url || '/');
      if (!searchParams) {
        return sendJson(res, 400, {
          error: 'Invalid request query string.',
        });
      }
      const status = searchParams.get('status');
      try {
        return sendJson(res, 200, registry.listAuditEvents({
          status,
          sessionId: session.id,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not list session audit events.' });
      }
    }

  return FALL_THROUGH;
}
