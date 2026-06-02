// Executor profiles / CLI info / reinstall API route group (/api/executors/*)
// extracted from server.js. Three sibling route checks self-guard on parts[1];
// caller gates on parts[1]==='executors'. ctx-threaded.

import { FALL_THROUGH } from './lanes.js';

export async function handleExecutorRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, requireAdminAuth } = ctx;
  if (parts[1] === 'executors' && parts[2] === 'profiles' && method === 'GET') {
    // Enrich each executor profile with its detected capabilities so the lane
    // form can render per-CLI permission modes, intelligence/effort levels,
    // model values, and workflow/background-agent options dynamically.
    const baseProfiles = registry.getExecutorProfiles() || {};
    const profiles = {};
    for (const [type, profile] of Object.entries(baseProfiles)) {
      let capabilities = null;
      try {
        capabilities = registry.getExecutorCapabilities(type);
      } catch { /* leave null if capabilities cannot be detected */ }
      profiles[type] = { ...profile, capabilities };
    }
    return sendJson(res, 200, {
      profiles,
      orcaApiEndpoint: '/api/executors/profiles',
    });
  }

  if (parts[1] === 'executors' && parts[2] && parts[3] === 'cli' && method === 'GET' && parts.length === 4) {
    try {
      const info = registry.getExecutorCliInfo(parts[2]);
      return sendJson(res, 200, info);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not load executor CLI info.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts[1] === 'executors' && ['codex', 'claude'].includes(parts[2]) && parts[3] === 'cli' && parts[4] === 'reinstall' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await registry.runExecutorCliReinstall(parts[2], {
        actor: body.actor || 'dashboard',
        approved: body.approved,
        execute: Boolean(body.execute),
        command: body.command,
        confirmed: body.confirmed,
        useSource: Boolean(body.useSource),
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not run CLI management action.',
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  return FALL_THROUGH;
}
