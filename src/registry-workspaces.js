// Session workspace provisioning + lane workdir resolution (path-boundary
// enforcement) as a prototype mixin for OrcaRegistry. Extracted from registry.js.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
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
  normalizeApprovedCapacity,
  normalizeSpawnPolicy,
  normalizeIdleShutdownMode,
  normalizeCritiqueMode,
  normalizeWorktreeMode,
} from './registry-lane-config.js';

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
    const DEFAULT_ORCHESTRATOR_CAPACITY = 4;
    for (const orchestrator of (this.orchestrators || [])) {
      if (!orchestrator || !orchestrator.id) continue;
      if (!Number.isFinite(Number.parseInt(orchestrator.approvedCapacity, 10))) {
        orchestrator.approvedCapacity = normalizeApprovedCapacity(orchestrator.laneConcurrencyLimit, DEFAULT_ORCHESTRATOR_CAPACITY);
        migrated = true;
      }
      if (!Number.isFinite(Number.parseInt(orchestrator.laneConcurrencyLimit, 10))) {
        orchestrator.laneConcurrencyLimit = normalizeApprovedCapacity(orchestrator.approvedCapacity, DEFAULT_ORCHESTRATOR_CAPACITY);
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

  getApprovedRepoRoots() {
    const env = process.env.ORCA_REPO_ROOTS;
    if (env) {
      const fromEnv = String(env)
        .split(/[,\n]/)
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .map((value) => path.resolve(value));
      return [...new Set([process.cwd(), ...fromEnv].map((value) => path.resolve(value)))];
    }
    // Default (no ORCA_REPO_ROOTS): the operator's HOME directory is the single
    // browsable root, so the folder picker starts at ~ and can reach any project
    // (~/Documents/Projects/*). HOME contains the launch dir for normal setups; if
    // Orca was launched from outside HOME we also include the cwd so it stays
    // reachable. Set ORCA_REPO_ROOTS to override.
    const roots = [];
    try { const home = os.homedir(); if (home) roots.push(path.resolve(home)); } catch { /* no home */ }
    const cwd = path.resolve(process.cwd());
    if (!roots.some((root) => cwd === root || isPathWithinBoundary(cwd, root))) roots.push(cwd);
    return [...new Set(roots)];
  },

  // Powers the workstation directory picker (desktop + remote). Jailed to the
  // approved repo roots: a remote/paired device can browse the workstation's
  // folders to pick a working directory, but can never escape the allowlist or
  // read file contents. Returns directories only (it is a working-dir chooser),
  // flags git working trees, and refuses traversal/symlink escapes. Widen the
  // browsable area with ORCA_REPO_ROOTS.
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
      throw { status: 403, message: 'Directory is outside the approved workstation roots. Add it to ORCA_REPO_ROOTS.' };
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
    // approved repo root (default: process.cwd()).
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
