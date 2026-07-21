// Lane API route group (/api/lanes/*) extracted from server.js into a
// ctx-threaded handler. server.js owns the request-scoped singletons (registry,
// auth/session state) and passes them via ctx so the cache-busted test harness
// keeps fresh instances per import. Returns FALL_THROUGH when no lane sub-route
// matched, so the caller continues its dispatch chain (ending in a 404).

export const FALL_THROUGH = Symbol('orca-route-fall-through');

export async function handleLaneRoutes(ctx, req, res, method, parts) {
  const {
    registry,
    sendJson,
    sendBodyError,
    parseJsonBody,
    rejectSpoofedActor,
    getSearchParams,
    constantTimeEqual,
    hasSpecificToolLeaseAuth,
    WORKER_TOKEN,
  } = ctx;
    const lane = registry.getLane(parts[2]);
    if (!lane) {
      return sendJson(res, 404, { error: 'Lane not found.' });
    }

    if (parts.length === 3 && method === 'GET') {
      return sendJson(res, 200, lane);
    }

    if (parts.length === 3 && method === 'DELETE') {
      const body = await parseJsonBody(req).catch(() => ({}));
      if (rejectSpoofedActor(body || {}, res)) return;
      try {
        const result = await registry.deleteLane(lane.id, { actor: (body && body.actor) || 'dashboard' });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not delete lane.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'controls' && method === 'PATCH') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const updated = registry.updateLaneControls(lane.id, body, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not update lane controls.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'stop' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const updated = await registry.stopLane(lane.id, { ...body, actor: body.actor || 'dashboard' });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not stop lane.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 4 && parts[3] === 'retry' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const updated = registry.retryLane(lane.id, { ...body, actor: body.actor || 'dashboard' });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not retry lane.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'audit' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const audit = registry.queueLaneAudit(lane.id, { ...body, actor: body.actor || 'dashboard' });
        return sendJson(res, 201, audit);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not queue lane audit.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'critique' && parts[4] === 'bundle' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const bundle = registry.createCritiqueBundle(lane.id, {
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 201, bundle);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not create critique bundle.',
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'critique' && parts[4] === 'findings' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.recordCritiqueFindings(lane.id, {
          ...body,
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not record critique findings.',
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'critique' && parts[4] === 'waive' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.waiveCritique(lane.id, {
          ...body,
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not waive critique.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'audit' && ['accept', 'findings', 'request-fix', 'block'].includes(parts[4]) && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        let result;
        const verdict = String(body.verdict || body.disposition || '').trim().toLowerCase();
        if (parts[4] === 'accept' || (parts[4] === 'findings' && ['accept', 'accepted', 'pass', 'passed'].includes(verdict))) {
          result = registry.acceptLaneAudit(lane.id, {
            ...body,
            actor: body.actor || 'dashboard',
            verdict: body.verdict || 'accepted',
          });
        } else if (parts[4] === 'request-fix' || (parts[4] === 'findings' && ['fix', 'request_fix', 'fix_requested', 'needs_fix'].includes(verdict))) {
          result = registry.requestLaneFix(lane.id, {
            ...body,
            actor: body.actor || 'dashboard',
          });
        } else if (parts[4] === 'block' || (parts[4] === 'findings' && ['block', 'blocked'].includes(verdict))) {
          result = registry.blockLaneAudit(lane.id, {
            ...body,
            actor: body.actor || 'dashboard',
          });
        } else {
          return sendJson(res, 422, {
            error: 'Audit findings require verdict: accepted, fix_requested, or blocked.',
          });
        }
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not record audit outcome.',
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
          laneId: lane.id,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not list lane audit events.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'heartbeat' && method === 'POST') {
      const heartbeatLease = hasSpecificToolLeaseAuth(req, { toolId: 'lane.heartbeat', laneId: lane.id });
      if (WORKER_TOKEN && !heartbeatLease) {
        const workerToken = req.headers['x-orca-worker-token'];
        if (!workerToken || !constantTimeEqual(workerToken, WORKER_TOKEN)) {
          return sendJson(res, 401, {
            error: 'Heartbeat requires the worker token (set ORCA_WORKER_TOKEN and pass x-orca-worker-token).',
          });
        }
      }
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      const actor = String(body.actor || 'worker').trim() || 'worker';
      // Heartbeat is worker-scoped; the dashboard cannot impersonate other actors here.
      try {
        const updated = await registry.touchHeartbeat(lane.id, { ...body, actor });
        return sendJson(res, 200, updated);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not touch heartbeat.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'submit' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.submitLane(lane.id, {
          actor: String(body.actor || 'executor').trim() || 'executor',
          summary: body.summary,
          changedFiles: body.changedFiles,
          handoff: body.handoff,
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not submit lane.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'approvals' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.getLaneApprovals(lane.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not list approvals.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'approvals' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.recordLaneApproval(lane.id, {
          kind: body.kind,
          detail: body.detail,
          requestId: body.requestId,
          actor: String(body.actor || 'executor').trim() || 'executor',
        });
        return sendJson(res, 201, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not record approval.' });
      }
    }

    if (parts.length === 6 && parts[3] === 'approvals' && parts[5] === 'decide' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.decideLaneApproval(lane.id, parts[4], {
          decision: body.decision,
          actor: String(body.actor || 'dashboard').trim() || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not decide approval.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'artifacts' && method === 'GET') {
      try {
        const files = await registry.listArtifactFiles(lane.id);
        return sendJson(res, 200, {
          laneId: lane.id,
          sessionId: lane.sessionId,
          files: files.map((filename) => ({
            name: filename,
            url: `/artifacts/${lane.sessionId}/${lane.id}/${filename}`,
          })),
        });
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not list artifacts.' });
      }
    }

    if (parts.length === 5 && parts[3] === 'evidence' && parts[4] === 'presets' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.getEvidencePresets(lane.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load evidence presets.' });
      }
    }

    if (parts.length === 5 && parts[3] === 'evidence' && parts[4] === 'latest' && method === 'GET') {
      const searchParams = getSearchParams(req.url || '/');
      if (!searchParams) {
        return sendJson(res, 400, {
          error: 'Invalid request query string.',
        });
      }
      const mode = searchParams.get('mode');
      try {
        const latestEvidence = await registry.getLatestEvidence(lane.id, { mode });
        return sendJson(res, 200, latestEvidence);
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load latest evidence.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'evidence' && method === 'GET') {
      try {
        const files = await registry.listArtifactFiles(lane.id);
        const evidenceFiles = files.filter((filename) => filename.startsWith('evidence-') || filename === 'evidence.json');
        return sendJson(res, 200, {
          laneId: lane.id,
          sessionId: lane.sessionId,
          files: evidenceFiles.map((filename) => ({
            name: filename,
            url: `/artifacts/${lane.sessionId}/${lane.id}/${filename}`,
          })),
        });
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not list evidence files.' });
      }
    }

    if (parts.length === 4 && parts[3] === 'evidence' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const result = await registry.captureLaneEvidence(lane.id, {
          ...body,
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not capture evidence.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'worktree' && parts[4] === 'remove' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = await registry.removeLaneWorktree(lane.id, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
          removeBranch: Boolean(body.removeBranch),
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not remove worktree.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

    if (parts.length === 5 && parts[3] === 'evidence' && parts[4] === 'clear' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const result = await registry.clearLaneEvidenceArtifacts(lane.id, {
          ...body,
          actor: body.actor || 'dashboard',
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not clear evidence artifacts.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }

  return FALL_THROUGH;
}
