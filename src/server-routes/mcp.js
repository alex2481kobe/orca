// MCP tools API route group (/api/mcp/*) extracted from server.js into a
// ctx-threaded handler. The six sibling route checks self-guard on parts[1],
// so the caller gates on parts[1]==='mcp'. Returns FALL_THROUGH when no mcp
// sub-route matched (caller continues to the global 404).

import { FALL_THROUGH } from './lanes.js';

export async function handleMcpRoutes(ctx, req, res, method, parts) {
  const {
    registry,
    sendJson,
    sendBodyError,
    parseJsonBody,
    rejectSpoofedActor,
    getSearchParams,
    requireAdminAuth,
  } = ctx;
  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 3 && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) {
      return sendJson(res, 400, {
        error: 'Invalid request query string.',
      });
    }
    const scopeRaw = searchParams.get('scope');
    const scope = String(scopeRaw || '').trim().toLowerCase();
    const tools = registry.getMcpTools(null);
    if (!scope) {
      return sendJson(res, 200, tools);
    }
    const filtered = tools.filter((tool) => Array.isArray(tool.scope) && tool.scope.includes(scope));
    return sendJson(res, 200, filtered);
  }

  if (parts[1] === 'mcp' && parts[2] === 'orchestrator-bootstrap' && parts.length === 3 && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = registry.createOrchestratorMcpBootstrap({
        projectId: body.projectId || null,
        sessionId: body.sessionId || null,
        ttlMs: body.ttlMs,
        actor: body.actor || 'desktop-app',
        nodePath: typeof body.nodePath === 'string' ? body.nodePath : null,
      });
      return sendJson(res, 201, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not create orchestrator MCP bootstrap.',
      });
    }
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && method === 'POST') {
    // MCP tools define executable commands the host runs; mutating them is a
    // host-level (admin) action, not a workflow action paired operators may do.
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.createMcpTool(body, {
        actor: body.actor || 'dashboard',
        approved: body.approved,
      });
      return sendJson(res, 201, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not create MCP tool.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 4 && method === 'GET') {
    const tool = registry.getMcpTool(parts[3]);
    if (!tool) return sendJson(res, 404, { error: 'MCP tool not found.' });
    return sendJson(res, 200, tool);
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 4 && method === 'PATCH') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    const { actor, approved, ...patch } = body;
    try {
      const result = await registry.updateMcpTool(
        parts[3],
        patch,
        {
          actor: actor || 'dashboard',
          approved,
        },
      );
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not update MCP tool.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 4 && method === 'DELETE') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.deleteMcpTool(parts[3], {
        actor: body.actor || 'dashboard',
        approved: body.approved,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not delete MCP tool.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  return FALL_THROUGH;
}
