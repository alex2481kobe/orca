// Executor-adapter management + the scheduler run loop (lane lifecycle engine)
// as a prototype mixin for OrcaRegistry. Extracted from registry.js.

import fs from 'node:fs/promises';
import { LANE_STATES } from './worker-contract.js';
import { nowIso } from './registry-utils.js';
import { createExecutorAdapter } from './executor-factory.js';
import { normalizeApprovedCapacity, normalizeSpawnPolicy } from './registry-lane-config.js';
import { writeJsonFileAtomic } from './state-store.js';

// The scheduler heartbeat must NOT, by itself, keep the Node process alive — a
// listening HTTP server (the real entrypoint) is what should. Without unref(),
// merely importing server.js (which constructs the registry and starts this
// loop) spins a setTimeout chain that never lets the process exit — leaking a
// zombie node process on every module load-check. unref() lets the process exit
// when nothing else (no open socket) is holding the event loop.
function schedulerSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
}

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
      onLog: (lane, message) => this.appendLaneLog(lane, message, { persist: false }),
      onAgentEvent: (lane, agentEvent) => this.appendLaneAgentEvent(lane, agentEvent, { persist: false }),
      onComplete: async (lane) => this.markLaneCompleted(lane),
      onFail: async (lane, reason) => this.markLaneFailed(lane, reason, 'scheduler'),
      onStop: async (lane, context) => this.markLaneStopped(lane, context),
      credentialStore: this.credentialStore,
      providerProfileStore: this.providerProfileStore,
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
    while (this._schedulerRunning) {
      await schedulerSleep(this.heartbeatIntervalMs);
      await this.advanceLanes();
    }
  },

  stopScheduler() {
    this._schedulerRunning = false;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
      // Flush a final persist synchronously so drainPendingWrites can await it.
      const write = (async () => {
        try {
          await fs.mkdir(this.storageDir, { recursive: true });
          await writeJsonFileAtomic(this.stateFile, this.snapshotState());
        } catch {
          // Stop is best-effort; ignore persist failures during teardown.
        }
      })();
      this._trackAsync(write);
    }
  },

  _trackAsync(promise) {
    if (!promise || typeof promise.then !== 'function') return promise;
    this._pendingWrites.add(promise);
    promise.finally(() => this._pendingWrites.delete(promise));
    return promise;
  },

  async drainPendingWrites() {
    if (!this._pendingWrites || this._pendingWrites.size === 0) return;
    await Promise.allSettled([...this._pendingWrites]);
  },

  async advanceLanes() {
    await this.tickExecutors();
    await this.runCleanupSchedulerTick().catch(() => {});

    const sessionById = new Map(this.sessions.map((session) => [session.id, session]));

    for (const session of sessionById.values()) {
      const sessionLanes = this.lanes.filter((lane) => lane.sessionId === session.id);
      const queued = sessionLanes
        .filter((lane) => lane.state === QUEUED_STATE)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const runningCount = this.getRunningCountForSession(session.id);
      const approvedCapacity = normalizeApprovedCapacity(session.approvedCapacity, normalizeApprovedCapacity(session.laneConcurrencyLimit));
      const capacityLimit = normalizeSpawnPolicy(session.spawnPolicy) === 'never' ? 0 : approvedCapacity;
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
        this.appendLaneLog(lane, `Lane started by scheduler using ${lane.executorType} executor`, { persist: false });
        this.appendLaneAgentEvent(lane, {
          type: 'agent.started',
          source: lane.executorType,
          title: 'Agent process started',
          content: `Started ${lane.executorType} executor.`,
        });

        this.recordAudit({
          type: 'lane_started',
          actor: 'scheduler',
          projectId: lane.projectId,
          sessionId: session.id,
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
  },
};
