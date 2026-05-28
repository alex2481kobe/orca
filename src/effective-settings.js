const CONTRACT_VERSION = 'command-deck.effective-settings.v1';

const PROVIDER_IDS = [
  'codex',
  'claude',
  'custom-cli',
  'openai-compatible',
  'gemini',
  'kimi',
  'deepseek',
  'openrouter',
  'composer',
];

const DEFAULT_EFFECTIVE_SETTINGS = {
  provider: {
    providerAllowlist: PROVIDER_IDS,
    secretPriority: ['os-credential', 'env'],
    managedInstallPolicy: 'dry-run-only',
  },
  spawn: {
    spawnPolicy: 'within_capacity',
    approvedCapacity: 2,
    soloMode: true,
    idleShutdownMode: 'immediate',
  },
  critique: {
    mode: 'suggested',
    visualBrowserMode: 'visual-required',
    waiverMode: 'orchestrator-within-policy',
    auditAssignment: 'orchestrator-audits-first',
    autoAdvance: 'immediate',
  },
  evidence: {
    screenshotRequiredForVisual: true,
    videoDefault: false,
    retentionDays: 14,
    sensitiveCapture: 'explicit-approval',
  },
  cleanup: {
    retentionDays: 14,
    dryRunDefault: true,
  },
  notifications: {
    inApp: true,
    browser: false,
    sensitiveContent: false,
  },
  privateAccess: {
    preferredMode: 'tailnet-http',
    httpsServeAllowed: true,
    funnelAllowed: false,
  },
  urlOpening: {
    defaultMode: 'external',
    inAppPreviewAllowed: true,
  },
  mobile: {
    visible: true,
    pwaStaticCacheOnly: true,
  },
};

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_ARRAY_ITEMS = 64;
const MAX_STRING_LENGTH = 160;
const MAX_RETENTION_DAYS = 3650;
const MAX_APPROVED_CAPACITY = 64;

const SCHEMA = {
  provider: {
    providerAllowlist: { type: 'stringArray', allowed: PROVIDER_IDS },
    secretPriority: { type: 'stringArray', allowed: ['os-credential', 'env'] },
    managedInstallPolicy: { type: 'enum', allowed: ['dry-run-only', 'approval-required', 'managed'] },
  },
  spawn: {
    spawnPolicy: { type: 'enum', allowed: ['never', 'ask', 'within_capacity', 'auto'] },
    approvedCapacity: { type: 'integer', min: 0, max: MAX_APPROVED_CAPACITY },
    soloMode: { type: 'boolean' },
    idleShutdownMode: { type: 'enum', allowed: ['immediate', 'short_keepalive', 'policy'] },
  },
  critique: {
    mode: { type: 'enum', allowed: ['off', 'suggested', 'required', 'visual-required'] },
    visualBrowserMode: { type: 'enum', allowed: ['suggested', 'required', 'visual-required'] },
    waiverMode: { type: 'enum', allowed: ['orchestrator-within-policy', 'approval-required', 'forbidden'] },
    auditAssignment: { type: 'enum', allowed: ['orchestrator-audits-first', 'separate-auditor-allowed', 'separate-auditor-required'] },
    autoAdvance: { type: 'enum', allowed: ['immediate', 'approval-required', 'off'] },
  },
  evidence: {
    screenshotRequiredForVisual: { type: 'boolean' },
    videoDefault: { type: 'boolean' },
    retentionDays: { type: 'integer', min: 1, max: MAX_RETENTION_DAYS },
    sensitiveCapture: { type: 'enum', allowed: ['explicit-approval', 'redact', 'forbid'] },
  },
  cleanup: {
    retentionDays: { type: 'integer', min: 1, max: MAX_RETENTION_DAYS },
    dryRunDefault: { type: 'boolean' },
  },
  notifications: {
    inApp: { type: 'boolean' },
    browser: { type: 'boolean' },
    sensitiveContent: { type: 'boolean' },
  },
  privateAccess: {
    preferredMode: { type: 'enum', allowed: ['tailnet-http', 'tailnet-https-serve', 'local'] },
    httpsServeAllowed: { type: 'boolean' },
    funnelAllowed: { type: 'boolean' },
  },
  urlOpening: {
    defaultMode: { type: 'enum', allowed: ['external', 'in-app'] },
    inAppPreviewAllowed: { type: 'boolean' },
  },
  mobile: {
    visible: { type: 'boolean' },
    pwaStaticCacheOnly: { type: 'boolean' },
  },
};

function clonePayload(value) {
  return JSON.parse(JSON.stringify(value));
}

function rejectSettings(message) {
  throw { status: 422, message };
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    rejectSettings(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    rejectSettings(`${label} must be a plain object.`);
  }
}

function assertSafeKey(key, label) {
  if (PROTOTYPE_KEYS.has(key)) {
    rejectSettings(`${label} cannot contain prototype-pollution key "${key}".`);
  }
}

function sanitizeString(raw, field) {
  const value = String(raw || '').trim();
  if (!value) rejectSettings(`${field} cannot be empty.`);
  if (value.length > MAX_STRING_LENGTH) rejectSettings(`${field} is too long.`);
  if (/[\x00\r\n]/.test(value)) rejectSettings(`${field} contains unsafe control characters.`);
  return value;
}

function sanitizeEnum(raw, rule, field) {
  const value = sanitizeString(raw, field);
  if (!rule.allowed.includes(value)) {
    rejectSettings(`${field} must be one of: ${rule.allowed.join(', ')}.`);
  }
  return value;
}

