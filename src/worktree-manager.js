import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const MAX_BRANCH_LEN = 200;
const BRANCH_PREFIX = 'orca/lane/';
const DEPENDENCY_DIR = 'node_modules';
const DEPENDENCY_SCAN_SKIP = new Set(['.git', '.orca']);

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

// Count commits on `branch` that are NOT reachable from the repo root's current
// base branch — i.e. work that was committed on the lane branch but never
// integrated. Returns 0 when it can't tell (missing branch, detached HEAD, or the
// branch IS the base), so the caller never refuses on a false positive.
function countUnmergedCommits(repoRoot, branch) {
  const safeBranch = validRefText(branch);
  if (!safeBranch || !refExists(repoRoot, safeBranch)) return 0;
  const headOut = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  const baseBranch = headOut.status === 0 ? headOut.stdout.trim() : '';
  if (!baseBranch || baseBranch === 'HEAD' || baseBranch === safeBranch) return 0;
  const ahead = runGit(['rev-list', '--count', `${baseBranch}..${safeBranch}`], { cwd: repoRoot });
  if (ahead.status !== 0) return 0;
  return Number.parseInt(ahead.stdout.trim(), 10) || 0;
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

function discoverDependencyDirectories(repoRoot) {
  const directories = [];
  const issues = [];

  const visit = (currentDir) => {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      issues.push(`Could not inspect ${path.relative(repoRoot, currentDir) || '.'}: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      if (DEPENDENCY_SCAN_SKIP.has(entry.name)) continue;
      const entryPath = path.join(currentDir, entry.name);
      if (entry.name === DEPENDENCY_DIR) {
        try {
          if (fs.statSync(entryPath).isDirectory()) directories.push(entryPath);
          else issues.push(`${path.relative(repoRoot, entryPath)} is not a directory.`);
        } catch (error) {
          issues.push(`Could not use ${path.relative(repoRoot, entryPath)}: ${error.message}`);
        }
        // Never traverse dependencies: that is both expensive and would discover
        // implementation-private nested installs that Node does not resolve as a
        // package/app toolchain root.
        continue;
      }
      // Do not follow directory symlinks while discovering package roots. Besides
      // preventing cycles, this keeps discovery bounded to the registered checkout.
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(entryPath);
    }
  };

  visit(repoRoot);
  directories.sort((a, b) => a.localeCompare(b));
  return { directories, issues };
}

/**
 * Make an isolated worktree reuse dependency installations already prepared in
 * the registered checkout. Every root/package node_modules directory is linked at
 * the same relative path so npm-workspaces monorepos preserve package-local module
 * resolution as well as their root toolchain.
 *
 * The links deliberately share mutable targets. Callers must surface the returned
 * warning to executors: existing tools may run, but install/update/prune commands
 * must run in the parent checkout, never through a lane link.
 */
export function prepareLaneToolchain({ repoRoot, worktreePath }) {
  const { directories, issues: scanIssues } = discoverDependencyDirectories(repoRoot);
  const linked = [];
  const issues = [...scanIssues];

  for (const sourcePath of directories) {
    const relativePath = path.relative(repoRoot, sourcePath);
    const destinationPath = path.join(worktreePath, relativePath);
    const destinationParent = path.dirname(destinationPath);
    if (!directoryExists(destinationParent)) {
      issues.push(`Skipped ${relativePath}: its package directory is not present in the worktree.`);
      continue;
    }

    try {
      const existing = fs.lstatSync(destinationPath, { throwIfNoEntry: false });
      if (existing) {
        if (!existing.isSymbolicLink()) {
          issues.push(`Skipped ${relativePath}: the worktree path already exists and is not a symlink.`);
          continue;
        }
        const existingTarget = fs.realpathSync(destinationPath);
        const sourceTarget = fs.realpathSync(sourcePath);
        if (existingTarget !== sourceTarget) {
          issues.push(`Skipped ${relativePath}: the worktree symlink points somewhere else.`);
          continue;
        }
      } else {
        fs.symlinkSync(sourcePath, destinationPath, process.platform === 'win32' ? 'junction' : 'dir');
      }
      linked.push(relativePath);
    } catch (error) {
      issues.push(`Could not link ${relativePath}: ${error.message}`);
    }
  }

  const discoveredCount = directories.length;
  const linkedCount = linked.length;
  let status = 'linked';
  if (discoveredCount === 0 || linkedCount === 0) status = 'unavailable';
  else if (linkedCount !== discoveredCount || issues.length) status = 'partial';

  let message;
  if (status === 'linked') {
    message = `Linked ${linkedCount} existing node_modules director${linkedCount === 1 ? 'y' : 'ies'} from the parent checkout. These shared dependencies are read/write: run existing tools, but do not run install, update, or prune commands in this lane.`;
  } else if (status === 'partial') {
    message = `Linked ${linkedCount} of ${discoveredCount} existing node_modules directories from the parent checkout. Some package toolchains may be unavailable. Linked dependencies are shared and must not be installed, updated, or pruned from this lane.`;
  } else {
    message = discoveredCount === 0
      ? 'No node_modules directories exist in the parent checkout, so this isolated lane has no prepared JavaScript/TypeScript toolchain. Prepare dependencies in the parent checkout, then retry the lane.'
      : `Could not link any of the ${discoveredCount} existing node_modules directories from the parent checkout. This isolated lane has no prepared JavaScript/TypeScript toolchain; inspect the setup issues before running checks.`;
  }

  return {
    status,
    strategy: 'shared-symlink',
    sharedMutable: linkedCount > 0,
    discoveredCount,
    linkedCount,
    linked,
    issues: issues.slice(0, 32),
    message,
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
        toolchainSetup: prepareLaneToolchain({ repoRoot: descriptor.repoRoot, worktreePath }),
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
    toolchainSetup: prepareLaneToolchain({ repoRoot: descriptor.repoRoot, worktreePath }),
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
    // Second data-loss guard: a branch with commits that were never integrated
    // into the base branch would be silently lost by `worktree remove --force`.
    if (branch) {
      const unmerged = countUnmergedCommits(descriptor.repoRoot, branch);
      if (unmerged > 0) {
        return {
          removed: false,
          reason: `Branch "${branch}" has ${unmerged} commit(s) not integrated into the base branch. Integrate them (lane.integrate) or pass force:true to discard them.`,
          unmergedCommits: unmerged,
          branch,
        };
      }
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
  return worktreeCleanliness(worktreePath).files;
}

function isSharedDependencyLinkStatus(worktreePath, statusLine) {
  if (!String(statusLine || '').startsWith('?? ')) return false;
  let relativePath = statusLine.slice(3);
  if (relativePath.startsWith('"')) {
    try { relativePath = JSON.parse(relativePath); } catch { return false; }
  }
  if (path.basename(relativePath) !== DEPENDENCY_DIR) return false;

  const worktreeRoot = path.resolve(worktreePath);
  const candidate = path.resolve(worktreeRoot, relativePath);
  if (!candidate.startsWith(`${worktreeRoot}${path.sep}`)) return false;
  try {
    if (!fs.lstatSync(candidate).isSymbolicLink()) return false;
    const rawTarget = fs.readlinkSync(candidate);
    const target = path.resolve(path.dirname(candidate), rawTarget);
    return path.basename(target) === DEPENDENCY_DIR
      && !target.startsWith(`${worktreeRoot}${path.sep}`);
  } catch {
    return false;
  }
}

/**
 * Cleanliness probe that distinguishes "clean" from "could not tell".
 * changedFilesIn() collapses both to [], which is fine for display but fails OPEN
 * for anything that can destroy work: an unreadable or broken .git makes a dirty
 * worktree look clean, and integration would then stamp integratedAt on work it
 * never merged — the exact loss this guard exists to prevent. Callers gating a
 * destructive step must use this and refuse when `ok` is false.
 */
export function worktreeCleanliness(worktreePath) {
  if (!worktreePath) return { ok: false, files: [], error: 'No worktree path to inspect.' };
  try {
    const result = runGit(['status', '--porcelain'], { cwd: worktreePath });
    if (result.status !== 0) {
      return { ok: false, files: [], error: String(result.stderr || '').trim() || `git status exited ${result.status}` };
    }
    const files = result.stdout.split('\n')
      // Dependency links are Orca-created worktree plumbing, not lane-authored
      // source changes. Some repositories do not ignore node_modules; filtering
      // only an untracked node_modules SYMLINK to a target outside this worktree
      // keeps status/integration honest without hiding real files or directories.
      .filter((line) => !isSharedDependencyLinkStatus(worktreePath, line))
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 500);
    return {
      ok: true,
      files,
      error: null,
    };
  } catch (error) {
    return { ok: false, files: [], error: error?.message || String(error) };
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
