// Lane/session configuration normalizers (spawn policy, idle-shutdown mode,
// critique mode, approved capacity). Extracted from registry.js. Pure helpers.

const SPAWN_POLICIES = new Set(['never', 'ask', 'within_capacity', 'auto']);
const IDLE_SHUTDOWN_MODES = new Set(['immediate', 'short_keepalive', 'policy']);
const CRITIQUE_MODES = new Set(['off', 'suggested', 'required', 'visual-required']);
// Worktree isolation modes an orchestrator/lane can request:
//   auto     — let Orca decide from the situation (the default; see resolveWorktreeMode)
//   direct   — no worktree; the lane runs in the repo root checkout itself
//   isolated — a dedicated per-lane git worktree (safe for concurrent writers)
//   shared   — several lanes deliberately share the one repo checkout (conflict risk)
export const WORKTREE_MODES = new Set(['auto', 'direct', 'isolated', 'shared']);
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

export function normalizeWorktreeMode(value, fallback = 'auto') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return WORKTREE_MODES.has(normalized) ? normalized : fallback;
}

export function isWorktreeMode(value) {
  return WORKTREE_MODES.has(String(value || '').trim().toLowerCase());
}

// Resolve a concrete worktree mode from a (possibly 'auto') request. Pure — the
// caller supplies the situation. This encodes the policy the user asked for:
//   - read-only work, or a non-git folder, never needs a worktree -> direct
//   - a sole writer can safely edit the checkout in place            -> direct
//   - once writers overlap, each writer needs its own worktree       -> isolated
// An explicit non-auto request is honored, except an isolated/shared request on
// a non-git folder degrades to direct (there is no working tree to branch).
export function resolveWorktreeMode({
  requested = 'auto',
  repoIsGit = false,
  isReadOnly = false,
  activeWriterLanes = 0,
} = {}) {
  const mode = normalizeWorktreeMode(requested);
  if (mode !== 'auto') {
    // Only 'isolated' truly needs a git working tree (to branch a worktree);
    // 'shared'/'direct' just run in the folder, so they apply anywhere.
    if (!repoIsGit && mode === 'isolated') return 'direct';
    return mode;
  }
  if (!repoIsGit || isReadOnly) return 'direct';
  return activeWriterLanes > 0 ? 'isolated' : 'direct';
}

export function normalizeApprovedCapacity(value, fallback = DEFAULT_APPROVED_CAPACITY) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(64, parsed);
}

// A lane command for a first-class CLI must actually invoke that CLI. Executor
// types don't all match their binary name 1:1 (e.g. composer-cli runs the
// `cursor-agent` binary), so map each type to the tokens its command may start
// with. Used by lane-command validation in registry-lane-create.js.
const FIRST_CLASS_CLI_TARGET_ALIASES = {
  codex: ['codex'],
  claude: ['claude'],
  'gemini-cli': ['gemini', 'gemini-cli'],
  'composer-cli': ['cursor-agent', 'composer-cli'],
};

export function commandTargetsExecutorFirstToken(type, commandParts) {
  const normalizedType = String(type || '').toLowerCase().trim();
  if (!normalizedType) return true;
  if (!Array.isArray(commandParts)) return false;
  if (!commandParts.length) return true;
  const first = String(commandParts[0] || '').toLowerCase();
  const aliases = FIRST_CLASS_CLI_TARGET_ALIASES[normalizedType] || [normalizedType];
  return aliases.some((alias) => first.includes(alias));
}
