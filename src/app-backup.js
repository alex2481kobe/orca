const APP_BACKUP_SCHEMA_VERSION = 1;
const APP_EXPORT_KIND = 'command-deck.app-export';
const SUPPORT_BUNDLE_KIND = 'command-deck.support-bundle';

const ACTIVE_LANE_STATES = new Set(['queued', 'starting', 'running', 'auditing']);
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

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function redactText(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD|COOKIE)[A-Z0-9_]*)\s*[:=]\s*['"]?[^'"\s,;}]+/gi, '$1=[REDACTED]')
    .replace(/\/Users\/[^/\s"'`]+(?:\/[^\s"'`]*)?/g, '[LOCAL_PATH]')
    .replace(/\/private\/var\/folders\/[^\s"'`]*/g, '[LOCAL_PATH]');
}

function sanitizePrimitive(value) {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return null;
}

function isBlockedKey(key) {
  if (key === 'apiKeyEnv' || key === 'secretRef') return false;
  if (BLOCKED_IMPORT_KEYS.has(key)) return true;
  return /secretValue|^apiKey$|password|cookie|pairing|rawToken|sessionToken/i.test(key);
}

function redactDeep(value, { dropKeys = BLOCKED_IMPORT_KEYS } = {}) {
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

function publicProject(project) {
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

function publicSession(session) {
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
    capacityRequests: session.capacityRequests,
    settingsOverrides: session.settingsOverrides,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
}

function publicLane(lane) {
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

function publicAuditEvent(event) {
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

function publicNotification(notification) {
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

function publicMcpTool(tool) {
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

function publicPrivateAccess(state) {
  return {
    version: state.version || 1,
    settings: redactDeep(state.settings || {}),
    targets: asArray(state.targets).map((target) => redactDeep(target)),
  };
}

function buildRegistryExport(registry) {
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

async function buildAppExport({
  registry,
  providerProfiles,
  privateAccess,
  routeInventoryVersion = null,
} = {}) {
  await privateAccess.ensureLoaded();
  const providers = await providerProfiles.exportProfiles();
  const registryState = buildRegistryExport(registry);
  const privateAccessState = publicPrivateAccess(privateAccess.state || {});
  return {
    schemaVersion: APP_BACKUP_SCHEMA_VERSION,
    kind: APP_EXPORT_KIND,
    exportedAt: nowIso(),
    excludesSecrets: true,
    includesAuthSessions: false,
    includesArtifacts: false,
    includesLargeEvidence: false,
    localOnly: true,
    routeInventoryVersion,
    counts: {
      projects: registryState.projects.length,
      sessions: registryState.sessions.length,
      lanes: registryState.lanes.length,
      providers: asArray(providers.profiles).length,
      privateAccessTargets: privateAccessState.targets.length,
      mcpTools: registryState.mcpTools.length,
      notifications: registryState.notifications.length,
    },
    registry: registryState,
    providers,
    privateAccess: privateAccessState,
    uiPreferences: {
      serverManaged: false,
      note: 'Client-only UI preferences such as sidebar order are not stored on the server.',
    },
  };
}

function detectBlockedImportKeys(value, path = '') {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...detectBlockedImportKeys(item, `${path}[${index}]`)));
    return hits;
  }
  if (!value || typeof value !== 'object') return hits;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isBlockedKey(key)) {
      hits.push(childPath);
      continue;
    }
    hits.push(...detectBlockedImportKeys(child, childPath));
  }
  return hits;
}

function validateAppImport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw { status: 422, message: 'App import requires a JSON object.' };
  }
  if (payload.schemaVersion !== APP_BACKUP_SCHEMA_VERSION || payload.kind !== APP_EXPORT_KIND) {
    throw { status: 422, message: 'Unsupported app import schema or kind.' };
  }
  const blockedKeys = detectBlockedImportKeys(payload);
  if (blockedKeys.length) {
    throw {
      status: 422,
      message: 'App import contains secret/auth/artifact fields that must not be imported.',
      blockedKeys: blockedKeys.slice(0, 20),
    };
  }

  const registry = payload.registry && typeof payload.registry === 'object' ? payload.registry : {};
  const providers = payload.providers && typeof payload.providers === 'object' ? payload.providers : {};
  const privateAccess = payload.privateAccess && typeof payload.privateAccess === 'object' ? payload.privateAccess : {};
  const activeLanes = asArray(registry.lanes).filter((lane) => ACTIVE_LANE_STATES.has(lane?.state));

  return {
    schemaVersion: APP_BACKUP_SCHEMA_VERSION,
    dryRun: true,
    accepted: true,
    warnings: [
      ...(activeLanes.length ? [`${activeLanes.length} active lane(s) will be imported as stopped.`] : []),
      'Import is non-destructive by default: existing IDs are skipped unless a future replace mode is explicitly implemented.',
    ],
    counts: {
      projects: asArray(registry.projects).length,
      sessions: asArray(registry.sessions).length,
      lanes: asArray(registry.lanes).length,
      providers: asArray(providers.profiles).length,
      privateAccessTargets: asArray(privateAccess.targets).length,
      mcpTools: asArray(registry.mcpTools).length,
      notifications: asArray(registry.notifications).length,
    },
  };
}

function mergeById(existing, incoming) {
  const seen = new Set(asArray(existing).map((item) => item?.id).filter(Boolean));
  const added = [];
  const skipped = [];
  for (const item of asArray(incoming)) {
    if (!item?.id || seen.has(item.id)) {
      skipped.push(item?.id || 'missing-id');
      continue;
    }
    added.push(clone(item));
    seen.add(item.id);
  }
  return { next: [...asArray(existing), ...added], added, skipped };
}

async function applyAppImport(payload, {
  registry,
  providerProfiles,
  privateAccess,
  actor = 'dashboard',
  approved = false,
} = {}) {
  if (!approved) {
    throw {
      status: 409,
      message: 'App import requires explicit approval.',
      requiresApproval: true,
      risk: 'high',
    };
  }
  const dryRun = validateAppImport(payload);
  const sourceRegistry = payload.registry || {};
  const sourcePrivateAccess = payload.privateAccess || {};

  const projects = mergeById(registry.projects, asArray(sourceRegistry.projects).map(publicProject));
  const sessions = mergeById(registry.sessions, asArray(sourceRegistry.sessions).map(publicSession));
  const lanes = mergeById(registry.lanes, asArray(sourceRegistry.lanes).map(publicLane));
  const mcpTools = mergeById(registry.mcpTools, asArray(sourceRegistry.mcpTools).map(publicMcpTool));
  const notifications = mergeById(registry.notifications, asArray(sourceRegistry.notifications).map(publicNotification));

  registry.projects = projects.next;
  registry.sessions = sessions.next;
  registry.lanes = lanes.next;
  registry.mcpTools = mcpTools.next;
  registry.notifications = notifications.next.slice(0, 200);
  if (sourceRegistry.cleanupSchedule && typeof sourceRegistry.cleanupSchedule === 'object') {
    registry.cleanupSchedule = redactDeep(sourceRegistry.cleanupSchedule);
  }
  if (sourceRegistry.notificationSettings && typeof sourceRegistry.notificationSettings === 'object') {
    registry.notificationSettings = redactDeep(sourceRegistry.notificationSettings);
  }
  registry.ensureSessionWorkspaces();

  await providerProfiles.importApply(payload.providers || { schemaVersion: 1, profiles: [] }, {
    actor,
    approved: true,
  });

  await privateAccess.ensureLoaded();
  if (sourcePrivateAccess.settings && typeof sourcePrivateAccess.settings === 'object') {
    privateAccess.state.settings = redactDeep(sourcePrivateAccess.settings);
  }
  const privateTargets = mergeById(privateAccess.state.targets, asArray(sourcePrivateAccess.targets).map((target) => redactDeep(target)));
  privateAccess.state.targets = privateTargets.next;
  privateAccess.recordAudit({
    type: 'app_import_private_access_merged',
    actor,
    summary: `Imported ${privateTargets.added.length} private access target(s)`,
    status: 'passed',
    evidence: { added: privateTargets.added.length, skipped: privateTargets.skipped.length },
  });
  await privateAccess.persist();

  registry.recordAudit({
    type: 'app_import_applied',
    actor,
    status: 'passed',
    summary: 'App backup import applied non-destructively',
    evidence: {
      projectsAdded: projects.added.length,
      sessionsAdded: sessions.added.length,
      lanesAdded: lanes.added.length,
      mcpToolsAdded: mcpTools.added.length,
      notificationsAdded: notifications.added.length,
      privateAccessTargetsAdded: privateTargets.added.length,
    },
  });
  registry.persistState();

  return {
    ...dryRun,
    dryRun: false,
    imported: {
      projectsAdded: projects.added.length,
      sessionsAdded: sessions.added.length,
      lanesAdded: lanes.added.length,
      mcpToolsAdded: mcpTools.added.length,
      notificationsAdded: notifications.added.length,
      providersAccepted: dryRun.counts.providers,
      privateAccessTargetsAdded: privateTargets.added.length,
    },
    skipped: {
      projects: projects.skipped,
      sessions: sessions.skipped,
      lanes: lanes.skipped,
      mcpTools: mcpTools.skipped,
      notifications: notifications.skipped,
      privateAccessTargets: privateTargets.skipped,
    },
  };
}

async function buildSupportBundle({
  registry,
  providerProfiles,
  privateAccess,
  routeInventory,
  blockers = null,
} = {}) {
  await privateAccess.ensureLoaded();
  const providers = await providerProfiles.listProfiles();
  const registryExport = buildRegistryExport(registry);
  return redactDeep({
    schemaVersion: APP_BACKUP_SCHEMA_VERSION,
    kind: SUPPORT_BUNDLE_KIND,
    generatedAt: nowIso(),
    excludesSecrets: true,
    includesAuthSessions: false,
    includesArtifacts: false,
    shareableByDefault: true,
    counts: {
      projects: registryExport.projects.length,
      sessions: registryExport.sessions.length,
      lanes: registryExport.lanes.length,
      auditEvents: registryExport.auditEvents.length,
      providers: providers.profiles?.length || 0,
      privateAccessTargets: asArray(privateAccess.state.targets).length,
      routeCount: routeInventory?.routeCount || asArray(routeInventory?.routes).length,
    },
    providers: asArray(providers.profiles).map((profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      kind: profile.kind,
      enabled: profile.enabled,
      credential: profile.credential,
      installPolicy: profile.installPolicy,
      updatePolicy: profile.updatePolicy,
    })),
    privateAccess: {
      settings: privateAccess.state.settings,
      targetSummary: asArray(privateAccess.state.targets).map((target) => ({
        id: target.id,
        label: target.label,
        mode: target.mode,
        healthStatus: target.healthStatus,
      })),
    },
    routeInventory,
    blockers,
    recentAuditEvents: registryExport.auditEvents.slice(0, 30),
    recentNotifications: registryExport.notifications.slice(0, 30),
  });
}

export {
  APP_BACKUP_SCHEMA_VERSION,
  APP_EXPORT_KIND,
  SUPPORT_BUNDLE_KIND,
  applyAppImport,
  buildAppExport,
  buildSupportBundle,
  redactDeep,
  validateAppImport,
};
