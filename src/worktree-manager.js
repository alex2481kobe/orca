import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const MAX_BRANCH_LEN = 200;
const BRANCH_PREFIX = 'orca/lane/';

function runGit(args, options = {}) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    ...options,
  });
}

function isValidRepoRoot(repoRoot) {
  if (!repoRoot) return false;
  try {
    const stats = fs.statSync(repoRoot);
    if (!stats.isDirectory()) return false;
  } catch {
    return false;
  }
  const result = runGit(['rev-parse', '--show-toplevel'], { cwd: repoRoot });
  if (result.error || result.status !== 0) return false;
  return result.stdout.trim() === path.resolve(repoRoot);
}

function fallbackLaneBranch(safeLaneId) {
  const shortId = String(safeLaneId || '').replace(/-/g, '').slice(0, 8) || 'lane';
  return `${BRANCH_PREFIX}${shortId}`;
}

function validRefText(value) {
  const trimmed = String(value || '').trim();
  if (
    trimmed
    && !trimmed.startsWith('-')
    && !trimmed.includes('..')
    && /^[A-Za-z0-9._\-\/]+$/.test(trimmed)
  ) {
    return trimmed.slice(0, MAX_BRANCH_LEN);
  }
  return '';
}

function refExists(repoRoot, ref) {
  const result = runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoRoot });
  return result.status === 0;
}

function isValidBranchName(repoRoot, branch) {
  if (!branch) return false;
  const result = runGit(['check-ref-format', '--branch', branch], { cwd: repoRoot });
  return result.status === 0;
}

function remoteNameForRef(repoRoot, ref) {
  const [remote] = String(ref || '').split('/');
  if (!remote || remote === ref) return '';
  const result = runGit(['remote', 'get-url', remote], { cwd: repoRoot });
  return result.status === 0 ? remote : '';
}

function buildBranchPlan(repoRoot, branchHint, laneId) {
  const safeLaneId = String(laneId || '').replace(/[^A-Za-z0-9._\-]/g, '');
  const fallbackBranch = fallbackLaneBranch(safeLaneId);
  const requested = validRefText(branchHint);
  if (!requested || !isValidBranchName(repoRoot, requested)) {
    return { ok: true, branch: fallbackBranch, baseRef: 'HEAD' };
  }
  if (refExists(repoRoot, requested)) {
    return { ok: true, branch: fallbackBranch, baseRef: requested };
  }
  if (remoteNameForRef(repoRoot, requested)) {
    return {
      ok: false,
      reason: `Remote ref ${requested} was not found. Fetch it or choose a local workflow branch name.`,
    };
  }
  return { ok: true, branch: requested, baseRef: 'HEAD' };
}

function escapeForJson(value) {
  return JSON.stringify(value);
}

// A directory-exists check (no git required). Agents can run in any folder; git
// is only needed for per-lane worktree ISOLATION, which falls back gracefully.
export function directoryExists(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function describeRepoRoot(repoRoot) {
  if (!repoRoot) {
    return { ok: false, reason: 'No repo root configured.' };
  }
  if (!isValidRepoRoot(repoRoot)) {
    return { ok: false, reason: `${repoRoot} is not a git working tree.` };
  }
  const head = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  const remote = runGit(['config', '--get', 'remote.origin.url'], { cwd: repoRoot });
  return {
    ok: true,
    repoRoot: path.resolve(repoRoot),
    headBranch: head.status === 0 ? head.stdout.trim() : null,
    remoteUrl: remote.status === 0 ? remote.stdout.trim() : null,
  };
}

// Read branch + worktree state for a repo so the composer can show (Codex-style)
// the branch picker and existing worktrees. Returns { isGit:false } for non-git
// folders (agents still run there — git info is just unavailable). Never throws.
export function readRepoGitInfo(repoRoot) {
  const descriptor = describeRepoRoot(repoRoot);
  if (!descriptor.ok) return { isGit: false, reason: descriptor.reason };
  const root = descriptor.repoRoot;
  const branchOut = runGit(
    ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', '--count=200', 'refs/heads'],
    { cwd: root },
  );
  const localBranches = branchOut.status === 0
    ? branchOut.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 200)
    : [];
  const remoteOut = runGit(
    ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', '--count=200', 'refs/remotes'],
    { cwd: root },
  );
  const remoteBranches = remoteOut.status === 0
    ? remoteOut.stdout.split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.endsWith('/HEAD'))
      .slice(0, 200)
    : [];
  const branches = [...localBranches, ...remoteBranches]
    .filter((branch, index, all) => all.indexOf(branch) === index)
    .slice(0, 250);
  const worktrees = [];
  const wtOut = runGit(['worktree', 'list', '--porcelain'], { cwd: root });
  if (wtOut.status === 0) {
    let current = null;
    wtOut.stdout.split(/\r?\n/).forEach((line) => {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice('worktree '.length).trim(), branch: null, head: null };
        worktrees.push(current);
      } else if (current && line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      } else if (current && line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length).trim().slice(0, 12);
      } else if (current && line.startsWith('detached')) {
        current.branch = '(detached)';
      }
    });
  }
  return {
    isGit: true,
    repoRoot: root,
    currentBranch: descriptor.headBranch,
    remoteUrl: descriptor.remoteUrl,
    branches,
    localBranches,
    remoteBranches,
    worktrees: worktrees.slice(0, 50),
  };
}

