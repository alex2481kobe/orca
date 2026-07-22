// Effective-settings schema, validators, and override sanitization. Extracted
// from effective-settings.js. Strong prototype-pollution defenses live here.

export const CONTRACT_VERSION = 'orca.effective-settings.v1';

export const DEFAULT_EFFECTIVE_SETTINGS = {
  // Configurable agent-flow engine: how work moves between the main orchestrator,
  // executors, and the audit tier. Layered per scope (defaults -> project ->
  // session -> lane), so users AND agents can shape the flow. This is the ONLY
  // group read at runtime (registry-audit.js -> getLaneFlowConfig); the seam below
  // is deliberately kept minimal so a new group is one SCHEMA entry away.
  flow: {
    // orchestrator-only      : orchestrator does the work itself, no executor lanes
    // orchestrator-executor  : orchestrator spawns executors; results return to orchestrator
    // orchestrator-executor-audit : executor work is audited before returning to the orchestrator
    template: 'orchestrator-executor',
    // After an executor submits, who audits: the main orchestrator, or a separate
    // auditor/mini-orchestrator tier.
    auditTier: 'orchestrator',
    // When an audit requests fixes: send them back to the same executor, or a fresh one.
    fixRouting: 'same-agent',
    // How many audit -> fix -> re-audit loops are allowed before escalating to the user.
    maxAuditLoops: 2,
    // If true, a lane cannot be reported done / returned to the orchestrator until
    // an audit accepts it. On by default — finished work gets reviewed unless you
    // deliberately opt out per project/session.
    requireAuditPass: true,
  },
};

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_STRING_LENGTH = 160;

const SCHEMA = {
  flow: {
    template: { type: 'enum', allowed: ['orchestrator-only', 'orchestrator-executor', 'orchestrator-executor-audit'] },
    auditTier: { type: 'enum', allowed: ['orchestrator', 'separate-auditor'] },
    fixRouting: { type: 'enum', allowed: ['same-agent', 'new-agent'] },
    maxAuditLoops: { type: 'integer', min: 0, max: 10 },
    requireAuditPass: { type: 'boolean' },
  },
};

export function clonePayload(value) {
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

function sanitizeValue(raw, rule, field) {
  if (rule.type === 'boolean') return raw === true;
  if (rule.type === 'enum') return sanitizeEnum(raw, rule, field);
  if (rule.type === 'integer') return sanitizeInteger(raw, rule, field);
  rejectSettings(`${field} has unsupported schema type.`);
}

// Sanitize caller/persisted settingsOverrides down to the schema-known surface.
// Prototype-pollution keys and non-plain-object shapes still HARD-fail (security),
// and recognized fields with bad VALUES still 422 (real validation). But unknown
// groups and unknown keys within a known group are DROPPED silently: after the
// schema was reduced to flow-only, createProject/createLane callers and persisted
// records may still carry legacy non-flow groups — those degrade to "no override"
// instead of erroring. Re-adding a group later is one SCHEMA entry.
export function sanitizeSettingsOverrides(raw = {}) {
  if (raw === undefined || raw === null) return {};
  assertPlainObject(raw, 'settingsOverrides');

  const sanitized = {};
  for (const [group, groupValue] of Object.entries(raw)) {
    assertSafeKey(group, 'settingsOverrides');
    const groupSchema = SCHEMA[group];
    if (!groupSchema) continue; // unknown group -> drop silently
    assertPlainObject(groupValue, `settingsOverrides.${group}`);

    const nextGroup = {};
    for (const [key, value] of Object.entries(groupValue)) {
      assertSafeKey(key, `settingsOverrides.${group}`);
      const rule = groupSchema[key];
      if (!rule) continue; // unknown key within a known group -> drop silently
      nextGroup[key] = sanitizeValue(value, rule, `settingsOverrides.${group}.${key}`);
    }
    if (Object.keys(nextGroup).length) sanitized[group] = nextGroup;
  }
  return sanitized;
}
