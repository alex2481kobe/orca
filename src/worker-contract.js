const nowIso = () => new Date().toISOString();

const noopAsync = async () => {};

export const LANE_STATES = {
  QUEUED: 'queued',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPED: 'stopped',
  DONE: 'done',
  FAILED: 'failed',
};

export class MockWorkerAdapter {
  constructor({
    heartbeatTimeoutMs = 15000,
    defaultAutoCompleteMs = 12000,
    onLog = noopAsync,
    onComplete = noopAsync,
    onFail = noopAsync,
    onStop = noopAsync,
  } = {}) {
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.defaultAutoCompleteMs = defaultAutoCompleteMs;
    this.onLog = onLog;
    this.onComplete = onComplete;
    this.onFail = onFail;
    this.onStop = onStop;
    this.runtimes = new Map();
  }

  async start(lane) {
    if (!lane || !lane.id) {
      return { accepted: false, reason: 'Missing lane reference.' };
    }

    const existing = this.runtimes.get(lane.id);
    if (existing && existing.status === 'active') {
      return { accepted: false, reason: 'Lane already active.' };
    }

    const autoCompleteMs = Number.parseInt(lane.runProfile?.autoCompleteMs, 10) || this.defaultAutoCompleteMs;
    const runtime = {
      lane,
      status: 'active',
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      autoCompleteMs,
      completeAt: Date.now() + autoCompleteMs,
    };

    runtime.timer = setTimeout(() => {
      this._markCompleted(lane.id).catch(() => {});
    }, autoCompleteMs);
    runtime.timer.unref?.();

    this.runtimes.set(lane.id, runtime);
    await this.onLog(lane, `Mock worker started with ${autoCompleteMs}ms runtime target.`);
    return { accepted: true, runtime };
  }

  async stop(laneId, context = {}) {
    const runtime = this.runtimes.get(String(laneId));
    if (!runtime || runtime.status !== 'active') {
      return { stopped: false, reason: 'Lane is not actively running.' };
    }

    runtime.status = 'stopping';
    clearTimeout(runtime.timer);
    this.runtimes.delete(runtime.lane.id);
    await this.onStop(runtime.lane, {
      actor: context.actor || 'dashboard',
      reason: context.reason || 'Stopped by controller',
    });
    await this.onLog(runtime.lane, `Mock worker stopped by ${context.actor || 'controller'}.`);
    return { stopped: true, runtime };
  }

  touchHeartbeat(laneId, actor = 'mock-worker') {
    const runtime = this.runtimes.get(String(laneId));
    if (!runtime || runtime.status !== 'active') {
      return false;
    }
    runtime.heartbeatAt = Date.now();
    this.onLog(runtime.lane, `Heartbeat from worker (${actor})`).catch(() => {});
    return true;
  }

  async tick(now = Date.now()) {
    for (const runtime of this.runtimes.values()) {
      if (runtime.status !== 'active') continue;
      const staleMs = now - runtime.heartbeatAt;
      if (staleMs > this.heartbeatTimeoutMs) {
        runtime.status = 'timed_out';
        clearTimeout(runtime.timer);
        this.runtimes.delete(runtime.lane.id);
        await this.onFail(runtime.lane, 'Missed heartbeat window', 'heartbeat');
      }
    }
  }

  async _markCompleted(laneId) {
    const runtime = this.runtimes.get(String(laneId));
    if (!runtime || runtime.status !== 'active') {
      return { done: false, reason: 'No active runtime.' };
    }
    runtime.status = 'done';
    this.runtimes.delete(runtime.lane.id);
    await this.onComplete(runtime.lane);
    return { done: true };
  }

  getRunningCountForSession(sessionId) {
    const want = String(sessionId);
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.status === 'active' && String(runtime.lane.sessionId) === want) {
        count += 1;
      }
    }
    return count;
  }

  getActiveLaneIds() {
    return Array.from(this.runtimes.values())
      .filter((runtime) => runtime.status === 'active')
      .map((runtime) => runtime.lane.id);
  }
}
