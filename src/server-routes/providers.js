// Provider profiles API route group (/api/providers/*) extracted from
// server.js. ctx-threaded. Self-contained: always responds.

export async function handleProvidersApi(ctx, req, res, method, parts) {
  const { providerProfiles, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, requireAdminAuth } = ctx;
  if (parts.length === 2 && method === 'GET') {
    try {
      return sendJson(res, 200, await providerProfiles.listProfiles());
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not list provider profiles.' });
    }
  }

  if (parts.length === 3 && parts[2] === 'export' && method === 'GET') {
    if (!requireAdminAuth(req, res)) return;
    try {
      return sendJson(res, 200, await providerProfiles.exportProfiles());
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not export provider profiles.' });
    }
  }

  if (parts.length === 4 && parts[2] === 'import' && parts[3] === 'dry-run' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      return sendJson(res, 200, await providerProfiles.importDryRun(body));
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not dry-run provider import.',
        errors: error.errors || [],
      });
    }
  }

  if (parts.length === 4 && parts[2] === 'import' && parts[3] === 'apply' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      return sendJson(res, 200, await providerProfiles.importApply(body, {
        actor: body.actor || 'dashboard',
        approved: body.approved,
      }));
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not apply provider import.',
        errors: error.errors || [],
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts.length >= 3) {
    const providerId = parts[2];
    if (parts.length === 3 && method === 'GET') {
      try {
        return sendJson(res, 200, await providerProfiles.getProfile(providerId));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load provider profile.' });
      }
    }
    if (parts.length === 3 && method === 'PATCH') {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, await providerProfiles.updateProfile(providerId, body, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not update provider profile.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
    if (parts.length === 4 && parts[3] === 'health' && method === 'GET') {
      try {
        return sendJson(res, 200, await providerProfiles.health(providerId));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not check provider health.' });
      }
    }
    if (parts.length === 4 && parts[3] === 'secret' && method === 'POST') {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, await providerProfiles.setSecret(providerId, body.secret, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not set provider secret.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
    if (parts.length === 4 && parts[3] === 'secret' && method === 'DELETE') {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, await providerProfiles.deleteSecret(providerId, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not delete provider secret.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
  }

  return sendJson(res, 404, { error: 'Provider API route not found.' });
}
