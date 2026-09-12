// Lane/session configuration normalizers (spawn policy, idle-shutdown mode,
// approved capacity) plus the pure cross-orchestrator sole-writer predicates.
// Pure helpers.

import { isPathWithinBoundary } from './registry-utils.js';

const SPAWN_POLICIES = new Set(['never', 'ask', 'within_capacity', 'auto']);
// Worktree isolation a caller may REQUEST. Only two, because the other two were
// noise: 'direct' is just what 'auto' already resolves to for a sole writer, and
// 'shared' sold conflict risk as a feature. The RESOLVED outcome below is still
// 'direct' | 'isolated' — that is an internal fact about where the lane runs.
//   auto     — let Orca decide from the situation (the default)
//   isolated — always give this lane its own git worktree
export const WORKTREE_MODES = new Set(['auto', 'isolated']);
// Bare fallback for normalizeApprovedCapacity when a caller supplies none, and
// the single environment-derived default for a freshly registered orchestrator.
// A record's stored capacity is authoritative after registration; the environment
// only supplies this initial/default value.
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

// approvedCapacity is the canonical stored field. laneConcurrencyLimit remains a
// compatibility alias for existing state/API consumers, and is used only when an
// older record has no canonical value. Writers/migrations keep the two identical.
export function resolveOrchestratorCapacity(orchestrator, fallback = DEFAULT_APPROVED_CAPACITY) {
  const approved = Number.parseInt(orchestrator?.approvedCapacity, 10);
  if (Number.isFinite(approved) && approved >= 0) {
    return Math.min(64, approved);
  }
  return normalizeApprovedCapacity(orchestrator?.laneConcurrencyLimit, fallback);
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

// ---------------------------------------------------------------------------
// Sole-writer accounting (cross-orchestrator).
//
// "Only one writer per working tree" is a fact about the DIRECTORY, not about a
// single orchestrator's lane list. registry-agents.js keeps one orchestrator
// record per (project, lease), so a project can carry several live
// orchestrators, and each one only ever sees its own lanes. Counting competing
// writers with `lane.sessionId === session.id` therefore granted BOTH
// orchestrators on one checkout a "sole writer" direct lane, and both wrote the
// same tree. The predicate below compares execution directories instead.
// ---------------------------------------------------------------------------

// Two lanes contend when they run in the SAME canonical execution directory.
//
// Deliberately equality and not containment. The guarantee being restored is
// "sole writer across the whole project", and every direct lane of a project
// runs in that project's cwd, so equality covers it exactly. Containment would
// additionally forbid a writer in a nested project (a monorepo root and one of
// its apps are two legitimate cwd-keyed projects that are routinely worked in
// parallel), which is a policy Orca has never had. The residual risk is
// therefore unchanged from before this fix: a writer in a parent directory can
// still reach into a child project's tree.
export function sameExecutionDir(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return false;
  // isPathWithinBoundary path.resolve()s both sides, so this normalizes
  // trailing separators and `.` segments before comparing.
  return isPathWithinBoundary(a, b) && isPathWithinBoundary(b, a);
}

// Live writer lanes that currently hold `directory` — across every
// orchestrator. `isLive` is supplied by the registry (laneOccupiesSlot: a lane
// that submitted still has a live child and still holds the tree).
//
// Isolated lanes are excluded BY MODE and not by path, deliberately: the state
// directory can sit inside the checkout (`<cwd>/.orca`, still the default), so a
// lane's own git worktree under workspacesRoot literally lives inside the
// project directory and a pure path test would report it as holding the very
// checkout it was branched from.
export function findTreeHolders({
  lanes = [],
  directory = '',
  excludeLaneId = null,
  isLive = () => true,
} = {}) {
  const target = String(directory || '').trim();
  if (!target) return [];
  return (Array.isArray(lanes) ? lanes : []).filter((lane) => !!lane
    && lane.id !== excludeLaneId
    && lane.worktreeMode !== 'isolated'
    && lane.permissionsProfile !== 'read-only'
    && sameExecutionDir(lane.workdir, target)
    && isLive(lane));
}

// The refusal a second writer sees. It must be actionable on its own: name the
// lane and the orchestrator that already hold the tree, and give the three ways
// out — wait, take the abandoned orchestrator over, or ask for an isolated
// worktree. `worktreeMode: "isolated"` degrades to direct on a non-git folder,
// so it is only offered when there is a working tree to branch.
export function describeTreeConflict({
  holder,
  holderOrchestrator = null,
  directory = '',
  repoIsGit = false,
  holderStale = false,
  lead = 'Cannot start this lane as a writer',
} = {}) {
  const holderTitle = String(holder?.title || holder?.id || 'unknown lane').trim();
  // No orchestrator record means the holder is in the CALLER's own container, so
  // naming an orchestrator would be noise (and "another orchestrator" a lie).
  const owner = holderOrchestrator
    ? ` under orchestrator "${holderOrchestrator.title || holderOrchestrator.actor || holderOrchestrator.id}" (${holderOrchestrator.id})`
    : '';
  const remedies = ['wait for that lane to finish (or stop it)'];
  if (repoIsGit) {
    remedies.push('spawn this lane with worktreeMode "isolated" so it gets its own git worktree');
  }
  if (holderOrchestrator) {
    remedies.push(holderStale
      ? `take that orchestrator over — it is stale, so orchestrator.register with takeoverOrchestratorId "${holderOrchestrator.id}" will hand you its lanes`
      : `take that orchestrator over once it is stale or resigned (orchestrator.register with takeoverOrchestratorId "${holderOrchestrator.id}")`);
  }
  const scope = holderOrchestrator
    ? ' A working tree gets exactly one writer across the whole PROJECT, not one per orchestrator.'
    : '';
  return `${lead}: ${directory} is already being written by lane "${holderTitle}" (${holder?.id || 'unknown'})${owner}.${scope} To proceed, ${remedies.join('; ')}.`;
}
