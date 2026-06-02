// Lane/session configuration normalizers (spawn policy, idle-shutdown mode,
// critique mode, approved capacity). Extracted from registry.js. Pure helpers.

const SPAWN_POLICIES = new Set(['never', 'ask', 'within_capacity', 'auto']);
const IDLE_SHUTDOWN_MODES = new Set(['immediate', 'short_keepalive', 'policy']);
const CRITIQUE_MODES = new Set(['off', 'suggested', 'required', 'visual-required']);
export const DEFAULT_APPROVED_CAPACITY = 2;

export function normalizeSpawnPolicy(value, fallback = 'within_capacity') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return SPAWN_POLICIES.has(normalized) ? normalized : fallback;
}

export function normalizeIdleShutdownMode(value, fallback = 'immediate') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return IDLE_SHUTDOWN_MODES.has(normalized) ? normalized : fallback;
}

export function normalizeCritiqueMode(value, fallback = 'suggested') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return CRITIQUE_MODES.has(normalized) ? normalized : fallback;
}

export function normalizeApprovedCapacity(value, fallback = DEFAULT_APPROVED_CAPACITY) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(64, parsed);
}
