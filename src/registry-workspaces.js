// Session workspace provisioning + lane workdir resolution (path-boundary
// enforcement) as a prototype mixin for OrcaRegistry. Extracted from registry.js.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDirectorySync, isPathWithinBoundary } from './registry-utils.js';
import {
  DEFAULT_APPROVED_CAPACITY,
  normalizeApprovedCapacity,
  normalizeSpawnPolicy,
  normalizeIdleShutdownMode,
  normalizeCritiqueMode,
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

export const workspaceMethods = {
  ensureSessionWorkspaces() {
    let migrated = false;
    for (const session of this.sessions) {
      if (!session) continue;
      if (!session.id) {
        session.id = randomUUID();
        migrated = true;
      }

      if (!session.artifactsRoot) {
        session.artifactsRoot = path.join(this.artifactRoot, session.id);
        migrated = true;
      }
      if (!session.worktreeRoot) {
        session.worktreeRoot = path.join(this.workspacesRoot, session.id);
        migrated = true;
      }
      if (!Number.isFinite(Number.parseInt(session.approvedCapacity, 10))) {
        session.approvedCapacity = normalizeApprovedCapacity(session.laneConcurrencyLimit, DEFAULT_APPROVED_CAPACITY);
        migrated = true;
      }
      const normalizedSpawn = normalizeSpawnPolicy(session.spawnPolicy);
      if (normalizedSpawn !== session.spawnPolicy) {
        session.spawnPolicy = normalizedSpawn;
        migrated = true;
      }
      if (typeof session.soloMode !== 'boolean') {
        session.soloMode = true;
        migrated = true;
      }
      const normalizedIdle = normalizeIdleShutdownMode(session.idleShutdownMode);
      if (normalizedIdle !== session.idleShutdownMode) {
        session.idleShutdownMode = normalizedIdle;
        migrated = true;
      }
      if (!Array.isArray(session.capacityRequests)) {
        session.capacityRequests = [];
        migrated = true;
      }
      const normalizedCritique = normalizeCritiqueMode(session.critiqueMode);
      if (normalizedCritique !== session.critiqueMode) {
        session.critiqueMode = normalizedCritique;
        migrated = true;
      }
      ensureDirectorySync(session.artifactsRoot);
      ensureDirectorySync(session.worktreeRoot);
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
    const fromEnv = String(env || '')
      .split(/[,\n]/)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map((value) => path.resolve(value));
    return [process.cwd(), ...fromEnv];
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
    try {
      ensureDirectorySync(workdir);
    } catch {
      throw {
        status: 422,
        message: 'Lane workdir could not be created.',
      };
    }
    return workdir;
  },
};
