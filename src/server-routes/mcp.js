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
    hasAdminAuth,
  } = ctx;
  // MCP tool `env` holds raw secrets (e.g. GITHUB_TOKEN) the host injects into the
  // tool's command. Only admins (workstation/token) may read the values; for an
  // operator/paired device, expose the env KEYS but never the values — mirrors how
  // provider profiles redact secret material for non-admins.
  const redactToolEnv = (tool) => {
    if (!tool || !tool.env || typeof tool.env !== 'object') return tool;
    const keysOnly = {};
    for (const key of Object.keys(tool.env)) keysOnly[key] = '••••••';
    return { ...tool, env: keysOnly };
  };
  const redactToolsForCaller = (tools) => (hasAdminAuth(req)
    ? tools
    : tools.map(redactToolEnv));
  if (parts[1] === 'mcp' && parts[2] === 'tools' && parts.length === 3 && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) {
      return sendJson(res, 400, {
        error: 'Invalid request query string.',
      });
    }
    const scopeRaw = searchParams.get('scope');
    const scope = String(scopeRaw || '').trim().toLowerCase();
    const tools = redactToolsForCaller(registry.getMcpTools(null));
    if (!scope) {
      return sendJson(res, 200, tools);
    }
    const filtered = tools.filter((tool) => Array.isArray(tool.scope) && tool.scope.includes(scope));
    return sendJson(res, 200, filtered);
  }

  if (parts[1] === 'mcp' && parts[2] === 'orchestrator-bootstrap' && parts.length === 3 && method === 'POST') {
    // Mints a powerful, long-lived (12h) orchestrator tool-lease token usable
    // OFF-origin (bypasses the cookie+SameSite CSRF protection). That is a
    // host-level credential, so it requires ADMIN — a paired operator (phone)
    // must not be able to escalate by calling this.
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = registry.createOrchestratorMcpBootstrap({
        role: 'orchestrator',
        projectId: body.projectId || null,
        sessionId: body.sessionId || null,
        ttlMs: body.ttlMs,
        actor: body.actor || 'desktop-app',
        nodePath: typeof body.nodePath === 'string' ? body.nodePath : null,
      });
      return sendJson(res, 201, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not create MCP bootstrap.',
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
    return sendJson(res, 200, hasAdminAuth(req) ? tool : redactToolEnv(tool));
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
