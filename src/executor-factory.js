import { MockWorkerAdapter } from './worker-contract.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

const noopAsync = async () => {};

const DEFAULT_ENV_WHITELIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'USERNAME',
  'SHELL',
  'TERM',
];

const MAX_ARGS = 256;
const MAX_WORKDIR_BYTES = 2048;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function normalizeArgs(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .slice(0, MAX_ARGS);
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    return splitShellTokens(text).filter(Boolean).slice(0, MAX_ARGS);
  }
  return [];
}

function splitShellTokens(raw) {
  const input = String(raw || '').trim();
  if (!input) return [];

  const out = [];
  let token = '';
  let quote = null;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (escape) {
      token += char;
      escape = false;
      continue;
    }

    if (char === '\\') {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      token += char;
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (token) {
        out.push(token);
        token = '';
      }
      continue;
    }

    token += char;
  }

  if (quote) {
    throw new Error('Unclosed quote in command string.');
  }

  if (escape) {
    token += '\\';
  }

  if (token) {
    out.push(token);
  }
  return out;
}

function sanitizeCommandComponent(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${label} must not be empty.`);
  }
  if (text.length > 255) {
    throw new Error(`${label} is too long.`);
  }
  if (CONTROL_CHAR_RE.test(text)) {
    throw new Error(`${label} contains control characters.`);
  }
  return text;
}

function sanitizeArgument(value, index) {
  const text = sanitizeCommandComponent(value, `Argument #${index}`);
  return text;
}

