// App backup/export/import + support-bundle API route group (/api/app/*)
// extracted from server.js. ctx-threaded; see server-routes/lanes.js.

import { FALL_THROUGH } from './lanes.js';

export async function handleAppRoutes(ctx, req, res, method, parts) {
  const {
    registry,
    sendJson,
    sendBodyError,
    parseJsonBody,
    rejectSpoofedActor,
    requireAdminAuth,
    applyAppImport,
    validateAppImport,
    buildAppExport,
    buildSupportBundle,
    buildRouteInventory,
  } = ctx;
    if (parts.length === 3 && parts[2] === 'export' && method === 'GET') {
      if (!requireAdminAuth(req, res)) return;
      try {
        return sendJson(res, 200, await buildAppExport({
          registry,
          providerProfiles,
          privateAccess,
          routeInventoryVersion: buildRouteInventory().contractVersion,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not export app backup.',
        });
      }
    }

    if (parts.length === 4 && parts[2] === 'import' && parts[3] === 'dry-run' && method === 'POST') {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, validateAppImport(body));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not validate app import.',
          blockedKeys: error.blockedKeys || undefined,
        });
      }
    }

    if (parts.length === 4 && parts[2] === 'import' && parts[3] === 'apply' && method === 'POST') {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      const actor = body.actor || 'dashboard';
      const approved = body.approved === true;
      const policyCheck = registry.evaluateActionPolicy('manageAppBackups', { actor, approved });
      if (!policyCheck.allowed) {
        return sendJson(res, 409, {
          error: policyCheck.message,
          requiresApproval: true,
          risk: policyCheck.policy.risk,
        });
      }
      try {
        return sendJson(res, 200, await applyAppImport(body.payload || body, {
          registry,
          providerProfiles,
          privateAccess,
          actor,
          approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not apply app import.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
          blockedKeys: error.blockedKeys || undefined,
        });
      }
    }

    if (parts.length === 3 && parts[2] === 'support-bundle' && method === 'GET') {
      if (!requireAdminAuth(req, res)) return;
      try {
        return sendJson(res, 200, await buildSupportBundle({
          registry,
          providerProfiles,
          privateAccess,
          routeInventory: buildRouteInventory(),
          blockers: await registry.describeSystemBlockers(),
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not build support bundle.',
        });
      }
    }

  return FALL_THROUGH;
}
