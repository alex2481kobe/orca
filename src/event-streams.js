const STREAM_CONTRACT_VERSION = 'orca.streams.v1';
const DEFAULT_STREAM_HEARTBEAT_MS = 15_000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeString(value, max = 160) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
}

function compactLane(lane) {
  return {
    id: lane.id,
    projectId: lane.projectId,
    sessionId: lane.sessionId,
    title: sanitizeString(lane.title, 120),
    state: lane.state,
    executorType: lane.executorType,
    owner: sanitizeString(lane.owner, 80),
    critiqueMode: lane.critiqueMode || 'suggested',
    critiqueState: lane.critiqueState || 'not_required',
    auditState: lane.auditState || 'not_queued',
    updatedAt: lane.updatedAt || null,
    completedAt: lane.completedAt || null,
    route: lane.route || null,
  };
}

function compactAuditEvent(event) {
  return {
    id: event.id,
    type: event.type,
    status: event.status,
    projectId: event.projectId || null,
    sessionId: event.sessionId || null,
    laneId: event.laneId || null,
    createdAt: event.createdAt || event.at || null,
    followUpQueued: Boolean(event.followUpQueued),
  };
}

function buildStreamSnapshot(registry) {
  const projects = Array.isArray(registry.projects) ? registry.projects : [];
  const sessions = Array.isArray(registry.sessions) ? registry.sessions : [];
  const lanes = Array.isArray(registry.lanes) ? registry.lanes : [];
  const auditEvents = Array.isArray(registry.auditEvents) ? registry.auditEvents : [];
  const pendingAudits = auditEvents
    .filter((event) => event && event.status === 'pending')
    .slice(0, 25)
    .map(compactAuditEvent);
  const activeLanes = lanes
    .filter((lane) => ['queued', 'starting', 'running', 'needs_critique', 'ready_for_audit', 'fix_requested', 'blocked'].includes(lane.state))
    .slice(0, 50)
    .map(compactLane);
  return {
    contractVersion: STREAM_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    revision: typeof registry.getStreamRevision === 'function' ? registry.getStreamRevision() : 0,
    counts: {
      projects: projects.length,
      sessions: sessions.length,
      lanes: lanes.length,
      auditEvents: auditEvents.length,
      pendingAudits: pendingAudits.length,
      activeLanes: activeLanes.length,
    },
    activeLanes,
    pendingAudits,
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

// The SSE handler polls per-connection (≤700ms) and built the full snapshot on
// EVERY connection's tick (and twice on a heartbeat). The snapshot is identical for
// all clients at a given revision, so memoize it by revision and share it — the
// build (filter all lanes + audits, compact up to 75 items) now runs once per
// actual change instead of N-connections × ticks-per-second.
let _snapshotCache = { revision: -1, value: null };
function buildStreamSnapshotCached(registry) {
  const rev = typeof registry.getStreamRevision === 'function' ? registry.getStreamRevision() : 0;
  if (_snapshotCache.value && _snapshotCache.revision === rev) return _snapshotCache.value;
  const value = buildStreamSnapshot(registry);
  _snapshotCache = { revision: rev, value };
  return value;
}

export {
  STREAM_CONTRACT_VERSION,
  buildStreamSnapshot,
  buildStreamSnapshotCached,
  sseFrame,
  streamHeartbeatMs,
  writeSse,
};
