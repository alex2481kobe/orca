// Session workspace provisioning + lane workdir resolution (path-boundary
// enforcement) as a prototype mixin for OrcaRegistry.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ensureDirectorySync,
  isPathWithinBoundary,
  isRealPathWithinBoundarySync,
  realpathSyncSafe,
} from './registry-utils.js';
import {
  DEFAULT_APPROVED_CAPACITY,
  normalizeSpawnPolicy,
  normalizeWorktreeMode,
  resolveOrchestratorCapacity,
} from './registry-lane-config.js';
import {
  FENCE_STATUS,
  describeFence as fenceReport,
  resolveFence,
  setupRequiredError,
} from './fence.js';

const MAX_WORKDIR_BYTES = 2048;

function sanitizeWorkdirInput(raw) {
  if (raw === undefined || raw === null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  if (text.length > MAX_WORKDIR_BYTES) return '__INVALID_LENGTH__';
  if (/\x00/.test(text)) return '__INVALID_BYTES__';
  return text;
}

function nearestExistingPathSync(targetPath) {
  let current = path.resolve(targetPath);
  while (current && current !== path.dirname(current)) {
    try {
      fsSync.lstatSync(current);
      return current;
    } catch {
      current = path.dirname(current);
    }
  }
  try {
    fsSync.lstatSync(current);
    return current;
  } catch {
    return null;
  }
}

export const workspaceMethods = {
  // v2: containers are orchestrator records. Ensure each orchestrator's on-disk
  // workspace + artifact dirs exist (keyed by orchestrator id) and backfill
  // capacity defaults onto records restored from an older store.
  ensureSessionWorkspaces() {
    let migrated = false;
    for (const orchestrator of (this.orchestrators || [])) {
      if (!orchestrator || !orchestrator.id) continue;
      const capacity = resolveOrchestratorCapacity(orchestrator, DEFAULT_APPROVED_CAPACITY);
      if (orchestrator.approvedCapacity !== capacity || orchestrator.laneConcurrencyLimit !== capacity) {
        orchestrator.approvedCapacity = capacity;
        orchestrator.laneConcurrencyLimit = capacity;
        migrated = true;
      }
      const normalizedSpawn = normalizeSpawnPolicy(orchestrator.spawnPolicy, 'auto');
      if (normalizedSpawn !== orchestrator.spawnPolicy) {
        orchestrator.spawnPolicy = normalizedSpawn;
        migrated = true;
      }
      ensureDirectorySync(path.join(this.artifactRoot, orchestrator.id));
      ensureDirectorySync(path.join(this.workspacesRoot, orchestrator.id));
    }

    if (migrated) {
      this.persistState().catch(() => {});
    }
  },

  getSessionWorktreeRoot(session) {
    if (!session || !session.id) {
      return path.join(this.workspacesRoot, 'orphan');
    }
    return path.resolve(session.worktreeRoot || path.join(this.workspacesRoot, session.id));
  },

  // The fence (src/fence.js). The daemon resolves it once, at start, from
  // ORCA_REPO_ROOTS or the Orca config file, and root changes apply at the next
  // start, because executor adapters snapshot the roots they may run in. A
  // registry built without one (tests, tooling) reads ORCA_REPO_ROOTS on every
  // call and never reads the user's config file.
  getFence() {
    return this.fence || resolveFence({ env: process.env });
  },

  describeFence() {
    return fenceReport(this.getFence());
  },

  // Exactly the configured roots, or none. No working directory is ever added,
  // and a fence that is not configured approves nothing.
  getApprovedRepoRoots() {
    const fence = this.getFence();
    return fence.status === FENCE_STATUS.CONFIGURED ? [...fence.roots] : [];
  },

  // The setup-required refusal every agent-facing entry point shares.
  assertFenceConfigured() {
    const fence = this.getFence();
    if (fence.status !== FENCE_STATUS.CONFIGURED) throw setupRequiredError(fence);
    return fence;
  },

  // Launch-time recheck against the fence in force now. The lane may run in its
  // own worktree under Orca's workspaces, but the project it works on (its repo
  // root and its project's cwd) must be inside the roots. Real paths when the
  // directory exists, lexical otherwise.
  laneInsideFence(lane) {
    const roots = this.getApprovedRepoRoots();
    const inside = (dir, allowed) => {
      const target = String(dir || '').trim();
      if (!target) return true;
      if (realpathSyncSafe(target)) return allowed.some((root) => isRealPathWithinBoundarySync(target, root));
      return allowed.some((root) => isPathWithinBoundary(path.resolve(target), path.resolve(root)));
    };
    const project = (this.projects || []).find((item) => item.id === lane?.projectId);
    return inside(lane?.workdir, [this.workspacesRoot, ...roots])
      && inside(lane?.repoRoot, roots)
      && inside(project?.cwd, roots);
  },

  // A queued lane is held, not failed, while Orca is not set up. Say so once.
  noteLaneHeldByFence(lane, fence) {
    if (!this._fenceHeldLanes) this._fenceHeldLanes = new Set();
    if (this._fenceHeldLanes.has(lane.id)) return;
    this._fenceHeldLanes.add(lane.id);
    this.appendLaneLog(lane, `Held in the queue, not launched: ${fence.summary} Fix: ${fence.fix}`, { persist: false });
  },

  // Powers the workstation directory picker (desktop + remote). Jailed to the
  // approved repo roots: a remote/paired device can browse the workstation's
  // folders to pick a working directory, but can never escape the allowlist or
  // read file contents. Returns directories only (it is a working-dir chooser),
  // flags git working trees, and refuses traversal/symlink escapes. The browsable
  // area is exactly the fence's roots (orca-cli.js setup --roots).
  async listWorkstationDirs({ path: requestedPath = '' } = {}) {
    const roots = [...new Set(this.getApprovedRepoRoots().map((root) => path.resolve(root)))];
    const withinAnyRoot = (target) => roots.some((root) => target === root || isPathWithinBoundary(target, root));

    const rootEntries = roots.map((root) => ({
      name: path.basename(root) || root,
      path: root,
      isDirectory: true,
      isGitRepo: false,
    }));

    // No path -> open directly into the primary root (HOME), Finder-style, instead
    // of a bare "roots" chooser. (rootEntries kept for the multi-root env case.)
    const raw = String(requestedPath || '').trim() || roots[0] || '';
    if (!raw) {
      return { roots, path: null, parent: null, entries: rootEntries };
    }
    if (raw.length > 4096 || raw.includes('\x00')) {
      throw { status: 422, message: 'Invalid directory path.' };
    }

    const resolved = path.resolve(raw);
    if (!withinAnyRoot(resolved)) {
      throw { status: 403, message: 'Directory is outside the approved workstation roots. An operator widens them with orca-cli.js setup --roots.' };
    }

    // Symlink-escape guard: the real path must also stay inside the jail.
    let realResolved;
    try {
      realResolved = await fs.realpath(resolved);
    } catch {
      throw { status: 404, message: 'Directory not found.' };
    }
    if (!withinAnyRoot(realResolved)) {
      throw { status: 403, message: 'Directory resolves outside the approved workstation roots.' };
    }

    let dirents;
    try {
      dirents = await fs.readdir(realResolved, { withFileTypes: true });
    } catch {
      throw { status: 404, message: 'Directory could not be read.' };
    }

    const entries = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
      if (dirent.name.startsWith('.') && dirent.name !== '.') continue; // hide dotdirs from the picker
      const childPath = path.join(realResolved, dirent.name);
      if (!withinAnyRoot(childPath)) continue;
      let isGitRepo = false;
      try {
        const gitStat = await fs.stat(path.join(childPath, '.git'));
        isGitRepo = gitStat.isDirectory() || gitStat.isFile();
      } catch { /* not a git repo */ }
      entries.push({ name: dirent.name, path: childPath, isDirectory: true, isGitRepo });
      if (entries.length >= 1000) break; // cap very large directories
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = path.dirname(realResolved);
    const parent = (parentPath !== realResolved && withinAnyRoot(parentPath)) ? parentPath : null;

    return { roots, path: realResolved, parent, entries };
  },

  resolveLaneWorkdir(session, rawWorkdir) {
    const sessionWorkdir = this.getSessionWorktreeRoot(session);
    const requested = sanitizeWorkdirInput(rawWorkdir);
    if (requested === '__INVALID_LENGTH__') {
      throw {
        status: 422,
        message: 'Lane workdir path is too long.',
      };
    }
    if (requested === '__INVALID_BYTES__') {
      throw {
        status: 422,
        message: 'Lane workdir path contains invalid characters.',
      };
    }
    // Relative workdirs MUST resolve under the session worktreeRoot (no escape).
    // Absolute workdirs may live within the session worktreeRoot OR within an
    // approved repo root (the fence's roots; never the daemon's working dir).
    let workdir;
    if (!requested) {
      workdir = sessionWorkdir;
    } else if (path.isAbsolute(requested)) {
      workdir = path.resolve(requested);
      const approvedRoots = [sessionWorkdir, ...this.getApprovedRepoRoots()];
      const within = approvedRoots.some((root) => isPathWithinBoundary(workdir, root));
      if (!within) {
        throw {
          status: 422,
          message: 'Lane workdir is outside approved execution roots.',
        };
      }
    } else {
      workdir = path.resolve(sessionWorkdir, requested);
      if (!isPathWithinBoundary(workdir, sessionWorkdir)) {
        throw {
          status: 422,
          message: 'Lane workdir is outside the session workspace boundary.',
        };
      }
    }
    const approvedRoots = path.isAbsolute(requested)
      ? [sessionWorkdir, ...this.getApprovedRepoRoots()]
      : [sessionWorkdir];
    const nearestExisting = nearestExistingPathSync(workdir);
    const existingParentAllowed = nearestExisting
      ? approvedRoots.some((root) => isRealPathWithinBoundarySync(nearestExisting, root))
      : false;
    if (!existingParentAllowed) {
      throw {
        status: 422,
        message: 'Lane workdir resolves outside approved execution roots.',
      };
    }
    try {
      ensureDirectorySync(workdir);
    } catch {
      throw {
        status: 422,
        message: 'Lane workdir could not be created.',
      };
    }
    const withinRealBoundary = approvedRoots.some((root) => isRealPathWithinBoundarySync(workdir, root));
    if (!withinRealBoundary) {
      throw {
        status: 422,
        message: 'Lane workdir resolves outside approved execution roots.',
      };
    }
    return realpathSyncSafe(workdir) || workdir;
  },
};
