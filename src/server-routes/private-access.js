// Private access (tailnet/Funnel) API route group (/api/private-access/*)
// extracted from server.js. ctx-threaded. Self-contained: always responds.

export async function handlePrivateAccessApi(ctx, req, res, method, parts) {
  const { privateAccess, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, getSearchParams, requestOrigin, requireAdminAuth } = ctx;
  if (parts.length === 2 && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
    const fakeState = searchParams.get('fakeTailnetState') || searchParams.get('fake') || null;
    const data = await privateAccess.describe({
      origin: requestOrigin(req),
      fakeTailnetState: fakeState,
    });
    return sendJson(res, 200, data);
  }

  if (parts.length === 3 && parts[2] === 'tailnet' && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
    return sendJson(res, 200, privateAccess.tailnetState(searchParams.get('fake') || null));
  }

  if (parts.length === 3 && parts[2] === 'setup-plan' && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
    try {
      const plan = await privateAccess.setupPlan({
        localUrl: searchParams.get('localUrl') || requestOrigin(req),
        httpPort: searchParams.get('httpPort') || 80,
        httpsPort: searchParams.get('httpsPort') || 443,
      });
      return sendJson(res, 200, plan);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not build setup plan.' });
    }
  }

  if (parts.length === 3 && parts[2] === 'serve' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await privateAccess.configureServe({
        action: body.action === 'disable' ? 'disable' : 'enable',
        port: body.port || 3000,
      });
      return sendJson(res, result.ok ? 200 : 422, result);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not configure Tailscale Serve.' });
    }
  }

  if (parts.length === 3 && parts[2] === 'settings' && method === 'PATCH') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const settings = await privateAccess.updateSettings(body, { actor: body.actor || 'dashboard' });
      return sendJson(res, 200, settings);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not update private access settings.' });
    }
  }

  if (parts.length === 3 && parts[2] === 'targets' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const target = await privateAccess.createTarget(body, { actor: body.actor || 'dashboard' });
      return sendJson(res, 201, target);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not create private access target.' });
    }
  }

  if (parts.length === 4 && parts[2] === 'targets' && method === 'PATCH') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const target = await privateAccess.updateTarget(parts[3], body, { actor: body.actor || 'dashboard' });
      return sendJson(res, 200, target);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not update private access target.' });
    }
  }

  if (parts.length === 4 && parts[2] === 'targets' && method === 'DELETE') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await privateAccess.deleteTarget(parts[3], { actor: body.actor || 'dashboard' });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not delete private access target.' });
    }
  }

  if (parts.length === 5 && parts[2] === 'targets' && parts[4] === 'check' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = await privateAccess.checkTarget(parts[3], { actor: body.actor || 'dashboard' });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not check private access target.' });
    }
  }

  return sendJson(res, 404, { error: 'Private access API route not found.' });
}