/**
 * Create a git worktree for a lane.
 *
 * Returns { ok, worktreePath, branch, created, reason }.
 *
 * - `worktreePath` is always under `worktreeBase` so cleanup is bounded.
 * - `branch` is sanitized; collisions resolve by appending the lane shortId.
 * - If the worktree already exists at the target path, it is reused (created: false).
 * - Failures return { ok: false, reason } and do not throw — callers decide
 *   whether to surface a 422 or fall back to the session workspace.
 */
export function createLaneWorktree({
  repoRoot,
  worktreeBase,
  laneId,
  branchHint,
  baseRef = 'HEAD',
}) {
  if (!laneId) {
    return { ok: false, reason: 'laneId is required.' };
  }
  // baseRef is handed to `git worktree add ... <baseRef>`. Even with shell:false,
  // git treats leading "-" as flags and ".." as a range. Restrict to a plain ref.
  const safeBaseRef = String(baseRef || 'HEAD').trim();
  if (
    !safeBaseRef
    || safeBaseRef.startsWith('-')
    || safeBaseRef.includes('..')
    || !/^[A-Za-z0-9._\/-]{1,200}$/.test(safeBaseRef)
  ) {
    return { ok: false, reason: 'Invalid baseRef.' };
  }
  const descriptor = describeRepoRoot(repoRoot);
  if (!descriptor.ok) {
    return { ok: false, reason: descriptor.reason };
  }
  if (!worktreeBase) {
    return { ok: false, reason: 'worktreeBase is required.' };
  }
  // Path under worktreeBase, never above. Use laneId directly (UUID → safe).
  const safeLaneId = String(laneId).replace(/[^A-Za-z0-9._\-]/g, '');
  if (!safeLaneId) return { ok: false, reason: 'Invalid laneId.' };
  const worktreePath = path.resolve(worktreeBase, safeLaneId);
  const baseResolved = path.resolve(worktreeBase);
  if (!worktreePath.startsWith(baseResolved + path.sep) && worktreePath !== baseResolved) {
    return { ok: false, reason: 'Worktree path escapes base.' };
  }

  try {
    fs.mkdirSync(worktreeBase, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `Could not create worktree base: ${error.message}` };
  }

  // Reuse if a registered worktree already lives here.
  const list = runGit(['worktree', 'list', '--porcelain'], { cwd: descriptor.repoRoot });
  if (list.status === 0) {
    const registered = parseWorktreeList(list.stdout);
    const existing = registered.find((entry) => entry.path === worktreePath);
    if (existing) {
      return {
        ok: true,
        worktreePath,
        branch: existing.branch || branchHint || null,
        created: false,
        repoRoot: descriptor.repoRoot,
      };
    }
  }

  const branchPlan = buildBranchPlan(descriptor.repoRoot, branchHint, safeLaneId);
  if (!branchPlan.ok) return branchPlan;
  const branch = branchPlan.branch;
  const resolvedBaseRef = safeBaseRef === 'HEAD' ? branchPlan.baseRef : safeBaseRef;

  const addArgs = ['worktree', 'add', '-b', branch, worktreePath, resolvedBaseRef];
  const result = runGit(addArgs, { cwd: descriptor.repoRoot });
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `git worktree add failed: ${result.stderr?.trim() || result.stdout?.trim() || 'unknown'}`,
      attemptedCommand: addArgs,
    };
  }

  return {
    ok: true,
    worktreePath,
    branch,
    created: true,
    repoRoot: descriptor.repoRoot,
  };
}

/**
 * Remove a lane worktree. Best-effort: returns { removed, reason }.
 * Leaves the branch in place by default so post-lane review (diff, PR) is possible.
 *
 * SAFETY: refuses to discard a worktree that has uncommitted changes unless the
 * caller passes `force:true`. `git worktree remove --force` silently destroys
 * uncommitted work, so the dirty-check gates data loss before we hand git the
 * mechanical --force (which is still needed to clear locks / handle submodules).
 */
