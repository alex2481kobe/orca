// Executor profiles / CLI info API route group (/api/executors/*) extracted
// from server.js. Sibling route checks self-guard on parts[1]; caller gates on
// parts[1]==='executors'. ctx-threaded.

import { FALL_THROUGH } from './lanes.js';

export async function handleExecutorRoutes(ctx, req, res, method, parts) {
  const { registry, sendJson } = ctx;
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

  return FALL_THROUGH;
}
