// App backup redaction + public-shaping helpers. Extracted from app-backup.js;
// import/export/support orchestration lives in transfer.js.

export const APP_BACKUP_SCHEMA_VERSION = 1;
export const APP_EXPORT_KIND = 'orca.app-export';
export const SUPPORT_BUNDLE_KIND = 'orca.support-bundle';

export const ACTIVE_LANE_STATES = new Set(['queued', 'starting', 'running', 'auditing']);
const BLOCKED_IMPORT_KEYS = new Set([
  'authSessions',
  'pairingCodes',
  'cookies',
  'sessionToken',
  'sessionTokens',
  'rawToken',
  'apiToken',
  'workerToken',
  'secretValue',
  'apiKey',
  'password',
  'artifacts',
  'screenshots',
  'videos',
  'traces',
  'logs',
]);

export function nowIso() {
  return new Date().toISOString();
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function redactText(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    // Provider key prefixes: OpenAI (sk-, sk-ant-), HuggingFace (hf_),
    // Google (AIza...), GitHub (gh[pousr]_), Anthropic admin, xAI (xai-), etc.
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(?:hf|gh[pousr]|xai|or)[_-][A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_SECRET]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD|COOKIE)[A-Z0-9_]*)\s*[:=]\s*['"]?[^'"\s,;}]+/gi, '$1=[REDACTED]')
    .replace(/\/Users\/[^/\s"'`]+(?:\/[^\s"'`]*)?/g, '[LOCAL_PATH]')
    .replace(/\/private\/var\/folders\/[^\s"'`]*/g, '[LOCAL_PATH]');
}

export function sanitizePrimitive(value) {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return null;
}

export function isBlockedKey(key) {
  // Prototype-pollution keys are always blocked (rejected on import, dropped on
  // redaction). JSON.parse exposes a literal "__proto__" as an own key.
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
  if (key === 'apiKeyEnv' || key === 'secretRef') return false;
  if (BLOCKED_IMPORT_KEYS.has(key)) return true;
  // Targeted secret-bearing key patterns; kept narrow so legit metadata keys
  // (credential, secretPriority) are not dropped.
  return /secretValue|^apiKey$|password|cookie|pairing|rawToken|sessionToken|bearer|authorization/i.test(key);
}

export function redactDeep(value, { dropKeys = BLOCKED_IMPORT_KEYS } = {}) {
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, { dropKeys }));
  if (!value || typeof value !== 'object') return sanitizePrimitive(value);
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (dropKeys.has(key) && key !== 'apiKeyEnv' && key !== 'secretRef') continue;
    if (isBlockedKey(key)) continue;
    out[key] = redactDeep(raw, { dropKeys });
  }
  return out;
}

export function publicProject(project) {
  return redactDeep({
    id: project.id,
    name: project.name,
    slug: project.slug,
    route: project.route,
    notes: project.notes,
    quickLinks: project.quickLinks,
    settingsOverrides: project.settingsOverrides,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

export function publicSession(session) {
  return redactDeep({
    id: session.id,
    projectId: session.projectId,
    name: session.name,
    leader: session.leader,
    route: session.route,
    laneConcurrencyLimit: session.laneConcurrencyLimit,
    approvedCapacity: session.approvedCapacity,
    spawnPolicy: session.spawnPolicy,
    idleShutdownMode: session.idleShutdownMode,
    worktreeMode: session.worktreeMode,
    capacityRequests: session.capacityRequests,
    supervisorReview: session.supervisorReview,
    settingsOverrides: session.settingsOverrides,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
}

export function publicLane(lane) {
  const state = ACTIVE_LANE_STATES.has(lane.state) ? 'stopped' : lane.state;
  return redactDeep({
    id: lane.id,
    projectId: lane.projectId,
    projectSlug: lane.projectSlug,
    sessionId: lane.sessionId,
    title: lane.title,
    taskDescription: lane.taskDescription,
    executorType: lane.executorType,
    owner: lane.owner,
    state,
    importedFromState: state !== lane.state ? lane.state : undefined,
    exitReason: state !== lane.state ? 'Imported backup; active runtime was not restored.' : lane.exitReason,
    route: lane.route,
    model: lane.model,
    permissionsProfile: lane.permissionsProfile,
    targetUrl: lane.targetUrl,
    mcpTools: lane.mcpTools,
    settingsOverrides: lane.settingsOverrides,
    critiqueMode: lane.critiqueMode,
    critiqueState: lane.critiqueState,
    auditState: lane.auditState,
    createdAt: lane.createdAt,
    updatedAt: lane.updatedAt,
    completedAt: lane.completedAt,
  });
}

export function publicAuditEvent(event) {
  return redactDeep({
    id: event.id,
    type: event.type,
    actor: event.actor,
    status: event.status,
    projectId: event.projectId,
    sessionId: event.sessionId,
    laneId: event.laneId,
    summary: event.summary,
    createdAt: event.createdAt,
    followUpQueued: event.followUpQueued,
  });
}

export function publicNotification(notification) {
  return redactDeep({
    id: notification.id,
    type: notification.type,
    severity: notification.severity,
    title: notification.title,
    body: notification.body,
    projectId: notification.projectId,
    sessionId: notification.sessionId,
    laneId: notification.laneId,
    href: notification.href,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
  });
}

export function publicMcpTool(tool) {
  return redactDeep({
    id: tool.id,
    name: tool.name,
    command: tool.command,
    args: tool.args,
    scope: tool.scope,
    enabled: tool.enabled,
    description: tool.description,
    owner: tool.owner,
    notes: tool.notes,
    workdir: tool.workdir,
  });
}

export function publicPrivateAccess(state) {
  return {
    version: state.version || 1,
    settings: redactDeep(state.settings || {}),
    targets: asArray(state.targets).map((target) => redactDeep(target)),
  };
}

export function buildRegistryExport(registry) {
  const snapshot = registry.snapshotState();
  return {
    version: snapshot.version || 1,
    policies: redactDeep(snapshot.policies || {}),
    projects: asArray(snapshot.projects).map(publicProject),
    sessions: asArray(snapshot.sessions).map(publicSession),
    lanes: asArray(snapshot.lanes).map(publicLane),
    auditEvents: asArray(snapshot.auditEvents).slice(0, 200).map(publicAuditEvent),
    cleanupSchedule: redactDeep(snapshot.cleanupSchedule || {}),
    mcpTools: asArray(snapshot.mcpTools).map(publicMcpTool),
    notifications: asArray(snapshot.notifications).slice(0, 200).map(publicNotification),
    notificationSettings: redactDeep(snapshot.notificationSettings || {}),
  };
}
