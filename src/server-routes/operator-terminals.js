import { FALL_THROUGH } from './lanes.js';

export async function handleOperatorTerminalRoutes(ctx, req, res, method, parts) {
  const {
    operatorTerminals,
    sendJson,
    sendBodyError,
    parseJsonBody,
    rejectSpoofedActor,
    getSearchParams,
    requireAdminAuth,
  } = ctx;

  const sessionTerminalRoute = parts[1] === 'sessions' && parts[2] && parts[3] === 'terminals';
  const terminalRoute = parts[1] === 'terminals' && parts[2];
  if (!sessionTerminalRoute && !terminalRoute) return FALL_THROUGH;
  if (!requireAdminAuth(req, res)) return undefined;

  if (sessionTerminalRoute && parts.length === 4 && method === 'GET') {
    try {
      return sendJson(res, 200, {
        sessionId: parts[2],
        terminals: operatorTerminals.listForSession(parts[2]),
      });
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not list terminals.' });
    }
  }

  if (sessionTerminalRoute && parts.length === 4 && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return undefined;
    try {
      const terminal = await operatorTerminals.start(parts[2], body, {
        actor: body.actor || 'dashboard',
      });
      return sendJson(res, 201, terminal);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not start terminal.' });
    }
  }

  if (terminalRoute && parts.length === 3 && method === 'GET') {
    try {
      return sendJson(res, 200, operatorTerminals.get(parts[2]));
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not read terminal.' });
    }
  }

  if (terminalRoute && parts.length === 4 && parts[3] === 'tail' && method === 'GET') {
    const searchParams = getSearchParams(req.url || '/');
    if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
    try {
      const tail = operatorTerminals.tail(parts[2], {
        offset: searchParams.get('offset'),
        maxChars: searchParams.get('maxChars') || searchParams.get('maxBytes'),
      });
      return sendJson(res, 200, tail);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not read terminal output.' });
    }
  }

  if (terminalRoute && parts.length === 4 && parts[3] === 'input' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return undefined;
    try {
      const terminal = operatorTerminals.writeInput(parts[2], body.input, {
        actor: body.actor || 'dashboard',
        raw: Boolean(body.raw),
      });
      return sendJson(res, 200, terminal);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not write terminal input.' });
    }
  }

  if (terminalRoute && parts.length === 4 && parts[3] === 'resize' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return undefined;
    try {
      const terminal = operatorTerminals.resize(parts[2], body, {
        actor: body.actor || 'dashboard',
      });
      return sendJson(res, 200, terminal);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not resize terminal.' });
    }
  }

  if (terminalRoute && parts.length === 4 && parts[3] === 'stop' && method === 'POST') {
    const body = await parseJsonBody(req).catch(() => ({}));
    if (rejectSpoofedActor(body || {}, res)) return undefined;
    try {
      const terminal = await operatorTerminals.stop(parts[2], {
        actor: body?.actor || 'dashboard',
      });
      return sendJson(res, 200, terminal);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not stop terminal.' });
    }
  }

  return sendJson(res, 404, { error: 'Terminal route not found.' });
}
