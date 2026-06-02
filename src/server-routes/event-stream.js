// Server-sent events stream handler (/api/streams/events) extracted from
// server.js as a factory. Stream plumbing is imported directly; request-scoped
// deps (registry, auth, header/JSON helpers) are injected via closure.

import { buildStreamSnapshot, streamHeartbeatMs, writeSse } from '../event-streams.js';

export function createEventStream(deps) {
  const { registry, applySecurityHeaders, setCacheHeaders, sendJson, getSearchParams, hasStreamAuth } = deps;

  function handleEventStream(req, res) {
  if (!hasStreamAuth(req)) {
    return sendJson(res, 401, {
      error: 'Unauthorized stream. Supply a valid ORCA_API_TOKEN header or pair this browser session.',
    });
  }
  const searchParams = getSearchParams(req.url || '/');
  if (!searchParams) return sendJson(res, 400, { error: 'Invalid request query string.' });
  const once = searchParams.get('once') === 'true';
  const startedAt = new Date().toISOString();
  res.statusCode = 200;
  applySecurityHeaders(res);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  setCacheHeaders(res);
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Orca-Stream', 'events');
  writeSse(res, 'stream_open', {
    contractVersion: 'orca.streams.v1',
    startedAt,
    heartbeatMs: streamHeartbeatMs(),
  });
  writeSse(res, 'snapshot', buildStreamSnapshot(registry));
  if (once) {
    writeSse(res, 'stream_close', {
      reason: 'once',
      closedAt: new Date().toISOString(),
    });
    res.end();
    return undefined;
  }
  // Poll the registry revision frequently so changes are pushed live as `update`
  // events; emit `heartbeat` at the slower configured cadence as a keepalive.
  const heartbeatMs = streamHeartbeatMs();
  const pollMs = Math.max(250, Math.min(heartbeatMs, 700));
  let lastRevision = typeof registry.getStreamRevision === 'function' ? registry.getStreamRevision() : 0;
  let lastHeartbeatAt = Date.now();
  const interval = setInterval(() => {
    if (!hasStreamAuth(req)) {
      writeSse(res, 'stream_close', {
        reason: 'auth_revoked',
        closedAt: new Date().toISOString(),
      });
      clearInterval(interval);
      res.end();
      return;
    }
    const revision = typeof registry.getStreamRevision === 'function' ? registry.getStreamRevision() : 0;
    if (revision !== lastRevision) {
      lastRevision = revision;
      writeSse(res, 'update', buildStreamSnapshot(registry));
    }
    if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = Date.now();
      writeSse(res, 'heartbeat', {
        at: new Date().toISOString(),
        revision,
        counts: buildStreamSnapshot(registry).counts,
      });
    }
  }, pollMs);
  if (typeof interval.unref === 'function') interval.unref();
  const stopHeartbeat = () => clearInterval(interval);
  if (typeof res.on === 'function') res.on('close', stopHeartbeat);
  // Guard against the response 'close' not firing (client disconnect): also
  // clear on the request socket closing so the heartbeat interval can't leak.
  if (typeof req.on === 'function') req.on('close', stopHeartbeat);
  return undefined;
  }

  return { handleEventStream };
}
