// Lane/session configuration normalizers (spawn policy, idle-shutdown mode,
// approved capacity). Pure helpers.

const SPAWN_POLICIES = new Set(['never', 'ask', 'within_capacity', 'auto']);
// Worktree isolation a caller may REQUEST. Only two, because the other two were
// noise: 'direct' is just what 'auto' already resolves to for a sole writer, and
// 'shared' sold conflict risk as a feature. The RESOLVED outcome below is still
// 'direct' | 'isolated' — that is an internal fact about where the lane runs.
//   auto     — let Orca decide from the situation (the default)
//   isolated — always give this lane its own git worktree
export const WORKTREE_MODES = new Set(['auto', 'isolated']);
// Bare fallback for normalizeApprovedCapacity when a caller supplies none. It is
// deliberately the SAME number a freshly registered orchestrator gets, honouring
// ORCA_LANE_CONCURRENCY (registry-agents.js DEFAULT_ORCHESTRATOR_CAPACITY) — this
// used to be a hardcoded 2 while every real call site passed 4, so any future caller
// that took the bare default would have silently halved an operator's configured
// lane capacity.
export const DEFAULT_APPROVED_CAPACITY = Number.parseInt(process.env.ORCA_LANE_CONCURRENCY ?? '', 10) > 0
  ? Math.min(64, Number.parseInt(process.env.ORCA_LANE_CONCURRENCY, 10))
  : 4;

export function normalizeSpawnPolicy(value, fallback = 'within_capacity') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return SPAWN_POLICIES.has(normalized) ? normalized : fallback;
}


export function normalizeWorktreeMode(value, fallback = 'auto') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return WORKTREE_MODES.has(normalized) ? normalized : fallback;
}

// Resolve a concrete worktree mode ('direct' | 'isolated') from a request. Pure —
// the caller supplies the situation. This encodes the policy the user asked for:
//   - read-only work, or a non-git folder, never needs a worktree -> direct
//   - a sole writer can safely edit the checkout in place         -> direct
//   - once writers overlap, each writer needs its own worktree    -> isolated
// An explicit 'isolated' request is honored, except on a non-git folder where it
// degrades to direct (there is no working tree to branch).
export function resolveWorktreeMode({
  requested = 'auto',
  repoIsGit = false,
  isReadOnly = false,
  activeWriterLanes = 0,
} = {}) {
  const mode = normalizeWorktreeMode(requested);
  if (mode === 'isolated') {
    // 'isolated' needs a git working tree to branch a worktree from.
    return repoIsGit ? 'isolated' : 'direct';
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
