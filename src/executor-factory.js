import { MockWorkerAdapter } from './worker-contract.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

const noopAsync = async () => {};

function normalizeArgs(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((value) => String(value || '').trim());
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    return text
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

class CliExecutorAdapter {
  constructor(label, options = {}) {
    this.label = label;
    this.onLog = options.onLog || noopAsync;
    this.onComplete = options.onComplete || noopAsync;
    this.onFail = options.onFail || noopAsync;
    this.onStop = options.onStop || noopAsync;
    this.runtimes = new Map();
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs || 15000;
    this.defaultBinary = options.defaultBinary || options.binary || label;
    this.defaultArgs = Array.isArray(options.defaultArgs) ? options.defaultArgs : [];
    this.defaultWorkingDir = options.workingDir || process.cwd();
  }

  async start(lane) {
    if (!lane || !lane.id) {
      return {
        accepted: false,
        reason: 'Missing lane reference.',
      };
    }

    const commandInput = (lane.command || '').trim();
    const explicitBinary = String(lane.executorBinary || '').trim();
    const explicitArgs = normalizeArgs(lane.commandArgs);
    const laneArgs = normalizeArgs(lane.args);
    const commandArgs = laneArgs.length ? laneArgs : explicitArgs;

    let command = explicitBinary || this.defaultBinary;
    let args = [];
    let useShell = false;

    if (commandInput) {
      command = commandInput;
      useShell = true;
    } else if (Array.isArray(commandArgs) && commandArgs.length) {
      args = commandArgs;
    } else if (this.defaultArgs.length) {
      args = [...this.defaultArgs];
    }

    if (!command) {
      return {
        accepted: false,
        reason: `${this.label} executor requires an explicit command or binary.`,
      };
    }

    const runtimeId = randomUUID();
    const laneId = String(lane.id);
    const runtimeDir = path.join(process.cwd(), 'artifacts', lane.sessionId || 'orphan', lane.id);
    const runtime = {
      runtimeId,
      lane,
      status: 'active',
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      command,
      args,
      useShell,
      process: null,
    };

    try {
      await fs.mkdir(runtimeDir, { recursive: true });
      const child = spawn(command, useShell ? [] : args, {
        shell: useShell,
        cwd: lane.workdir || this.defaultWorkingDir,
        env: {
          ...process.env,
          COMMAND_DECK_LANE_ID: laneId,
          COMMAND_DECK_SESSION_ID: String(lane.sessionId || ''),
          COMMAND_DECK_PROJECT_ID: String(lane.projectId || ''),
          COMMAND_DECK_ARTIFACT_DIR: runtimeDir,
        },
      });
      runtime.process = child;
    } catch (error) {
      return {
        accepted: false,
        reason: `Failed to launch ${this.label} adapter: ${error.message}`,
      };
    }

    this.runtimes.set(laneId, runtime);

    const { process: childProcess } = runtime;
    childProcess.stdout?.setEncoding('utf8');
    childProcess.stderr?.setEncoding('utf8');
    childProcess.stdout?.on('data', (chunk) => {
      this.onLog(lane, `[${this.label}] ${String(chunk).trim()}`).catch(() => {});
    });
    childProcess.stderr?.on('data', (chunk) => {
      this.onLog(lane, `[${this.label} err] ${String(chunk).trim()}`).catch(() => {});
    });

    childProcess.on('error', (error) => {
      if (runtime.status !== 'active') return;
      runtime.status = 'failed';
      this.runtimes.delete(laneId);
      this.onFail(lane, `Executor process failed to launch: ${error.message}`, 'scheduler').catch(() => {});
    });

    childProcess.on('exit', (code, signal) => {
      if (runtime.status !== 'active') return;
      runtime.status = code === 0 ? 'done' : 'failed';
      this.runtimes.delete(laneId);
      if (runtime.status === 'done') {
        this.onComplete(lane, `${this.label} exited with code ${code}`).catch(() => {});
        return;
      }
      if (signal) {
        this.onFail(lane, `${this.label} terminated by ${signal}`, 'scheduler').catch(() => {});
      } else {
        this.onFail(lane, `${this.label} exited with status ${code}`, 'scheduler').catch(() => {});
      }
    });

    await this.onLog(lane, `${this.label} adapter started (runtime ${runtimeId})`);
    return { accepted: true, runtime };
  }

  async stop(laneId, context = {}) {
    const laneKey = String(laneId);
    const runtime = this.runtimes.get(laneKey);
    if (!runtime || !runtime.process) {
      return {
        stopped: false,
        reason: `No active runtime found for lane ${laneKey}.`,
      };
    }

    runtime.status = 'stopping';
    runtime.process.removeAllListeners('exit');
    const proc = runtime.process;
    this.runtimes.delete(laneKey);

    const killed = proc.kill('SIGTERM');
    await this.onStop(runtime.lane, {
      actor: context.actor || 'dashboard',
      reason: context.reason || `${this.label} adapter stop requested`,
    });
    await this.onLog(runtime.lane, `${this.label} adapter stopped (${killed ? 'killed' : 'already exited'}).`);

    return {
      stopped: true,
      reason: killed ? 'Stop signal sent.' : 'No running process to stop.',
    };
  }

  touchHeartbeat(laneId, actor = 'adapter') {
    const runtime = this.runtimes.get(String(laneId));
    if (!runtime || runtime.status !== 'active') {
      return false;
    }
    runtime.heartbeatAt = Date.now();
    this.onLog(runtime.lane, `[${this.label}] heartbeat from ${actor}`).catch(() => {});
    return true;
  }

  async tick(now = Date.now()) {
    for (const [laneId, runtime] of this.runtimes.entries()) {
      if (runtime.status !== 'active' || !runtime.process) continue;
      const staleMs = now - runtime.heartbeatAt;
      if (staleMs > this.heartbeatTimeoutMs) {
        runtime.status = 'timed_out';
        runtime.process.kill('SIGKILL');
        this.runtimes.delete(laneId);
        await this.onFail(runtime.lane, `${this.label} adapter heartbeat timeout`, 'heartbeat');
      }
    }
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
}

class PendingExecutorAdapter {
  constructor(label, callbacks = {}) {
    this.label = label;
    this.onLog = callbacks.onLog || noopAsync;
    this.onComplete = callbacks.onComplete || noopAsync;
    this.onFail = callbacks.onFail || noopAsync;
    this.onStop = callbacks.onStop || noopAsync;
    this.runtimes = new Map();
  }

  async start(lane) {
    await this.onLog(lane, `${this.label} executor is not implemented in checkpoint 3 yet.`);
    return {
      accepted: false,
      reason: `${this.label} executor requires implementation in a future checkpoint.`,
    };
  }

  async stop(laneId, context = {}) {
    this.runtimes.delete(String(laneId));
    return {
      stopped: false,
      reason: `Executor ${this.label} does not support active runtime stop in this checkpoint.`,
    };
  }

  touchHeartbeat() {
    return false;
  }

  async tick() {}

  getRunningCountForSession() {
    return 0;
  }
}

export function createExecutorAdapter(type, callbacks = {}) {
  const executorType = String(type || 'mock').toLowerCase();
  if (executorType === 'mock') {
    return new MockWorkerAdapter(callbacks);
  }
  if (executorType === 'codex' || executorType === 'claude') {
    const options = {
      ...callbacks,
      defaultBinary: executorType,
      heartbeatTimeoutMs: callbacks.heartbeatTimeoutMs || 15000,
    };
    return new CliExecutorAdapter(executorType, options);
  }
  return new PendingExecutorAdapter(executorType, callbacks);
}
