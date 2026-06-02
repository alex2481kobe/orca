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
  } = ctx;
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
          actor: body.actor || 'dashboard',
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
          actor: body.actor || 'dashboard',
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

    if (parts.length === 4 && parts[3] === 'plan' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        const result = registry.updateSessionPlan(session.id, {
          goal: body.goal,
          plan: body.plan,
          actor: String(body.actor || 'orchestrator').trim() || 'orchestrator',
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

    if (parts.length === 4 && parts[3] === 'orchestrator' && method === 'GET') {
      try {
        return sendJson(res, 200, registry.getOrchestratorThread(session.id));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load orchestrator thread.' });
      }
    }

    if (parts.length === 5 && parts[3] === 'orchestrator' && parts[4] === 'messages' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
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
          targetUrl: body.targetUrl,
          attachments: body.attachments,
          baseUrl: origin,
          discoveryUrl: `${origin}/api/agent-tools/discovery`,
          nextActionUrl: `${origin}/api/agent-tools/next-action?role=orchestrator&projectId=${encodeURIComponent(session.projectId)}&sessionId=${encodeURIComponent(session.id)}`,
        }, {
          actor: body.actor || 'dashboard',
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
      if (method === 'GET') return sendJson(res, 200, registry.listLanes(session.id));
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
        try {
          const lane = await registry.createLane(session.id, body, {
            actor: body.actor || 'dashboard',
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

    if (parts.length === 4 && parts[3] === 'audit-done-lanes' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
      try {
        const result = await registry.queueDoneLanesAudit(session.id, { ...body, actor: body.actor || 'dashboard' });
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
