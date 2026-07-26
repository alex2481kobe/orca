// Executor-adapter management + the scheduler run loop (lane lifecycle engine)
// as a prototype mixin for OrcaRegistry. Extracted from registry.js.

import { LANE_STATES, isRunningLaneState, isLiveLaneState } from './worker-contract.js';
import { nowIso } from './registry-utils.js';
import { createExecutorAdapter } from './executor-factory.js';
import { normalizeApprovedCapacity, normalizeSpawnPolicy } from './registry-lane-config.js';

const {
  QUEUED: QUEUED_STATE,
  STARTING: STARTING_STATE,
  RUNNING: RUNNING_STATE,
} = LANE_STATES;

export const schedulerMethods = {
  getExecutorForType(executorType = 'mock') {
    const normalized = String(executorType || 'mock').toLowerCase();
    if (this.executors[normalized]) return this.executors[normalized];
    return this.getUnknownExecutor(normalized);
  },

  getUnknownExecutor(executorType = 'mock') {
    const normalized = String(executorType || 'mock').toLowerCase();
    if (this.unknownExecutorAdapters.has(normalized)) {
      return this.unknownExecutorAdapters.get(normalized);
    }

    const callbackBundle = {
      extraWorkdirRoots: [
        this.workspacesRoot,
        ...(typeof this.getApprovedRepoRoots === 'function' ? this.getApprovedRepoRoots() : []),
      ].filter(Boolean),
      onLog: (lane, message) => this.appendLaneLog(lane, message, { persist: false }),
      onAgentEvent: (lane, agentEvent) => this.appendLaneAgentEvent(lane, agentEvent, { persist: false }),
      onComplete: async (lane) => this.markLaneCompleted(lane),
      onFail: async (lane, reason) => this.markLaneFailed(lane, reason, 'scheduler'),
      onStop: async (lane, context) => this.markLaneStopped(lane, context),
      runtimeEnvForLane: (lane) => this.laneRuntimeEnv.get(String(lane?.id || '')) || {},
    };
    const adapter = createExecutorAdapter(normalized, callbackBundle);
    this.unknownExecutorAdapters.set(normalized, adapter);
    return adapter;
  },

  getExecutorForLane(lane) {
    const mapped = this.laneExecutorMap.get(lane?.id);
    if (mapped) return mapped;
    return this.getExecutorForType(lane?.executorType || 'mock');
  },

  setLaneExecutor(laneId, executor) {
    if (!laneId || !executor) return;
    this.laneExecutorMap.set(String(laneId), executor);
  },

  clearLaneExecutor(laneId) {
    if (!laneId) return;
    this.laneExecutorMap.delete(String(laneId));
  },

  // Does this lane still have a LIVE child process, regardless of what its state
  // field says? lane.submit flips state to ready_for_audit while the executor is
  // still running (process exit is the authoritative completion signal, not the
  // submit call), so lane.state alone under-reports occupancy — it let a submitted
  // but still-writing executor stop counting against capacity/isolation.
  isLaneProcessLive(laneId) {
    if (!laneId) return false;
    const key = String(laneId);
    const adapters = [...Object.values(this.executors), ...this.unknownExecutorAdapters.values()];
    for (const adapter of adapters) {
      if (typeof adapter.getActiveLaneIds !== 'function') continue;
      if (adapter.getActiveLaneIds().some((id) => String(id) === key)) return true;
    }
    return false;
  },

  // The occupancy predicate capacity/isolation should use: a lane holds a slot
  // while its state is live OR its process is still alive.
  laneOccupiesSlot(lane) {
    if (!lane) return false;
    return isLiveLaneState(lane.state) || this.isLaneProcessLive(lane.id);
  },

  getRunningCountForSession(sessionId) {
    let count = 0;
    for (const executor of Object.values(this.executors)) {
      count += executor.getRunningCountForSession(sessionId);
    }
    for (const executor of this.unknownExecutorAdapters.values()) {
      count += executor.getRunningCountForSession(sessionId);
    }
    return count;
  },

  // Kill every live executor child across all adapters. Called on server shutdown
  // (and signal) so detached CLI process groups aren't orphaned to launchd/init.
  async stopAllExecutors(reason = 'server shutdown') {
    const adapters = [...Object.values(this.executors), ...this.unknownExecutorAdapters.values()];
    const pending = [];
    for (const adapter of adapters) {
      const laneIds = typeof adapter.getActiveLaneIds === 'function' ? adapter.getActiveLaneIds() : [];
      for (const laneId of laneIds) {
        pending.push(Promise.resolve(adapter.stop(laneId, { actor: 'shutdown', reason })).catch(() => {}));
      }
    }
    await Promise.allSettled(pending);
  },

  async tickExecutors() {
    for (const executor of Object.values(this.executors)) {
      await executor.tick();
    }
    for (const executor of this.unknownExecutorAdapters.values()) {
      await executor.tick();
    }
  },

  async startScheduler() {
    if (this._schedulerRunning) return;
    this._schedulerRunning = true;
    this._starting = false;
    if (this.stateLoadStatus?.recovered || this.stateLoadStatus?.ok === false) {
      this.persistState();
    }
    // Capture the loop promise so shutdown/drain can AWAIT the in-flight tick.
    // Without this, stopScheduler() only flips the flag; a tick already inside
    // advanceLanes() runs to completion untracked and can schedule a persist/
    // artifact write AFTER drainPendingWrites() has emptied — that fs op is then
    // still in flight when the (unref'd-sleep) loop lets the process exit, which
    // trips node's execution_async_id()==0 assertion abort under teardown load.
    this._schedulerLoopDone = (async () => {
      while (this._schedulerRunning) {
        await this._schedulerSleep(this.heartbeatIntervalMs);
        if (!this._schedulerRunning) break;
        await this.advanceLanes();
      }
    })();
  },

  // Interruptible unref'd sleep for the scheduler heartbeat. unref() so the
  // heartbeat never by itself keeps the Node process alive — a listening HTTP
  // server (the real entrypoint) is what should; without it, merely importing
  // server.js would spin a timer chain that leaks a zombie node process on every
  // load-check. The stored _wakeScheduler lets stopScheduler() end the current
  // sleep immediately, so the loop exits now instead of after a full heartbeat.
  _schedulerSleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._wakeScheduler = null; resolve(); }, ms);
      if (typeof timer?.unref === 'function') timer.unref();
      this._wakeScheduler = () => {
        clearTimeout(timer);
        this._wakeScheduler = null;
        resolve();
      };
    });
  },

  stopScheduler() {
    this._schedulerRunning = false;
    // Wake the current heartbeat sleep so the loop checks the flag and exits now.
    this._wakeScheduler?.();
    if (this._persistTimer) {
      // Flush a final persist so drainPendingWrites can await it. forceBackup:
      // the per-persist `.bak` copy is throttled during normal running, so on
      // shutdown force a fresh backup to guarantee the on-disk `.bak` matches
      // the final state for crash recovery.
      this._flushPersistTimer({ forceBackup: true });
    }
  },

  _trackAsync(promise) {
    if (!promise || typeof promise.then !== 'function') return promise;
    this._pendingWrites.add(promise);
    const cleanup = () => this._pendingWrites.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  },

  async drainPendingWrites() {
    if (!this._pendingWrites) return;
    // FIRST stop the scheduler loop and await its in-flight tick, so no late
    // advanceLanes() can schedule a NEW persist/artifact write after the drain
    // below empties. An escaped write is still in flight when the unref'd-sleep
    // loop lets the process exit → node's execution_async_id()==0 assertion
    // abort (the "AfterMkdirp"/teardown crash). Idempotent — safe if already stopped.
    this._schedulerRunning = false;
    this._wakeScheduler?.();
    if (this._schedulerLoopDone) {
      try { await this._schedulerLoopDone; } catch { /* loop errors are non-fatal at teardown */ }
      this._schedulerLoopDone = null;
    }
    // A pending debounce timer holds an untracked write; force it into
    // _pendingWrites first so its in-flight fs.mkdir can't escape the drain
    // and resolve during process teardown (the AfterMkdirp crash).
    while (this._persistTimer || this._pendingWrites.size > 0) {
      if (this._persistTimer && typeof this._flushPersistTimer === 'function') {
        this._flushPersistTimer();
      }
      if (this._pendingWrites.size > 0) {
        await Promise.allSettled([...this._pendingWrites]);
      }
      await Promise.resolve();
    }
  },

  async advanceLanes() {
    await this.tickExecutors();

    // Launch queued lanes per v2 orchestrator container (the orchestrator record
    // IS the container; there are no session records). Capacity lives on the record.
    for (const orchestrator of (this.orchestrators || [])) {
      const containerId = orchestrator.id;
      const sessionLanes = this.lanes.filter((lane) => lane.sessionId === containerId);
      const queued = sessionLanes
        .filter((lane) => lane.state === QUEUED_STATE)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      // Measure live capacity by LANE STATE (running/starting): authoritative.
      // getRunningCountForSession (executor-reported active runtimes) could
      // undercount a RUNNING lane and let the start loop exceed approvedCapacity.
      const runningCount = sessionLanes.filter((lane) => isRunningLaneState(lane.state)).length;
      const approvedCapacity = normalizeApprovedCapacity(orchestrator.approvedCapacity, normalizeApprovedCapacity(orchestrator.laneConcurrencyLimit, 4));
      const capacityLimit = normalizeSpawnPolicy(orchestrator.spawnPolicy, 'auto') === 'never' ? 0 : approvedCapacity;
      let availableSlots = Math.max(0, capacityLimit - runningCount);

      // Walk the queued list consuming a slot per actually-started lane, so a lane
      // that is no longer queued (raced to another state) is skipped without
      // burning a free slot.
      for (const lane of queued) {
        if (availableSlots <= 0) break;
        if (lane.state !== QUEUED_STATE) continue;
        availableSlots -= 1;
        const now = nowIso();
        lane.state = STARTING_STATE;
        lane.updatedAt = now;
        lane.startedAt = now;
        lane.completedAt = null;
        lane.exitReason = null;
        lane.heartbeatAt = now;
        const laneAgentRole = String(lane.owner || '') === 'orchestrator' ? 'orchestrator' : 'executor';
        this.appendLaneLog(lane, `Lane started by scheduler using ${lane.executorType} ${laneAgentRole}`, { persist: false });
        this.appendLaneAgentEvent(lane, {
          type: 'agent.started',
          source: lane.executorType,
          title: 'Agent process started',
          content: `Started ${lane.executorType} ${laneAgentRole}.`,
        });

        this.recordAudit({
          type: 'lane_started',
          actor: 'scheduler',
          projectId: lane.projectId,
          sessionId: containerId,
          laneId: lane.id,
          summary: `Lane ${lane.title} started`,
          evidence: { lane },
          status: 'passed',
        });

        this.ensureLaneToolLease(lane);
        const executor = this.getExecutorForLane(lane);
        try {
          const workerResult = await executor.start(lane);
          if (workerResult && workerResult.accepted) {
            lane.state = RUNNING_STATE;
            this.setLaneExecutor(lane.id, executor);
          } else {
            await this.markLaneFailed(lane, workerResult?.reason || 'Failed to launch worker', 'scheduler', false);
          }
        } catch (error) {
          await this.markLaneFailed(lane, error?.message || 'Unhandled scheduler error', 'scheduler', false);
        }
        this.persistState();
      }
    }

    // Autonomously run audits for lanes whose work is queued for review.
    if (typeof this.dispatchPendingAudits === 'function') {
      await this.dispatchPendingAudits().catch(() => {});
    }

    // Reap running lanes that have gone idle past their idle-shutdown window.
    await this.reapIdleLanes();

    // Bound in-memory growth (terminal lanes/tasks) periodically — ~every 30 ticks
    // (≈1 min at the default heartbeat). Cheap no-op until records grow large.
    this._tickCount = (this._tickCount || 0) + 1;
    if (this._tickCount % 30 === 0 && typeof this.pruneInMemoryRecords === 'function') {
      try { this.pruneInMemoryRecords(); } catch { /* best effort */ }
    }
  },

  // Stop RUNNING lanes that have produced no activity (output/heartbeat/state
  // change) for longer than laneIdleTimeoutMs. A lane can opt out entirely with
  // idleShutdown:false (never auto-reap; left to the orchestrator/human) — the old
  // three-way immediate/short_keepalive/policy knob was a dial nobody turned.
  // Disabled entirely when laneIdleTimeoutMs <= 0. Distinct from the adapter
  // heartbeat-timeout, which reaps a dead/hung PROCESS quickly; this reaps a lane
  // that is alive but idle.
  async reapIdleLanes(now = Date.now()) {
    const baseMs = this.laneIdleTimeoutMs;
    if (!Number.isFinite(baseMs) || baseMs <= 0) return;
    for (const lane of (this.lanes || [])) {
      if (!isRunningLaneState(lane.state)) continue;
      if (lane.idleShutdown === false) continue;
      const lastActivity = Date.parse(lane.lastActivityAt || lane.startedAt || lane.updatedAt || lane.createdAt) || 0;
      if (!lastActivity || (now - lastActivity) <= baseMs) continue;
      this.appendLaneLog?.(lane, `Idle shutdown: no activity for ${Math.round((now - lastActivity) / 1000)}s`, { persist: false });
      try {
        await this.stopLane(lane.id, { actor: 'idle-shutdown', approved: true });
      } catch { /* best effort — a racing state change is fine */ }
    }
  },
};
