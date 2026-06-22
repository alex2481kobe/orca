// Auth API route group (/api/auth/*: status, pairing-code, pair, logout,
// device revoke) extracted from server.js as a factory. The handler is tightly
// coupled to the auth primitives + session store, so the caller injects them
// via closure (keeps the cache-busted test harness's fresh singletons).

export function createAuthApi(deps) {
  const {
    registry, authSessions, sendJson, sendBodyError, parseJsonBody,
    rejectSpoofedActor, requestOrigin, sameOriginAllowed, currentBrowserSession,
    hasValidApiToken, isLocalBootstrapAdmin, requireAdminAuth, requireOperatorAuth,
    requireMutatingToken, buildSessionCookie, buildClearSessionCookie,
    API_TOKEN, WORKER_TOKEN, SESSION_COOKIE_NAME,
  } = deps;

  function hasPositiveSameOriginSignal(req) {
    const origin = req.headers.origin || '';
    if (origin) return sameOriginAllowed(req);
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite === 'same-origin') return true;
    const referer = req.headers.referer || req.headers.referrer || '';
    if (!referer) return false;
    try {
      return new URL(String(referer)).origin === requestOrigin(req);
    } catch {
      return false;
    }
  }

  async function handleAuthApi(req, res, method, parts) {
  if (parts[2] === 'status' && method === 'GET') {
    let session = currentBrowserSession(req);
    // Bridge token/local-bootstrap auth to a cookie session so same-origin asset
    // loads (evidence <img>, artifact downloads) — which cannot carry the token
    // header — authenticate. Only for an already-authenticated, same-origin admin
    // browser without an existing session; never weakens auth (token holder is
    // already an admin).
    const tokenAuthenticated = hasValidApiToken(req);
    const localBootstrapAuthenticated = isLocalBootstrapAdmin(req) && hasPositiveSameOriginSignal(req);
    if (!session && sameOriginAllowed(req) && (tokenAuthenticated || localBootstrapAuthenticated)) {
      try {
        const minted = authSessions.createTrustedSession({
          label: 'Workstation browser',
          userAgent: req.headers['user-agent'] || '',
          remoteAddress: req.socket?.remoteAddress || '',
        });
        res.setHeader('Set-Cookie', buildSessionCookie(req, minted.sessionToken, minted.maxAgeSeconds));
        session = minted.session;
      } catch {
        /* fall through: status still returns token-auth info */
      }
    }
    return sendJson(res, 200, {
      apiTokenRequired: Boolean(API_TOKEN),
      apiTokenAuthenticated: tokenAuthenticated,
      browserSessionSupported: true,
      browserSessionAuthenticated: Boolean(session),
      session,
      sameOrigin: sameOriginAllowed(req),
      cookieName: SESSION_COOKIE_NAME,
      cookieSecure: requestOrigin(req).startsWith('https://'),
      origin: requestOrigin(req),
    });
  }

  if (parts[2] === 'pairing-codes' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const pairing = authSessions.createPairingCode({
        actor: body.actor || 'dashboard',
        label: body.label || 'Phone/browser pairing',
        ttlMs: body.ttlMs,
      });
      return sendJson(res, 201, {
        pairing,
        warning: 'Pairing codes are one-time secrets. Do not paste them into logs, URLs, screenshots, or docs.',
      });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not create pairing code.',
      });
    }
  }

  if (parts[2] === 'pair' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      const result = authSessions.consumePairingCode(body.code, {
        label: body.label || 'Paired browser',
        userAgent: req.headers['user-agent'] || '',
        remoteAddress: req.socket?.remoteAddress || '',
        deviceId: body.deviceId || '',
      });
      res.setHeader('Set-Cookie', buildSessionCookie(req, result.sessionToken, result.maxAgeSeconds));
      // Push an SSE `update` so the workstation dashboard reflects the new paired
      // device (and clears/confirms the pairing code) within ~0.5s — not the next
      // slow poll. Pairing lives in the auth store, so bump the stream revision.
      registry.bumpStreamRevision?.();
      return sendJson(res, 200, {
        paired: true,
        session: result.session,
        maxAgeSeconds: result.maxAgeSeconds,
      });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not pair browser session.',
      });
    }
  }

  if (parts[2] === 'sessions' && method === 'GET') {
    // Read-only view of paired devices; any operator may see its own device
    // set. Minting codes and revoking other devices remain admin-only.
    if (!requireOperatorAuth(req, res)) return;
    return sendJson(res, 200, {
      sessions: authSessions.listSessions(),
    });
  }

  if (parts[2] === 'logout' && method === 'POST') {
    if (!requireMutatingToken(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    // Revoking a session OTHER than your own (by id) is device management and
    // requires admin; revoking your own cookie is always allowed for an operator.
    if (body.sessionId && !requireAdminAuth(req, res)) return;
    try {
      const sessionToken = authSessions.sessionTokenFromCookieHeader(req.headers.cookie || '');
      if (body.sessionId) {
        // Revoking ANOTHER device (device management). Must NOT clear the
        // requester's own cookie — otherwise the admin revoking a paired phone
        // logs themselves out and the dashboard "closes".
        const result = authSessions.revokeSessionId(String(body.sessionId), { actor: body.actor || 'dashboard' });
        registry.bumpStreamRevision?.(); // live-update other dashboards' device lists
        return sendJson(res, 200, result);
      }
      // Revoking your OWN session (logout): clear the cookie on this browser.
      const result = authSessions.revokeSessionToken(sessionToken, { actor: body.actor || 'dashboard' });
      res.setHeader('Set-Cookie', buildClearSessionCookie(req));
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not revoke browser session.',
      });
    }
  }

  return sendJson(res, 404, { error: 'Auth API route not found.' });
  }

  return { handleAuthApi };
}
