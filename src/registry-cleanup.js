// Artifact cleanup schedule + cleanup execution methods, as a prototype mixin
// for OrcaRegistry. Extracted from registry.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { LANE_STATES } from './worker-contract.js';
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

    const targetSessions = sessionId
      ? this.sessions.filter((session) => session.id === String(sessionId))
      : this.sessions;
    if (sessionId && !targetSessions.length) {
      throw {
        status: 404,
        message: 'Session not found.',
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
          await fs.rm(laneDir, { recursive: true, force: true });
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
