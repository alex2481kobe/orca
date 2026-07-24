// In-memory record pruning (bounds growth on a long-lived server) + reclaiming a
// terminal lane's git worktree, as a prototype mixin for OrcaRegistry.
//
// The artifact-GC RETENTION SCHEDULE that used to live here (intervalHours /
// olderThanDays / dryRun, its two MCP tools, its routes, and the scheduler tick
// that ran it) is gone: nothing ever enabled it, and a background job that deletes
// a user's artifacts off disk on a timer is exactly the kind of unvalidated
// machinery this daemon does not need.

import path from 'node:path';
import { LANE_STATES } from './worker-contract.js';
import { removeLaneWorktree } from './worktree-manager.js';
import { parsePositiveInteger } from './registry-utils.js';

export const cleanupMethods = {
  // Bound in-memory growth on a long-lived server: keep only the most recent
  // terminal lanes/tasks (everything else — auditEvents, notifications,
  // toolLeases, logs — is already capped). Caps are generous + env-configurable.
  // Cheap early-out when nothing is large; called throttled from the scheduler.
  pruneInMemoryRecords() {
    const TERMINAL_LANES = new Set(['done', 'failed', 'stopped', 'accepted', 'archived']);
    const maxLanes = parsePositiveInteger(process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION, null) || 200;
    const laneCount = Array.isArray(this.lanes) ? this.lanes.length : 0;
    if (laneCount <= maxLanes) return false; // total lanes still under the cap
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

};