function sanitizeInteger(raw, rule, field) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) rejectSettings(`${field} must be an integer.`);
  if (value < rule.min || value > rule.max) {
    rejectSettings(`${field} must be between ${rule.min} and ${rule.max}.`);
  }
  return value;
}

function sanitizeStringArray(raw, rule, field) {
  if (!Array.isArray(raw)) rejectSettings(`${field} must be an array.`);
  if (raw.length > MAX_ARRAY_ITEMS) rejectSettings(`${field} has too many entries.`);
  const values = [];
  for (const item of raw) {
    const value = sanitizeString(item, field);
    if (rule.allowed && !rule.allowed.includes(value)) {
      rejectSettings(`${field} contains unsupported value "${value}".`);
    }
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

function sanitizeValue(raw, rule, field) {
  if (rule.type === 'boolean') return raw === true;
  if (rule.type === 'enum') return sanitizeEnum(raw, rule, field);
  if (rule.type === 'integer') return sanitizeInteger(raw, rule, field);
  if (rule.type === 'stringArray') return sanitizeStringArray(raw, rule, field);
  rejectSettings(`${field} has unsupported schema type.`);
}

function sanitizeSettingsOverrides(raw = {}) {
  if (raw === undefined || raw === null) return {};
  assertPlainObject(raw, 'settingsOverrides');

  const sanitized = {};
  for (const [group, groupValue] of Object.entries(raw)) {
    assertSafeKey(group, 'settingsOverrides');
    const groupSchema = SCHEMA[group];
    if (!groupSchema) rejectSettings(`settingsOverrides.${group} is not a supported settings group.`);
    assertPlainObject(groupValue, `settingsOverrides.${group}`);

    const nextGroup = {};
    for (const [key, value] of Object.entries(groupValue)) {
      assertSafeKey(key, `settingsOverrides.${group}`);
      const rule = groupSchema[key];
      if (!rule) rejectSettings(`settingsOverrides.${group}.${key} is not supported.`);
      nextGroup[key] = sanitizeValue(value, rule, `settingsOverrides.${group}.${key}`);
    }
    if (Object.keys(nextGroup).length) sanitized[group] = nextGroup;
  }
  return sanitized;
}

function mergeSettings(base, override) {
  const next = clonePayload(base);
  for (const [group, values] of Object.entries(override || {})) {
    next[group] = {
      ...(next[group] || {}),
      ...values,
    };
  }
  return next;
}

function hasSettings(value) {
  return Boolean(value && Object.keys(value).length);
}

function sessionFieldSettings(session) {
  if (!session) return {};
  const settings = {};
  const spawn = {};
  if (session.spawnPolicy !== undefined) spawn.spawnPolicy = session.spawnPolicy;
  if (session.approvedCapacity !== undefined) spawn.approvedCapacity = session.approvedCapacity;
  if (session.soloMode !== undefined) spawn.soloMode = session.soloMode !== false;
  if (session.idleShutdownMode !== undefined) spawn.idleShutdownMode = session.idleShutdownMode;
  if (Object.keys(spawn).length) settings.spawn = spawn;

  if (session.critiqueMode !== undefined) settings.critique = { mode: session.critiqueMode };

  if (session.artifactRetentionDays !== undefined) {
    const retentionDays = session.artifactRetentionDays;
    settings.evidence = { retentionDays };
    settings.cleanup = { retentionDays };
  }
  return sanitizeSettingsOverrides(settings);
}

function laneFieldSettings(lane) {
  if (!lane) return {};
  const settings = {};
  if (lane.critiqueMode !== undefined) settings.critique = { mode: lane.critiqueMode };
  if (lane.targetUrl) {
    settings.critique = {
      ...(settings.critique || {}),
      visualBrowserMode: 'visual-required',
    };
    settings.evidence = {
      ...(settings.evidence || {}),
      screenshotRequiredForVisual: true,
    };
  }
  return sanitizeSettingsOverrides(settings);
}

function buildEffectiveSettings({
  project = null,
  session = null,
  lane = null,
  actionOverride = null,
} = {}) {
  let settings = clonePayload(DEFAULT_EFFECTIVE_SETTINGS);
  const sourcesApplied = [{
    scope: 'global',
    source: 'defaults',
    id: null,
    fields: Object.keys(settings),
  }];

  const applySource = (scope, source, id, overrides) => {
    const sanitized = sanitizeSettingsOverrides(overrides || {});
    if (!hasSettings(sanitized)) return;
    settings = mergeSettings(settings, sanitized);
    sourcesApplied.push({
      scope,
      source,
      id: id || null,
      fields: Object.keys(sanitized),
    });
  };

  if (project) applySource('project', 'settingsOverrides', project.id, project.settingsOverrides);
  if (session) {
    applySource('session', 'fields', session.id, sessionFieldSettings(session));
    applySource('session', 'settingsOverrides', session.id, session.settingsOverrides);
  }
  if (lane) {
    applySource('lane', 'fields', lane.id, laneFieldSettings(lane));
    applySource('lane', 'settingsOverrides', lane.id, lane.settingsOverrides);
  }
  if (actionOverride) applySource('action', 'oneTimeOverride', null, actionOverride);

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    precedence: [
      'global defaults',
      'project settingsOverrides',
      'session fields',
      'session settingsOverrides',
      'lane fields',
      'lane settingsOverrides',
      'one-time action override',
    ],
    scope: {
      projectId: project?.id || null,
      projectSlug: project?.slug || null,
      sessionId: session?.id || null,
      laneId: lane?.id || null,
    },
    sourcesApplied,
    settings,
  };
}

export {
  CONTRACT_VERSION,
  DEFAULT_EFFECTIVE_SETTINGS,
  buildEffectiveSettings,
  sanitizeSettingsOverrides,
};
