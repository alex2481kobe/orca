// MCP API route group (/api/mcp/*), ctx-threaded. One route lives here:
// POST /api/mcp/orchestrator-bootstrap, which mints the scoped orchestrator lease
// an agent's MCP client connects with. Returns FALL_THROUGH when nothing matched
// so the caller continues to the global 404.
//
// The custom-MCP-tool CRUD that used to live here (GET/POST/PATCH/DELETE
// /api/mcp/tools) is gone: it let an operator register arbitrary host commands as
// per-lane MCP servers, had no UI and no agent tool, and was exercised only by its
// own tests. A lane now gets exactly one MCP server — Orca's own.

import { FALL_THROUGH } from './lanes.js';

export async function handleMcpRoutes(ctx, req, res, method, parts) {
  const {
    registry,
    sendJson,
    sendBodyError,
    parseJsonBody,
    rejectSpoofedActor,
    requireAdminAuth,
  } = ctx;

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

  return FALL_THROUGH;
}