function sanitizeBinary(value) {
  const text = sanitizeCommandComponent(value, 'Binary');
  if (/[|&;<>$`()]/.test(text)) {
    throw new Error('Binary contains blocked characters.');
  }
  return text;
}

function normalizeAllowedBinaries(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    try {
      const normalized = sanitizeBinary(raw);
      const lower = normalized.toLowerCase();
      if (!out.includes(lower)) out.push(lower);
    } catch {
      continue;
    }
  }
  return out;
}

function parseEnv(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const output = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    if (CONTROL_CHAR_RE.test(key) || CONTROL_CHAR_RE.test(String(value))) continue;
    output[key.trim()] = String(value);
  }
  return output;
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
    this.defaultArgs = normalizeArgs(options.defaultArgs);
    this.defaultWorkingDir = options.workingDir || process.cwd();
    this.allowedBinaries = normalizeAllowedBinaries([this.defaultBinary, ...(options.allowedBinaries || [])]);
    this.enforceAllowedBinary = options.enforceAllowedBinary !== false;
    this.maxCommandArgs = Number.parseInt(options.maxCommandArgs, 10) || MAX_ARGS;

    const rawRoots = Array.isArray(options.workdirRoots) && options.workdirRoots.length
      ? options.workdirRoots
      : [this.defaultWorkingDir];
    this.workdirRoots = rawRoots
      .map((value) => path.resolve(String(value || '').trim()))
      .filter(Boolean);
    this.envWhitelist = Array.isArray(options.envWhitelist) && options.envWhitelist.length
      ? options.envWhitelist
      : DEFAULT_ENV_WHITELIST;
    this.envAllowlist = new Set(this.envWhitelist.map((value) => String(value).trim()).filter(Boolean));
  }

  _resolveBinary(rawBinary) {
    const binary = sanitizeBinary(rawBinary);
    const normalizedBinary = binary.toLowerCase();
    const basename = path.basename(binary).toLowerCase();

    if (this.enforceAllowedBinary) {
      const allowed = this.allowedBinaries;
      const ok = allowed.includes(normalizedBinary) || allowed.includes(basename);
      if (!ok) {
        throw new Error(`Binary ${binary} is not in the approved allowlist for ${this.label}.`);
      }
    }

    if (path.isAbsolute(binary)) {
      if (!basename) {
        throw new Error('Binary path is invalid.');
      }
      return binary;
    }

    return binary;
  }

  async _resolveWorkdir(rawWorkdir) {
    const workdir = sanitizeCommandComponent(String(rawWorkdir || this.defaultWorkingDir || process.cwd()), 'Workdir');
    if (workdir.length > MAX_WORKDIR_BYTES) {
      throw new Error('Workdir path is too long.');
    }

    const resolved = path.isAbsolute(workdir) ? path.resolve(workdir) : path.resolve(this.defaultWorkingDir, workdir);
    const within = this.workdirRoots.some((root) => {
      const normalizedRoot = path.resolve(root);
      const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
      return resolved === normalizedRoot || resolved.startsWith(withSep);
    });

    if (!within) {
      throw new Error('Workdir is outside allowed execution roots.');
    }

    try {
      const stats = await fs.stat(resolved);
      if (!stats.isDirectory()) {
        throw new Error();
      }
    } catch {
      throw new Error('Workdir is not an existing directory.');
    }

    return resolved;
  }

  _buildEnv(lane) {
    const baseEnv = {};
    for (const key of this.envAllowlist) {
      if (typeof process.env[key] === 'string') {
        baseEnv[key] = process.env[key];
      }
    }

    baseEnv.COMMAND_DECK_LANE_ID = String(lane.id);
    baseEnv.COMMAND_DECK_SESSION_ID = String(lane.sessionId || '');
    baseEnv.COMMAND_DECK_PROJECT_ID = String(lane.projectId || '');
    baseEnv.COMMAND_DECK_ARTIFACT_DIR = lane.artifactPath || '';
    if (lane.mcpConfigPath) {
      baseEnv.COMMAND_DECK_MCP_CONFIG = lane.mcpConfigPath;
    }

    const laneEnv = parseEnv(lane.env);
    for (const [key, value] of Object.entries(laneEnv)) {
      if (this.envAllowlist.has(key) || String(key).startsWith('COMMAND_DECK_')) {
        baseEnv[key] = value;
      }
    }
    return baseEnv;
  }

  async _buildMcpConfig(runtimeDir, lane) {
    if (!Array.isArray(lane.mcpTools) || !lane.mcpTools.length) {
      return null;
    }
    const config = {
      createdAt: new Date().toISOString(),
      laneId: lane.id,
      executorType: this.label,
      tools: lane.mcpTools,
    };
    const configPath = path.join(runtimeDir, 'mcp-tools.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  _normalizeArgList(rawArgs) {
    const normalized = normalizeArgs(rawArgs).slice(0, this.maxCommandArgs);
    return normalized.map((value, index) => sanitizeArgument(value, index));
  }

  async start(lane) {
    if (!lane || !lane.id) {
      return {
        accepted: false,
        reason: 'Missing lane reference.',
      };
    }

    let binary = String(this.defaultBinary || '').trim();
    let args = [];

    const commandInput = String(lane.command || '').trim();
    const explicitBinary = String(lane.executorBinary || '').trim();
    const laneArgs = this._normalizeArgList(lane.args);
    const explicitArgs = this._normalizeArgList(lane.commandArgs);

    if (commandInput) {
      try {
        const commandTokens = splitShellTokens(commandInput);
        if (!commandTokens.length) {
          throw new Error('command string was empty after parsing.');
        }
        binary = commandTokens[0];
        args = commandTokens.slice(1).map((value, index) => sanitizeArgument(value, index));
      } catch (error) {
        return {
          accepted: false,
          reason: `Invalid command string: ${error.message}`,
        };
      }
    } else if (explicitBinary) {
      binary = explicitBinary;
    }

    if (Array.isArray(laneArgs) && laneArgs.length) {
      args = laneArgs;
    } else if (Array.isArray(explicitArgs) && explicitArgs.length) {
      args = explicitArgs;
    } else if (this.defaultArgs.length) {
      args = [...this.defaultArgs];
    }

    try {
      const safeBinary = this._resolveBinary(binary);
      const runtimeDir = path.join(process.cwd(), 'artifacts', String(lane.sessionId || 'orphan'), String(lane.id));
      const runtime = {
        runtimeId: randomUUID(),
        lane,
        status: 'active',
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
        binary: safeBinary,
        args,
        process: null,
      };
      await fs.mkdir(runtimeDir, { recursive: true });
      lane.artifactPath = `/artifacts/${lane.sessionId || 'orphan'}/${lane.id}`;
      lane.mcpConfigPath = await this._buildMcpConfig(runtimeDir, lane);
      const safeWorkdir = await this._resolveWorkdir(lane.workdir || this.defaultWorkingDir);

      const child = spawn(safeBinary, args, {
        shell: false,
        cwd: safeWorkdir,
        env: this._buildEnv(lane),
      });
      runtime.process = child;
      this.runtimes.set(String(lane.id), runtime);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        this.onLog(lane, `[${this.label}] ${String(chunk).trim()}`).catch(() => {});
      });
      child.stderr?.on('data', (chunk) => {
        this.onLog(lane, `[${this.label} err] ${String(chunk).trim()}`).catch(() => {});
      });

      child.on('error', (error) => {
        if (runtime.status !== 'active') return;
        runtime.status = 'failed';
        this.runtimes.delete(String(lane.id));
        this.onFail(lane, `Executor process failed to launch: ${error.message}`, 'scheduler').catch(() => {});
      });

      child.on('exit', (code, signal) => {
        if (runtime.status !== 'active') return;
        runtime.status = code === 0 ? 'done' : 'failed';
        this.runtimes.delete(String(lane.id));
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

      await this.onLog(lane, `${this.label} adapter started (runtime ${runtime.runtimeId})`);
      if (lane.mcpConfigPath) {
        await this.onLog(lane, `${this.label} lane MCP config loaded at ${lane.mcpConfigPath}`);
      }
      return { accepted: true, runtime };
    } catch (error) {
      return {
        accepted: false,
        reason: `Failed to launch ${this.label} adapter: ${error.message}`,
      };
    }
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

function parseEnvList(rawValue, fallback = []) {
  if (!rawValue) return fallback;
  if (Array.isArray(rawValue)) return rawValue;
  if (typeof rawValue !== 'string') return fallback;

  return rawValue
    .split(/[\s,]+/)
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function getExecutorProfile(type, callbacks = {}) {
  const executorType = String(type || '').toLowerCase();
  if (!['codex', 'claude'].includes(executorType)) {
    return null;
  }
  const upper = executorType.toUpperCase();
  const binary = process.env[`COMMAND_DECK_${upper}_BINARY`] || executorType;
  const allowedBinaries = parseEnvList(process.env[`COMMAND_DECK_${upper}_ALLOWED_BINARIES`], [binary]);
  const defaultArgs = parseEnvList(process.env[`COMMAND_DECK_${upper}_DEFAULT_ARGS`], []);
  const workdirRoots = parseEnvList(process.env[`COMMAND_DECK_${upper}_WORKDIR_ROOTS`], [process.cwd()]);
  const defaultWorkingDir = callbacks.defaultWorkingDir || process.cwd();

  return {
    type: executorType,
    defaultBinary: binary,
    allowedBinaries,
    defaultArgs,
    defaultWorkingDir,
    workdirRoots,
    envWhitelist: parseEnvList(process.env[`COMMAND_DECK_${upper}_ENV_WHITELIST`], undefined),
  };
}

export function getExecutorProfiles() {
  return ['codex', 'claude'].reduce((accum, executorType) => {
    const profile = getExecutorProfile(executorType);
    if (profile) accum[executorType] = profile;
    return accum;
  }, {});
}

export function createExecutorAdapter(type, callbacks = {}) {
  const executorType = String(type || 'mock').toLowerCase();
  if (executorType === 'mock') {
    return new MockWorkerAdapter(callbacks);
  }

  if (executorType === 'codex' || executorType === 'claude') {
    const profile = getExecutorProfile(executorType, callbacks);
    if (!profile) {
      return new PendingExecutorAdapter(executorType, callbacks);
    }

    const options = {
      ...callbacks,
      defaultBinary: profile.defaultBinary,
      heartbeatTimeoutMs: callbacks.heartbeatTimeoutMs || 15000,
      allowedBinaries: profile.allowedBinaries,
      envWhitelist: profile.envWhitelist || callbacks.envWhitelist,
      enforceAllowedBinary: true,
      workdirRoots: profile.workdirRoots,
      maxCommandArgs: 128,
      defaultArgs: profile.defaultArgs.length ? profile.defaultArgs : (callbacks.defaultArgs || []),
      defaultWorkingDir: callbacks.defaultWorkingDir || process.cwd(),
    };

    return new CliExecutorAdapter(executorType, options);
  }

  if (executorType === 'cli') {
    const options = {
      ...callbacks,
      heartbeatTimeoutMs: callbacks.heartbeatTimeoutMs || 15000,
    };
    return new CliExecutorAdapter(executorType, options);
  }

  return new PendingExecutorAdapter(executorType, callbacks);
}
