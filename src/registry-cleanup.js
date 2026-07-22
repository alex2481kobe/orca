// Artifact cleanup schedule + cleanup execution methods, as a prototype mixin
// for OrcaRegistry. Extracted from registry.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { LANE_STATES } from './worker-contract.js';
import { removeLaneWorktree } from './worktree-manager.js';
import { safeRmRecursive } from './safe-fs.js';
import { parsePositiveInteger, parsePositiveFloat, clonePayload, nowIso } from './registry-utils.js';
import { defaultPolicy } from './registry-policy.js';

const {
  READY_FOR_AUDIT: READY_FOR_AUDIT_STATE,
  FIX_REQUESTED: FIX_REQUESTED_STATE,
  ACCEPTED: ACCEPTED_STATE,
  BLOCKED: BLOCKED_STATE,
  FAILED: FAILED_STATE,
  STOPPED: STOPPED_STATE,
  DONE: DONE_STATE,
} = LANE_STATES;

async function getDirectorySize(directoryPath) {
  let bytes = 0;
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        bytes += await getDirectorySize(resolved);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(resolved);
        bytes += stat.size || 0;
      } catch {
        continue;
      }
    }
  } catch {
    return 0;
  }
  return bytes;
}

export const cleanupMethods = {
  getCleanupSchedule() {
    return clonePayload(this.cleanupSchedule);
  },

  updateCleanupSchedule({
    enabled,
    intervalHours,
    olderThanDays,
    sessionId,
    dryRun,
  } = {}, context = {}) {
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('manageCleanupSchedule', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const next = { ...this.cleanupSchedule };
    if (typeof enabled === 'boolean') {
      next.enabled = enabled;
    }

    const parsedInterval = parsePositiveFloat(intervalHours, null);
    if (intervalHours !== undefined) {
      if (parsedInterval === null) {
        throw { status: 422, message: 'intervalHours must be a positive number when provided.' };
      }
      if (parsedInterval > 720) {
        throw { status: 422, message: 'Cleanup interval cannot exceed 720 hours.' };
      }
      next.intervalHours = parsedInterval;
    }

    if (olderThanDays !== undefined) {
      if (olderThanDays === null) {
        next.olderThanDays = null;
      } else {
        const parsedRetention = parsePositiveInteger(olderThanDays, null);
        if (parsedRetention === null) {
          throw { status: 422, message: 'olderThanDays must be a positive integer or null.' };
        }
        next.olderThanDays = parsedRetention;
      }
    }

    if (typeof dryRun === 'boolean') {
      next.dryRun = dryRun;
    }

    if (sessionId) {
      const targetSession = this.getSession(sessionId);
      if (!targetSession) {
        throw { status: 404, message: 'Session not found.' };
      }
      next.sessionId = targetSession.id;
    } else if (sessionId === null) {
      next.sessionId = null;
    }

    if (next.enabled) {
      const cadenceMs = next.intervalHours * 60 * 60 * 1000;
      const now = Date.now();
      next.nextRunAt = new Date(now + cadenceMs).toISOString();
    } else {
      next.nextRunAt = null;
    }

    this.cleanupSchedule = next;
    this.recordAudit({
      type: 'cleanup_schedule_updated',
      actor,
      summary: `Artifact cleanup schedule ${next.enabled ? 'enabled' : 'disabled'}`,
      evidence: { cleanupSchedule: next },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(this.cleanupSchedule);
  },

  async cleanupArtifacts({
    actor = 'dashboard',
    approved,
    skipApproval = false,
    dryRun = false,
    confirmed = false,
    sessionId = null,
    olderThanDays = null,
  } = {}) {
    const policyCheck = this.evaluateActionPolicy('cleanupArtifacts', {
      actor,
      approved,
      skipApproval,
    });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const isDryRun = Boolean(dryRun);
    if (!isDryRun && !skipApproval && !confirmed) {
      throw {
        status: 409,
        message: 'Destructive cleanup requires explicit confirmation.',
        risk: defaultPolicy.cleanupArtifacts.risk,
      };
    }

    // v2: containers are orchestrator records; getSession returns a retention-aware
    // container view for each (artifacts live under artifacts/<orchestratorId>/).
    const targetSessions = sessionId
      ? [this.getSession(String(sessionId))].filter(Boolean)
      : (this.orchestrators || []).map((orch) => this.getSession(orch.id)).filter(Boolean);
    if (sessionId && !targetSessions.length) {
      throw {
        status: 404,
        message: 'Orchestrator not found.',
      };
    }

    const terminalStates = new Set([DONE_STATE, READY_FOR_AUDIT_STATE, ACCEPTED_STATE, FIX_REQUESTED_STATE, BLOCKED_STATE, FAILED_STATE, STOPPED_STATE]);
    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;
    const summary = {
      scanned: 0,
      candidates: 0,
      removed: 0,
      removedLanes: [],
      dryRun,
      errors: 0,
      removedBytes: 0,
      sessionId: sessionId ? String(sessionId) : null,
      olderThanDays: parsePositiveInteger(olderThanDays, null),
    };
    const fallbackRetentionDays = 14;

    for (const session of targetSessions) {
      const retentionDays = parsePositiveInteger(session.artifactRetentionDays, fallbackRetentionDays);
      // An explicit olderThanDays from the caller takes precedence (operator asked
      // for a specific window); otherwise fall back to the session's retention.
      const effectiveRetentionDays = summary.olderThanDays || retentionDays;
      const deadline = now - (effectiveRetentionDays * msPerDay);
      const sessionLanes = this.lanes.filter((lane) => lane.sessionId === session.id && terminalStates.has(lane.state));
      for (const lane of sessionLanes) {
        summary.scanned += 1;
        const laneTimestamp = new Date(lane.completedAt || lane.updatedAt || lane.createdAt).getTime();
        if (!Number.isFinite(laneTimestamp) || laneTimestamp >= deadline) {
          continue;
        }

        summary.candidates += 1;
        if (dryRun) continue;
        const laneDir = path.join(process.cwd(), 'artifacts', session.id, lane.id);
        try {
          const laneBytes = await getDirectorySize(laneDir);
          const guard = await safeRmRecursive(laneDir, path.join(process.cwd(), 'artifacts'));
          if (!guard.removed) throw new Error(guard.reason);
          summary.removed += 1;
          summary.removedBytes += laneBytes;
          summary.removedLanes.push({
            laneId: lane.id,
            sessionId: session.id,
            removedBytes: laneBytes,
            removed: true,
          });
        } catch (error) {
          summary.errors += 1;
          summary.removedLanes.push({
            laneId: lane.id,
            sessionId: session.id,
            removed: false,
            reason: error?.message || 'Unknown error.',
          });
        }
      }
    }

    if (!dryRun) {
      this.recordAudit({
        type: 'artifacts_cleanup',
        actor,
        summary: `Artifact cleanup completed (dryRun=${dryRun}, sessionId=${sessionId || 'all'}, olderThanDays=${summary.olderThanDays || 'default'})`,
        evidence: {
          removed: summary.removed,
          candidates: summary.candidates,
          scanned: summary.scanned,
          errors: summary.errors,
          removedBytes: summary.removedBytes,
          sessionId: summary.sessionId,
          olderThanDays: summary.olderThanDays,
          dryRun,
        },
        status: 'passed',
      });
    }

    this.persistState();
    return summary;
  },

  // Bound in-memory growth on a long-lived server: keep only the most recent
  // terminal lanes/tasks per session (everything else — auditEvents, notifications,
  // toolLeases, logs — is already capped). Caps are generous + env-configurable.
  // Cheap early-out when nothing is large; called throttled from the scheduler.
  pruneInMemoryRecords() {
    const TERMINAL_LANES = new Set(['done', 'failed', 'stopped', 'accepted', 'archived']);
    const maxLanes = parsePositiveInteger(process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION, null) || 200;
    const laneCount = Array.isArray(this.lanes) ? this.lanes.length : 0;
    if (laneCount <= maxLanes) return false; // no session can exceed its cap
    // USER POLICY: an isolated lane's on-disk worktree must NOT be reaped by
    // retention pruning while it still holds un-integrated work. Reaping only
    // happens after lane.integrate succeeds (sets integratedAt) or an explicit
    // lane.worktree.discard (clears worktreePath). Such lanes are excluded from
    // the drop set entirely — pruning the record while leaving the worktree on
    // disk would strand the checkout under .orca/workspaces with no lane pointing
    // at it, so we keep BOTH the record and the worktree until it's integrated.
    const holdsUnintegratedWorktree = (lane) => {
      if (!lane) return false;
      if (lane.integratedAt) return false; // merged back — safe to reap
      if (lane.sharedWorktree || lane.worktreeMode === 'shared') return false;
      const wt = lane.worktreePath ? String(lane.worktreePath) : '';
      if (!wt) return false; // already discarded/removed
      if (lane.repoRoot && path.resolve(wt) === path.resolve(lane.repoRoot)) return false; // ran in-place
      return true; // isolated lane with a live, un-integrated worktree
    };
    let changed = false;
    const ts = (record, ...keys) => {
      for (const k of keys) { const v = Date.parse(record?.[k] || 0); if (Number.isFinite(v) && v) return v; }
      return 0;
    };
    const dropOldest = (records, max, tsKeys) => {
      const bySession = new Map();
      for (const r of records) {
        const arr = bySession.get(r.sessionId) || []; arr.push(r); bySession.set(r.sessionId, arr);
      }
      const drop = new Set();
      for (const arr of bySession.values()) {
        if (arr.length <= max) continue;
        arr.sort((a, b) => ts(a, ...tsKeys) - ts(b, ...tsKeys));
        for (const r of arr.slice(0, arr.length - max)) drop.add(r.id);
      }
      return drop;
    };
    const dropLaneIds = dropOldest(
      (this.lanes || []).filter((l) => TERMINAL_LANES.has(l.state) && !holdsUnintegratedWorktree(l)),
      maxLanes,
      ['completedAt', 'updatedAt'],
    );
    if (dropLaneIds.size) {
      // Reclaim each pruned lane's on-disk git worktree before dropping the
      // record — otherwise terminal-lane pruning orphans isolated checkouts
      // under .orca/workspaces forever (deleteLane cleaned up, prune did not).
      // Guarded like deleteLane: skip shared/non-managed worktrees and never
      // touch the repo root; removeLaneWorktree also refuses any path git does
      // not track as a worktree of the repo. Best-effort and synchronous.
      for (const lane of this.lanes.filter((l) => dropLaneIds.has(l.id))) {
        if (!lane.repoRoot || !lane.worktreePath) continue;
        if (lane.sharedWorktree || lane.worktreeMode === 'shared') continue;
        if (path.resolve(lane.worktreePath) === path.resolve(lane.repoRoot)) continue;
        try {
          removeLaneWorktree({ repoRoot: lane.repoRoot, worktreePath: lane.worktreePath, removeBranch: false });
        } catch { /* best effort — a failed reclaim must not block pruning */ }
      }
      this.lanes = this.lanes.filter((l) => !dropLaneIds.has(l.id));
      for (const id of dropLaneIds) { this.laneRuntimeEnv?.delete(String(id)); if (typeof this.clearLaneExecutor === 'function') this.clearLaneExecutor(id); }
      // v2: orchestrator records don't carry a session-thread laneIds list, so
      // there is nothing to prune there (lanes reference their orchestrator directly).
      changed = true;
    }
    if (changed) this.persistState();
    return changed;
  },

  async runCleanupSchedulerTick() {
    if (!this.cleanupSchedule.enabled) return;
    if (!this.cleanupSchedule.nextRunAt) return;

    const now = Date.now();
    const next = Date.parse(this.cleanupSchedule.nextRunAt);
    if (!Number.isFinite(next) || now < next) return;

    const result = await this.cleanupArtifacts({
      actor: 'scheduler',
      approved: true,
      skipApproval: true,
      sessionId: this.cleanupSchedule.sessionId,
      olderThanDays: this.cleanupSchedule.olderThanDays,
      dryRun: Boolean(this.cleanupSchedule.dryRun),
    });

    const cadenceMs = (parsePositiveFloat(this.cleanupSchedule.intervalHours, 24) || 24) * 60 * 60 * 1000;
    this._lastTickMs = (this._lastTickMs || 0) + 1;
    this.cleanupSchedule.lastRunAt = nowIso();
    this.cleanupSchedule.nextRunAt = new Date(now + cadenceMs + this._lastTickMs).toISOString();
    this.recordAudit({
      type: 'artifacts_cleanup_scheduler_run',
      actor: 'scheduler',
      summary: 'Automatic artifact cleanup executed',
      evidence: {
        removed: result.removed,
        removedLanes: result.removedLanes,
        candidates: result.candidates,
        scanned: result.scanned,
        dryRun: result.dryRun,
      },
      status: 'passed',
    });
    this.persistState();
  },
};
