import { MockWorkerAdapter } from './worker-contract.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { CredentialStore, defaultProfiles } from './provider-profiles.js';
import { validateNetworkUrl } from './url-policy.js';

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
const API_RESPONSE_BYTES = 256 * 1024;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const API_PROVIDER_TYPES = [
  'api',
  'openai-compatible',
  'gemini',
  'kimi',
  'deepseek',
  'openrouter',
  'composer',
];

function safeFire(callback, ...args) {
  try {
    return Promise.resolve(callback(...args)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

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

function buildExecutorCommandArgs(label, lane) {
  const taskPrompt = String(lane.taskPrompt || '').trim();
  if (!taskPrompt) return [];
  const safePrompt = taskPrompt.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 4096);
  const model = String(lane.model || '').trim().slice(0, 120);
  const permissions = String(lane.permissionsProfile || '').trim().slice(0, 120);
  const targetUrl = String(lane.targetUrl || '').trim().slice(0, 1024);
  const out = [];
  switch (String(label).toLowerCase()) {
    case 'codex': {
      if (model) out.push('--model', model);
      if (permissions) out.push('--permissions', permissions);
      if (lane.mcpConfigPath) out.push('--mcp-config', lane.mcpConfigPath);
      if (targetUrl) out.push('--target', targetUrl);
      out.push('--prompt', safePrompt);
      break;
    }
    case 'claude': {
      if (model) out.push('--model', model);
      if (permissions) out.push('--permission-mode', permissions);
      if (lane.mcpConfigPath) out.push('--mcp-config', lane.mcpConfigPath);
      if (targetUrl) out.push('--print', `Target: ${targetUrl}\n${safePrompt}`);
      else out.push('--print', safePrompt);
      break;
    }
    default:
      out.push(safePrompt);
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

function parsePositiveInteger(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

function providerEnvPrefix(providerId) {
  return String(providerId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isApiProviderType(type) {
  return API_PROVIDER_TYPES.includes(String(type || '').toLowerCase());
}

function redactedText(value, secrets = []) {
  let out = String(value ?? '');
  for (const secret of secrets) {
    const text = String(secret || '');
    if (!text) continue;
    out = out.split(text).join('[REDACTED]');
  }
  return out;
}

function trimForLog(value, max = 4000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function buildOpenAiCompatibleBody(lane, profile) {
  const prompt = String(lane.taskPrompt || lane.taskDescription || lane.title || 'Run Command Deck lane.').trim().slice(0, 8000);
  const model = String(lane.model || profile.defaultModel || process.env[`COMMAND_DECK_${providerEnvPrefix(profile.id)}_MODEL`] || 'command-deck-default').trim();
  return {
    model,
    messages: [
      {
        role: 'system',
        content: 'You are an API provider lane running inside Command Deck. Return concise progress or completion output.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    stream: false,
  };
}

function modelForProfile(lane, profile) {
  return String(lane.model || profile.defaultModel || process.env[`COMMAND_DECK_${providerEnvPrefix(profile.id)}_MODEL`] || 'command-deck-default').trim();
}

function safeGeminiModel(lane, profile) {
  const raw = String(lane.model || profile.defaultModel || process.env[`COMMAND_DECK_${providerEnvPrefix(profile.id)}_MODEL`] || 'gemini-1.5-flash').trim();
  const withoutPrefix = raw.replace(/^models\//, '').trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(withoutPrefix)) {
    throw new Error('Gemini model contains unsupported characters.');
  }
  return withoutPrefix;
}

function buildGeminiBody(lane) {
  const prompt = String(lane.taskPrompt || lane.taskDescription || lane.title || 'Run Command Deck lane.').trim().slice(0, 8000);
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
    },
  };
}

function buildApiRequestBody(lane, profile) {
  if (profile.apiStyle === 'gemini') return buildGeminiBody(lane, profile);
  return buildOpenAiCompatibleBody(lane, profile);
}

function apiEndpointForProfile(profile) {
  const baseUrl = String(profile.baseUrl || '').replace(/\/+$/, '');
  if (profile.apiStyle === 'openai-compatible') return `${baseUrl}/chat/completions`;
  if (profile.apiStyle === 'gemini') return `${baseUrl}/models/${safeGeminiModel({}, profile)}:generateContent`;
  return null;
}

function getApiProviderProfile(type) {
  const requested = String(type || '').toLowerCase().trim();
  const providerId = requested === 'api' ? 'openai-compatible' : requested;
  const seeded = defaultProfiles()[providerId];
  if (!seeded || seeded.kind !== 'api') return null;
  return applyApiProviderEnvOverrides({ ...seeded, type: requested, id: providerId }, requested);
}

function applyApiProviderEnvOverrides(profile, requestedType = profile?.type || profile?.id) {
  if (!profile || profile.kind !== 'api') return null;
  const providerId = profile.id;
  const prefix = providerEnvPrefix(providerId);
  const baseUrl = process.env[`COMMAND_DECK_${prefix}_BASE_URL`] || profile.baseUrl;
  const apiKeyEnv = process.env[`COMMAND_DECK_${prefix}_API_KEY_ENV`] || profile.apiKeyEnv || `COMMAND_DECK_${prefix}_API_KEY`;
  return {
    ...profile,
    type: requestedType,
    id: providerId,
    baseUrl,
    apiKeyEnv,
    timeoutMs: parsePositiveInteger(process.env[`COMMAND_DECK_${prefix}_TIMEOUT_MS`], profile.timeoutMs || 30000, { min: 1000, max: 180000 }),
    maxResponseBytes: parsePositiveInteger(process.env[`COMMAND_DECK_${prefix}_MAX_RESPONSE_BYTES`], API_RESPONSE_BYTES, { min: 1024, max: 2 * 1024 * 1024 }),
    defaultModel: process.env[`COMMAND_DECK_${prefix}_MODEL`] || profile.defaultModel || '',
  };
}

function getApiProviderExecutorTypes() {
  return API_PROVIDER_TYPES.filter((type) => Boolean(getApiProviderProfile(type)));
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
    const label = String(this.label || '').toLowerCase();
    // Codex/Claude both consume a JSON map of servers; preserving the same
    // shape across executors keeps the dashboard simple while still letting
    // the file be loaded with executor-native config flags.
    const servers = {};
    for (const tool of lane.mcpTools) {
      const id = String(tool?.id || tool?.name || '').trim();
      if (!id) continue;
      servers[id] = {
        command: tool.command,
        args: Array.isArray(tool.args) ? tool.args : [],
        env: tool.env && typeof tool.env === 'object' ? tool.env : {},
        scope: Array.isArray(tool.scope) ? tool.scope : [],
        description: tool.description || '',
      };
    }
    const config = {
      createdAt: new Date().toISOString(),
      laneId: lane.id,
      executorType: label,
      tools: lane.mcpTools,
      mcpServers: servers,
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
    } else if (lane.taskPrompt) {
      // Derive a safe, executor-shaped command line from the lane's task prompt
      // so dashboard users do not have to hand-write shell strings.
      args = buildExecutorCommandArgs(this.label, lane);
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
        detached: process.platform !== 'win32',
      });
      runtime.process = child;
      this.runtimes.set(String(lane.id), runtime);
      lane.processMeta = {
        pid: child.pid || null,
        pgid: process.platform === 'win32' ? null : (child.pid || null),
        binary: safeBinary,
        args: [...args],
        cwd: safeWorkdir,
        envPolicy: this.envWhitelist?.length ? 'allowlist' : 'default',
        startedAt: new Date(runtime.startedAt).toISOString(),
        endedAt: null,
        exitCode: null,
        signal: null,
        stopRequestedBy: null,
        stopResult: null,
        platform: process.platform,
        processGroupSupported: process.platform !== 'win32',
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        safeFire(this.onLog, lane, `[${this.label}] ${String(chunk).trim()}`);
      });
      child.stderr?.on('data', (chunk) => {
        safeFire(this.onLog, lane, `[${this.label} err] ${String(chunk).trim()}`);
      });

      child.on('error', (error) => {
        if (runtime.status !== 'active') return;
        runtime.status = 'failed';
        this.runtimes.delete(String(lane.id));
        safeFire(this.onFail, lane, `Executor process failed to launch: ${error.message}`, 'scheduler');
      });

      child.on('exit', (code, signal) => {
        if (lane.processMeta) {
          lane.processMeta.endedAt = new Date().toISOString();
          lane.processMeta.exitCode = code;
          lane.processMeta.signal = signal || null;
        }
        if (runtime.status !== 'active') return;
        runtime.status = code === 0 ? 'done' : 'failed';
        this.runtimes.delete(String(lane.id));
        if (runtime.status === 'done') {
          safeFire(this.onComplete, lane, `${this.label} exited with code ${code}`);
          return;
        }
        if (signal) {
          safeFire(this.onFail, lane, `${this.label} terminated by ${signal}`, 'scheduler');
        } else {
          safeFire(this.onFail, lane, `${this.label} exited with status ${code}`, 'scheduler');
        }
      });

      await safeFire(this.onLog, lane, `${this.label} adapter started (runtime ${runtime.runtimeId})`);
      if (lane.mcpConfigPath) {
        await safeFire(this.onLog, lane, `${this.label} lane MCP config loaded at ${lane.mcpConfigPath}`);
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
    const pid = proc.pid;
    this.runtimes.delete(laneKey);

    const meta = runtime.lane?.processMeta || null;
    const tryKillTree = (signal) => {
      if (!pid) return false;
      if (process.platform === 'win32') {
        try { return proc.kill(signal); } catch { return false; }
      }
      try {
        // Negative PID targets the process group created via detached:true.
        process.kill(-pid, signal);
        return true;
      } catch {
        try { return proc.kill(signal); } catch { return false; }
      }
    };

    const killedTerm = tryKillTree('SIGTERM');
    // Graceful timeout before escalating to SIGKILL.
    const escalateAfterMs = Number.parseInt(process.env.COMMAND_DECK_STOP_ESCALATE_MS || '', 10) || 4000;
    const escalation = new Promise((resolve) => {
      const timer = setTimeout(() => {
        let escalated = false;
        if (proc.exitCode === null) {
          escalated = tryKillTree('SIGKILL');
        }
        resolve(escalated);
      }, escalateAfterMs);
      timer.unref?.();
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    const escalated = await escalation;

    if (meta) {
      meta.endedAt = meta.endedAt || new Date().toISOString();
      meta.stopRequestedBy = context.actor || 'dashboard';
      meta.stopResult = killedTerm
        ? (escalated ? 'escalated_sigkill' : 'sigterm')
        : 'no_active_process';
    }

    await safeFire(this.onStop, runtime.lane, {
      actor: context.actor || 'dashboard',
      reason: context.reason || `${this.label} adapter stop requested`,
    });
    await safeFire(this.onLog, runtime.lane, `${this.label} adapter stopped (${killedTerm ? (escalated ? 'sigkill after timeout' : 'sigterm sent') : 'already exited'}).`);

    return {
      stopped: true,
      reason: killedTerm ? (escalated ? 'Stop escalated to SIGKILL.' : 'Stop signal sent.') : 'No running process to stop.',
      processGroupSupported: process.platform !== 'win32',
    };
  }

  touchHeartbeat(laneId, actor = 'adapter') {
    const runtime = this.runtimes.get(String(laneId));
    if (!runtime || runtime.status !== 'active') {
      return false;
    }
    runtime.heartbeatAt = Date.now();
    safeFire(this.onLog, runtime.lane, `[${this.label}] heartbeat from ${actor}`);
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
        await safeFire(this.onFail, runtime.lane, `${this.label} adapter heartbeat timeout`, 'heartbeat');
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

class ApiExecutorAdapter {
  constructor(label, options = {}) {
    this.label = label;
    this.profile = options.profile || getApiProviderProfile(label);
    this.credentialStore = options.credentialStore || new CredentialStore();
    this.providerProfileStore = options.providerProfileStore || null;
    this.onLog = options.onLog || noopAsync;
    this.onComplete = options.onComplete || noopAsync;
    this.onFail = options.onFail || noopAsync;
    this.onStop = options.onStop || noopAsync;
    this.runtimes = new Map();
  }

  async _resolveProfile() {
    const requested = String(this.label || '').toLowerCase().trim();
    const providerId = requested === 'api' ? 'openai-compatible' : requested;
    const seeded = defaultProfiles()[providerId];
    let profile = this.profile || (seeded ? { ...seeded, id: providerId, type: requested } : null);
    if (this.providerProfileStore && providerId) {
      try {
        const stored = await this.providerProfileStore.getProfile(providerId);
        if (stored?.kind === 'api') {
          profile = { ...(seeded || {}), ...(profile || {}), ...stored, id: providerId, type: requested };
        }
      } catch {
        // Fall back to static/env profile. Missing custom profiles fail below.
      }
    }
    return applyApiProviderEnvOverrides(profile, requested);
  }

  async _credential() {
    const envName = this.profile?.apiKeyEnv;
    const secretRef = this.profile?.secretRef;
    const secret = await this.credentialStore.get(secretRef, envName);
    let description = null;
    try {
      description = await this.credentialStore.describe(secretRef, envName);
    } catch {
      description = null;
    }
    return {
      envName,
      secretRef,
      secret: secret || '',
      backend: description?.backend || this.credentialStore.activeBackend(),
    };
  }

  _validatedEndpoint() {
    if (!this.profile) throw new Error('API provider profile is not configured.');
    const endpoint = this.profile.apiStyle === 'gemini'
      ? `${String(this.profile.baseUrl || '').replace(/\/+$/, '')}/models/${safeGeminiModel(this.currentLane || {}, this.profile)}:generateContent`
      : apiEndpointForProfile(this.profile);
    if (!endpoint) throw new Error('API provider endpoint could not be built.');
    return validateNetworkUrl(endpoint, {
      field: 'providerBaseUrl',
      allowedHosts: ['loopback', 'tailnet', 'public'],
      allowPublic: true,
      allowSensitive: true,
    }).url;
  }

  async start(lane) {
    if (!lane || !lane.id) {
      return {
        accepted: false,
        reason: 'Missing lane reference.',
      };
    }
    try {
      this.profile = await this._resolveProfile();
      this.currentLane = lane;
      const endpoint = this._validatedEndpoint();
      const credential = await this._credential();
      if (!credential.secret) {
        return {
          accepted: false,
          reason: `API provider ${this.profile.id} is missing required credential ${credential.secretRef || 'secretRef'} or env secret ${credential.envName}.`,
        };
      }
      const runtimeDir = path.join(process.cwd(), 'artifacts', String(lane.sessionId || 'orphan'), String(lane.id));
      await fs.mkdir(runtimeDir, { recursive: true });
      lane.artifactPath = `/artifacts/${lane.sessionId || 'orphan'}/${lane.id}`;
      const controller = new AbortController();
      const now = Date.now();
      const runtime = {
        runtimeId: randomUUID(),
        lane,
        status: 'active',
        startedAt: now,
        heartbeatAt: now,
        controller,
        endpoint,
      };
      this.runtimes.set(String(lane.id), runtime);
      lane.processMeta = {
        pid: null,
        pgid: null,
        binary: null,
        args: [],
        cwd: lane.workdir || process.cwd(),
        envPolicy: 'secret-env-ref',
        providerId: this.profile.id,
        providerType: this.label,
        apiStyle: this.profile.apiStyle,
        secretRef: credential.secretRef,
        apiKeyEnv: credential.envName,
        credentialBackend: credential.backend,
        endpointHost: new URL(endpoint).host,
        endpointPath: new URL(endpoint).pathname,
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        exitCode: null,
        signal: null,
        stopRequestedBy: null,
        stopResult: null,
        platform: process.platform,
        processGroupSupported: false,
      };
      await safeFire(this.onLog, lane, `${this.label} API adapter queued request to ${lane.processMeta.endpointHost}${lane.processMeta.endpointPath}`);
      setTimeout(() => {
        this._execute(lane, runtime, credential.secret).catch((error) => {
          if (runtime.status !== 'active') return;
          runtime.status = 'failed';
          this.runtimes.delete(String(lane.id));
          if (lane.processMeta) {
            lane.processMeta.endedAt = new Date().toISOString();
            lane.processMeta.exitCode = 1;
          }
          safeFire(this.onFail, lane, redactedText(error.message || 'API provider execution failed.', [credential.secret]), 'scheduler');
        });
      }, 0).unref?.();
      return { accepted: true, runtime };
    } catch (error) {
      return {
        accepted: false,
        reason: `Failed to launch API provider ${this.label}: ${error.message}`,
      };
    }
  }

  async _execute(lane, runtime, secret) {
    const body = buildApiRequestBody(lane, this.profile);
    const headers = {
      'content-type': 'application/json',
    };
    if (this.profile.apiStyle === 'gemini') {
      headers['x-goog-api-key'] = secret;
    } else {
      headers.authorization = `Bearer ${secret}`;
    }
    const timeout = setTimeout(() => runtime.controller.abort(), this.profile.timeoutMs || 30000);
    let responseText = '';
    try {
      const response = await fetch(runtime.endpoint, {
        method: 'POST',
        signal: runtime.controller.signal,
        headers,
        body: JSON.stringify(body),
      });
      responseText = await response.text();
      if (responseText.length > (this.profile.maxResponseBytes || API_RESPONSE_BYTES)) {
        throw new Error('API provider response exceeded configured size cap.');
      }
      if (runtime.status !== 'active') return;
      if (!response.ok) {
        throw new Error(`API provider returned HTTP ${response.status}: ${trimForLog(redactedText(responseText, [secret]), 1000)}`);
      }
      let parsed = null;
      try {
        parsed = responseText ? JSON.parse(responseText) : null;
      } catch {
        parsed = null;
      }
      const content = parsed?.choices?.[0]?.message?.content
        || parsed?.candidates?.[0]?.content?.parts?.[0]?.text
        || parsed?.output_text
        || responseText;
      lane.apiProviderResult = {
        providerId: this.profile.id,
        apiStyle: this.profile.apiStyle,
        model: this.profile.apiStyle === 'gemini' ? safeGeminiModel(lane, this.profile) : body.model,
        status: response.status,
        receivedAt: new Date().toISOString(),
        outputPreview: trimForLog(redactedText(content, [secret]), 2000),
        usage: parsed?.usage || parsed?.usageMetadata || null,
      };
      lane.apiResponse = lane.apiProviderResult;
      if (lane.processMeta) {
        lane.processMeta.endedAt = new Date().toISOString();
        lane.processMeta.exitCode = 0;
        lane.processMeta.httpStatus = response.status;
        lane.processMeta.responseBytes = responseText.length;
      }
      runtime.status = 'done';
      this.runtimes.delete(String(lane.id));
      await safeFire(this.onLog, lane, `${this.label} API provider completed with HTTP ${response.status}`);
      await safeFire(this.onComplete, lane, `${this.label} API provider completed`);
    } catch (error) {
      if (runtime.status !== 'active') return;
      runtime.status = 'failed';
      this.runtimes.delete(String(lane.id));
      if (lane.processMeta) {
        lane.processMeta.endedAt = new Date().toISOString();
        lane.processMeta.exitCode = 1;
      }
      const message = error?.name === 'AbortError'
        ? `${this.label} API provider request aborted or timed out`
        : `${this.label} API provider failed: ${redactedText(error.message || error, [secret])}`;
      await safeFire(this.onFail, lane, message, 'scheduler');
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(laneId, context = {}) {
    const laneKey = String(laneId);
    const runtime = this.runtimes.get(laneKey);
    if (!runtime) {
      return {
        stopped: false,
        reason: `No active API request found for lane ${laneKey}.`,
      };
    }
    runtime.status = 'stopping';
    this.runtimes.delete(laneKey);
    runtime.controller.abort();
    if (runtime.lane?.processMeta) {
      runtime.lane.processMeta.endedAt = runtime.lane.processMeta.endedAt || new Date().toISOString();
      runtime.lane.processMeta.stopRequestedBy = context.actor || 'dashboard';
      runtime.lane.processMeta.stopResult = 'abort_controller';
    }
    await safeFire(this.onStop, runtime.lane, {
      actor: context.actor || 'dashboard',
      reason: context.reason || `${this.label} API request stop requested`,
    });
    return {
      stopped: true,
      reason: 'API request abort signal sent.',
      processGroupSupported: false,
    };
  }

  touchHeartbeat(laneId, actor = 'adapter') {
    const runtime = this.runtimes.get(String(laneId));
    if (!runtime || runtime.status !== 'active') return false;
    runtime.heartbeatAt = Date.now();
    safeFire(this.onLog, runtime.lane, `[${this.label}] heartbeat from ${actor}`);
    return true;
  }

  async tick() {}

  getRunningCountForSession(sessionId) {
    const want = String(sessionId);
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.status === 'active' && String(runtime.lane.sessionId) === want) count += 1;
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
    await safeFire(this.onLog, lane, `${this.label} executor is not supported by this build.`);
    return {
      accepted: false,
      reason: `${this.label} executor is not supported.`,
    };
  }

  async stop(laneId, context = {}) {
    this.runtimes.delete(String(laneId));
    return {
      stopped: false,
      reason: `Executor ${this.label} is not supported.`,
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

export function getExecutorProfile(type, callbacks = {}) {
  const executorType = String(type || '').toLowerCase();
  if (!['codex', 'claude', 'cli'].includes(executorType)) {
    return null;
  }
  if (executorType === 'cli' && process.env.COMMAND_DECK_ENABLE_CUSTOM_CLI !== 'true' && !process.env.COMMAND_DECK_CLI_BINARY) {
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
  return ['codex', 'claude', 'cli'].reduce((accum, executorType) => {
    const profile = getExecutorProfile(executorType);
    if (profile) accum[executorType] = profile;
    return accum;
  }, {});
}

export {
  API_PROVIDER_TYPES,
  buildExecutorCommandArgs,
  getApiProviderExecutorTypes,
  getApiProviderProfile,
  isApiProviderType,
};

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
    const profile = getExecutorProfile(executorType, callbacks);
    if (!profile) {
      return new PendingExecutorAdapter(executorType, callbacks);
    }
    const options = {
      ...callbacks,
      defaultBinary: profile.defaultBinary,
      allowedBinaries: profile.allowedBinaries,
      envWhitelist: profile.envWhitelist || callbacks.envWhitelist,
      workdirRoots: profile.workdirRoots,
      enforceAllowedBinary: true,
      maxCommandArgs: 128,
      defaultArgs: profile.defaultArgs.length ? profile.defaultArgs : (callbacks.defaultArgs || []),
      defaultWorkingDir: callbacks.defaultWorkingDir || process.cwd(),
      heartbeatTimeoutMs: callbacks.heartbeatTimeoutMs || 15000,
    };
    return new CliExecutorAdapter(executorType, options);
  }

  if (isApiProviderType(executorType)) {
    const profile = getApiProviderProfile(executorType);
    if (!profile) {
      return new PendingExecutorAdapter(executorType, callbacks);
    }
    return new ApiExecutorAdapter(executorType, {
      ...callbacks,
      profile,
    });
  }

  return new PendingExecutorAdapter(executorType, callbacks);
}
