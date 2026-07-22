const STREAM_CONTRACT_VERSION = 'orca.streams.v1';
const DEFAULT_STREAM_HEARTBEAT_MS = 15_000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// The main event stream is a CHANGE SIGNAL, not a data channel. The client uses
// it only to learn "the world advanced to revision N" and then re-fetches through
// the tiered data API (compact lane list, focused lane detail, per-lane terminal
// SSE) — the single source of truth for state. So the frame stays deliberately
// tiny: the revision plus O(1)-ish counts (array lengths + one pending-audit
// pass). No lane/audit bodies are serialized here, which is what keeps the stream
// flat as lane/log volume grows (the old snapshot re-compacted up to 75 items on
// every revision bump and every heartbeat, for every connection).
function buildStreamSignal(registry) {
  const projects = Array.isArray(registry.projects) ? registry.projects : [];
  const orchestrators = Array.isArray(registry.orchestrators) ? registry.orchestrators : [];
  const lanes = Array.isArray(registry.lanes) ? registry.lanes : [];
  const auditEvents = Array.isArray(registry.auditEvents) ? registry.auditEvents : [];
  let pendingAudits = 0;
  for (const event of auditEvents) if (event && event.status === 'pending') pendingAudits += 1;
  return {
    contractVersion: STREAM_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    revision: typeof registry.getStreamRevision === 'function' ? registry.getStreamRevision() : 0,
    counts: {
      projects: projects.length,
      orchestrators: orchestrators.length,
      lanes: lanes.length,
      auditEvents: auditEvents.length,
      pendingAudits,
    },
  };
}

function sseFrame(event, data) {
  // Strip CR/LF from the event name so a dynamic value can never inject extra
  // SSE fields/events into the stream.
  const safeEvent = String(event || 'message').replace(/[\r\n]/g, '');
  return `event: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeSse(res, event, data) {
  res.write(sseFrame(event, data));
}

function streamHeartbeatMs() {
  return parsePositiveInteger(process.env.ORCA_STREAM_HEARTBEAT_MS, DEFAULT_STREAM_HEARTBEAT_MS);
}

// The signal is identical for all clients at a given revision, so memoize it by
// revision and share it — the build (count pass) runs once per actual change
// instead of N-connections × ticks-per-second.
let _signalCache = { revision: -1, value: null };
function buildStreamSignalCached(registry) {
  const rev = typeof registry.getStreamRevision === 'function' ? registry.getStreamRevision() : 0;
  if (_signalCache.value && _signalCache.revision === rev) return _signalCache.value;
  const value = buildStreamSignal(registry);
  _signalCache = { revision: rev, value };
  return value;
}

export {
  STREAM_CONTRACT_VERSION,
  buildStreamSignal,
  buildStreamSignalCached,
  sseFrame,
  streamHeartbeatMs,
  writeSse,
};