export function removeLaneWorktree({ repoRoot, worktreePath, removeBranch = false, branch = null, force = false }) {
  if (!repoRoot || !worktreePath) {
    return { removed: false, reason: 'repoRoot and worktreePath are required.' };
  }
  const descriptor = describeRepoRoot(repoRoot);
  if (!descriptor.ok) {
    return { removed: false, reason: descriptor.reason };
  }
  // Only remove a path git actually tracks as a worktree, and never the repo
  // root itself — prevents a bad/forged worktreePath from force-removing
  // arbitrary directories.
  // realpath (not just path.resolve) so an aliased spelling — macOS /var vs
  // /private/var — can't slip past the repo-root guard.
  const realpathSafe = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
  const resolvedTarget = realpathSafe(worktreePath);
  if (resolvedTarget === realpathSafe(descriptor.repoRoot)) {
    return { removed: false, reason: 'Refusing to remove the repository root as a worktree.' };
  }
  const list = runGit(['worktree', 'list', '--porcelain'], { cwd: descriptor.repoRoot });
  if (list.status === 0) {
    const registered = parseWorktreeList(list.stdout).map((entry) => realpathSafe(entry.path));
    if (!registered.includes(resolvedTarget)) {
      return { removed: false, reason: 'Path is not a registered git worktree of this repo.' };
    }
  }
  // Data-loss guard: unless forced, refuse to discard uncommitted work.
  if (!force) {
    const dirty = changedFilesIn(resolvedTarget);
    if (dirty.length) {
      return {
        removed: false,
        reason: `Worktree has ${dirty.length} uncommitted change(s). Integrate or commit them, or pass force:true to discard them.`,
        uncommittedChanges: dirty.length,
      };
    }
  }
  const removeResult = runGit(['worktree', 'remove', '--force', resolvedTarget], { cwd: descriptor.repoRoot });
  if (removeResult.status !== 0) {
    return {
      removed: false,
      reason: `git worktree remove failed: ${removeResult.stderr?.trim() || removeResult.stdout?.trim() || 'unknown'}`,
    };
  }
  let branchRemoved = false;
  if (removeBranch && branch) {
    const branchResult = runGit(['branch', '-D', branch], { cwd: descriptor.repoRoot });
    branchRemoved = branchResult.status === 0;
  }
  return { removed: true, branchRemoved };
}

function parseWorktreeList(stdout) {
  const blocks = String(stdout || '').split(/\n\n+/).map((block) => block.trim()).filter(Boolean);
  return blocks.map((block) => {
    const entry = {};
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ').trim();
      if (key === 'worktree') entry.path = value;
      else if (key === 'HEAD') entry.head = value;
      else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') entry.detached = true;
    }
    return entry;
  });
}

export function changedFilesIn(worktreePath) {
  if (!worktreePath) return [];
  try {
    const result = runGit(['status', '--porcelain'], { cwd: worktreePath });
    if (result.status !== 0) return [];
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 500);
  } catch {
    return [];
  }
}

/**
 * Merge an isolated lane's branch back into the container's base branch in the
 * repo-root checkout. Never throws; returns a structured result the caller can
 * report verbatim:
 *   { merged:true, baseBranch, branch, fastForward, pushed? }
 *   { merged:false, nothingToMerge:true, baseBranch, branch }
 *   { merged:false, conflicts:true, reason, baseBranch, branch }
 *   { merged:false, reason }                       (setup/validation failure)
 *
 * Does NOT push unless `push:true`. The merge runs in the repo root, so the base
 * branch is whatever that checkout currently has out (the container's base).
 */
export function mergeLaneBranch({ repoRoot, branch, push = false }) {
  const safeBranch = validRefText(branch);
  if (!safeBranch) return { merged: false, reason: 'A valid lane branch is required to integrate.' };
  const descriptor = describeRepoRoot(repoRoot);
  if (!descriptor.ok) return { merged: false, reason: descriptor.reason };
  const root = descriptor.repoRoot;
  if (!refExists(root, safeBranch)) {
    return { merged: false, reason: `Lane branch ${safeBranch} was not found in the repository.` };
  }
  const headOut = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const baseBranch = headOut.status === 0 ? headOut.stdout.trim() : '';
  if (!baseBranch || baseBranch === 'HEAD') {
    return { merged: false, reason: 'Repository root is not on a named base branch (detached HEAD); cannot integrate.' };
  }
  if (baseBranch === safeBranch) {
    return { merged: false, reason: `Repository root is already on ${safeBranch}; nothing to integrate.` };
  }
  // Anything to merge? Count commits on the lane branch not reachable from base.
  const ahead = runGit(['rev-list', '--count', `${baseBranch}..${safeBranch}`], { cwd: root });
  if (ahead.status === 0 && ahead.stdout.trim() === '0') {
    return { merged: false, nothingToMerge: true, baseBranch, branch: safeBranch };
  }
  const merge = runGit(['merge', '--no-edit', safeBranch], { cwd: root });
  if (merge.status !== 0) {
    // Conflict (or other merge failure): abort so the base checkout is left clean.
    runGit(['merge', '--abort'], { cwd: root });
    return {
      merged: false,
      conflicts: true,
      baseBranch,
      branch: safeBranch,
      reason: `Merge of ${safeBranch} into ${baseBranch} failed (conflicts). ${merge.stdout?.trim() || merge.stderr?.trim() || ''}`.trim(),
    };
  }
  // Fast-forward when the new HEAD has a single parent (no merge commit created).
  const parents = runGit(['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: root });
  const wasFastForward = parents.status === 0 && parents.stdout.trim().split(/\s+/).length <= 2;
  const result = { merged: true, baseBranch, branch: safeBranch, fastForward: wasFastForward };
  if (push) {
    const pushResult = runGit(['push'], { cwd: root });
    result.pushed = pushResult.status === 0;
    if (pushResult.status !== 0) {
      result.pushReason = pushResult.stderr?.trim() || pushResult.stdout?.trim() || 'git push failed';
    }
  }
  return result;
}
