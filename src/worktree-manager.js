import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const MAX_BRANCH_LEN = 200;
const BRANCH_PREFIX = 'command-deck/lane/';

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

function sanitizeBranchSegment(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
}

function buildBranchName(branchHint, laneId) {
  const trimmed = String(branchHint || '').trim();
  if (trimmed) {
    if (/^[A-Za-z0-9._\-\/]+$/.test(trimmed) && !trimmed.includes('..')) {
      return trimmed.slice(0, MAX_BRANCH_LEN);
    }
  }
  const shortId = String(laneId || '').replace(/-/g, '').slice(0, 8) || 'lane';
  return `${BRANCH_PREFIX}${shortId}`;
}

function escapeForJson(value) {
  return JSON.stringify(value);
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

  let branch = buildBranchName(branchHint, laneId);
  // Always force a unique branch — fallback to laneId suffix on collision.
  const branchExists = runGit(['rev-parse', '--verify', '--quiet', branch], { cwd: descriptor.repoRoot });
  if (branchExists.status === 0) {
    branch = `${BRANCH_PREFIX}${safeLaneId.slice(0, 8)}`;
  }

  const addArgs = ['worktree', 'add', '-b', branch, worktreePath, baseRef];
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
 */
export function removeLaneWorktree({ repoRoot, worktreePath, removeBranch = false, branch = null }) {
  if (!repoRoot || !worktreePath) {
    return { removed: false, reason: 'repoRoot and worktreePath are required.' };
  }
  const descriptor = describeRepoRoot(repoRoot);
  if (!descriptor.ok) {
    return { removed: false, reason: descriptor.reason };
  }
  const removeResult = runGit(['worktree', 'remove', '--force', worktreePath], { cwd: descriptor.repoRoot });
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

export function listLaneWorktrees(repoRoot) {
  const descriptor = describeRepoRoot(repoRoot);
  if (!descriptor.ok) return [];
  const result = runGit(['worktree', 'list', '--porcelain'], { cwd: descriptor.repoRoot });
  if (result.status !== 0) return [];
  return parseWorktreeList(result.stdout);
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

export { buildBranchName, parseWorktreeList };
