// CLI executor adapter (Codex/Claude/cli) + pending adapter.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pty from '@lydell/node-pty';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createAgentEventNormalizer } from '../agent-events.js';
import {
  ORCA_MCP_SERVER_PATH,
  noopAsync,
  DEFAULT_ENV_WHITELIST,
  MAX_ARGS,
  MAX_WORKDIR_BYTES,
} from './constants.js';
import {
  safeFire,
  normalizeArgs,
  splitShellTokens,
  sanitizeCommandComponent,
  sanitizeArgument,
  sanitizeBinary,
  normalizeAllowedBinaries,
  displayArg,
  parseEnv,
  MAX_EXECUTOR_OUTPUT_BYTES,
  RESERVED_EXECUTOR_ENV_KEYS,
  RUNTIME_ONLY_ENV_KEYS,
} from './sanitize.js';
import { buildExecutorCommandArgs } from './command-builder.js';

function presentationModeForLane(lane) {
  return String(lane?.presentationMode || 'chat').trim().toLowerCase() === 'terminal'
    ? 'terminal'
    : 'chat';
}

const MAX_TERMINAL_INPUT_BYTES = 16 * 1024;

function cleanTerminalDimension(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function redactArgForDisplay(value, index, total) {
  const text = String(value ?? '');
  if (!text) return text;
  const secretish = /(token|secret|password|credential|authorization|cookie|api[-_]?key|bearer|private[-_]?key|client[-_]?secret)/i;
  if (secretish.test(text)) {
    return text.includes('=') ? text.replace(/=.*/, '=[redacted]') : '[redacted-secret-arg]';
  }
  if (index === total - 1 && text.length > 280) {
    return `[prompt ${text.length} chars]`;
  }
  if (text.length > 180) {
    return `${text.slice(0, 90)}...[${text.length} chars]`;
  }
  return text;
}

function commandLineForLog(binary, args, lane) {
  const mode = presentationModeForLane(lane);
  const safeArgs = (Array.isArray(args) ? args : []).map((arg, index, all) => redactArgForDisplay(arg, index, all.length));
  if (mode === 'terminal') {
    return [binary, ...safeArgs].map(displayArg).join(' ');
  }
  return [binary, ...safeArgs].map(displayArg).join(' ');
}

function buildProcessLaunch(safeBinary, args, lane) {
  const mode = presentationModeForLane(lane);
  const rawArgs = Array.isArray(args) ? args : [];
  // Terminal-presented lanes run behind a real PTY so Codex/Claude render the
  // same interactive TUI/slash-command surface users see in their native terminal.
  // Chat lanes stay ordinary pipes so structured event parsing remains stable.
  if (mode === 'terminal') {
    return {
      binary: safeBinary,
      args: rawArgs,
      wrapped: true,
      wrapper: 'pty',
    };
  }
  return { binary: safeBinary, args: rawArgs, wrapped: false, wrapper: null };
}

export class CliExecutorAdapter {
  constructor(label, options = {}) {
    this.label = label;
    this.onLog = options.onLog || noopAsync;
    this.onAgentEvent = options.onAgentEvent || noopAsync;
    this.onComplete = options.onComplete || noopAsync;
    this.onFail = options.onFail || noopAsync;
    this.onStop = options.onStop || noopAsync;

    this.runtimes = new Map();
    // For a real one-shot subprocess (codex exec / claude --print) the child's
    // exit is the authoritative completion signal — NOT a periodic tool heartbeat.
    // A real model turn easily runs >15s silently, so the old 15s reaper killed
    // live agents (the "send failed" bug). Output bumps this clock (see forward()),
    // so this large cap only reaps a process that is truly wedged (silent for the
    // whole window). Mock workers keep their own short timeout (they self-heartbeat).
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs || 30 * 60 * 1000;
    this.defaultBinary = options.defaultBinary || options.binary || label;
    this.defaultArgs = normalizeArgs(options.defaultArgs);
    this.defaultWorkingDir = options.workingDir || process.cwd();
    this.allowedBinaries = normalizeAllowedBinaries([this.defaultBinary, ...(options.allowedBinaries || [])]);
    this.enforceAllowedBinary = options.enforceAllowedBinary !== false;
    this.maxCommandArgs = Number.parseInt(options.maxCommandArgs, 10) || MAX_ARGS;
    this.runtimeEnvForLane = typeof options.runtimeEnvForLane === 'function'
      ? options.runtimeEnvForLane
      : null;

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
      const ok = path.isAbsolute(binary)
        ? allowed.includes(normalizedBinary)
        : (allowed.includes(normalizedBinary) || allowed.includes(basename));
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

    let realResolved = null;
    try {
      realResolved = await fs.realpath(resolved);
    } catch {
      throw new Error('Workdir could not be resolved.');
    }
    let withinRealRoot = false;
    for (const root of this.workdirRoots) {
      try {
        const realRoot = await fs.realpath(root);
        const withSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
        if (realResolved === realRoot || realResolved.startsWith(withSep)) {
          withinRealRoot = true;
          break;
        }
      } catch {
        // Ignore missing/unresolvable roots; they cannot authorize a cwd.
      }
    }
    if (!withinRealRoot) {
      throw new Error('Workdir resolves outside allowed execution roots.');
    }

    return realResolved;
  }

  _buildEnv(lane) {
    const baseEnv = {};
    for (const key of this.envAllowlist) {
      if (typeof process.env[key] === 'string') {
        baseEnv[key] = process.env[key];
      }
    }

    // Apply lane-supplied env FIRST, excluding the reserved server-managed keys,
    // so a lane can never override the lane/session/project identity, artifact
    // dir, or MCP config path the server controls below.
    const laneEnv = parseEnv(lane.env);
    for (const [key, value] of Object.entries(laneEnv)) {
      if (RESERVED_EXECUTOR_ENV_KEYS.has(key)) continue;
      // A lane may not forge runtime-only trust env (lease token / base URL /
      // role); only the server runtime (below) may set these.
      if (RUNTIME_ONLY_ENV_KEYS.has(key)) continue;
      if (this.envAllowlist.has(key) || String(key).startsWith('ORCA_')) {
        baseEnv[key] = value;
      }
    }

    if (this.runtimeEnvForLane) {
      const runtimeEnv = parseEnv(this.runtimeEnvForLane(lane));
      for (const [key, value] of Object.entries(runtimeEnv)) {
        if (RESERVED_EXECUTOR_ENV_KEYS.has(key)) continue;
        if (this.envAllowlist.has(key) || String(key).startsWith('ORCA_')) {
          baseEnv[key] = value;
        }
      }
    }

    // Server-controlled values always win.
    baseEnv.ORCA_LANE_ID = String(lane.id);
    // A lane's sessionId IS its orchestrator id. Export it under the name the routes
    // and the MCP bridge actually use ({orchestratorId}), keeping ORCA_SESSION_ID as
    // the back-compatible alias so an already-running agent config keeps working.
    baseEnv.ORCA_ORCHESTRATOR_ID = String(lane.sessionId || '');
    baseEnv.ORCA_SESSION_ID = String(lane.sessionId || '');
    baseEnv.ORCA_PROJECT_ID = String(lane.projectId || '');
    // ORCA_ARTIFACT_DIR must be an ABSOLUTE FILESYSTEM PATH — the agent writes
    // evidence (screenshots etc.) into it. `lane.artifactPath` is the URL path used
    // to SERVE artifacts ("/artifacts/<session>/<lane>"), so handing that over meant
    // an agent following our own docs wrote to the filesystem ROOT. Evidence then
    // never landed where the reader looks (<cwd>/artifacts/...), so `audit.accept`
    // permanently refused targetUrl lanes for "no captured evidence".
    baseEnv.ORCA_ARTIFACT_DIR = lane.sessionId && lane.id
      ? path.join(process.cwd(), 'artifacts', String(lane.sessionId), String(lane.id))
      : '';
    if (lane.mcpConfigPath) {
      baseEnv.ORCA_MCP_CONFIG = lane.mcpConfigPath;
    }
    if (presentationModeForLane(lane) === 'terminal') {
      baseEnv.TERM = baseEnv.TERM || 'xterm-256color';
      baseEnv.COLORTERM = baseEnv.COLORTERM || 'truecolor';
      baseEnv.CLICOLOR_FORCE = baseEnv.CLICOLOR_FORCE || '1';
      baseEnv.FORCE_COLOR = baseEnv.FORCE_COLOR || '1';
    }
    return baseEnv;
  }

  async _buildMcpConfig(runtimeDir, lane) {
    const label = String(this.label || '').toLowerCase();
    // Codex/Claude both consume a JSON map of servers; preserving the same
    // shape across executors keeps the dashboard simple while still letting
    // the file be loaded with executor-native config flags.
    const servers = {};

    // Built-in Orca workflow tools, available to every lane that has a lease.
    // The lease/base-url/role are provided by the lane runtime env.
    const runtimeEnv = this.runtimeEnvForLane ? (this.runtimeEnvForLane(lane) || {}) : {};
    if (runtimeEnv.ORCA_TOOL_LEASE_TOKEN) {
      servers.orca = {
        command: process.execPath,
        args: [ORCA_MCP_SERVER_PATH],
        env: {
          ORCA_AGENT_TOOLS_BASE_URL: String(runtimeEnv.ORCA_AGENT_TOOLS_BASE_URL || ''),
          ORCA_TOOL_LEASE_TOKEN: String(runtimeEnv.ORCA_TOOL_LEASE_TOKEN),
          ORCA_ROLE: String(runtimeEnv.ORCA_ROLE || 'executor'),
          ORCA_LANE_ID: String(lane.id),
          ORCA_ORCHESTRATOR_ID: String(lane.sessionId || ''),
          ORCA_SESSION_ID: String(lane.sessionId || ''),
          ORCA_PROJECT_ID: String(lane.projectId || ''),
        },
        scope: ['all'],
        description: 'Built-in Orca workflow tools (spawn/stop, tasks, audit, evidence, summary/diff).',
      };
    }

    if (!Object.keys(servers).length) {
      return { configPath: null, servers: {} };
    }

    const config = {
      createdAt: new Date().toISOString(),
      laneId: lane.id,
      executorType: label,
      mcpServers: servers,
    };
    const configPath = path.join(runtimeDir, 'mcp-tools.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    // Return the structured servers too: claude loads the file via --mcp-config,
    // but codex has no such flag and needs `-c mcp_servers.*` overrides instead.
    return { configPath, servers };
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

    // Build the per-lane MCP config (including the built-in Orca server) before
    // args so executors that derive a command from the task prompt get the
    // --mcp-config flag pointing at it.
    const runtimeDir = path.join(process.cwd(), 'artifacts', String(lane.sessionId || 'orphan'), String(lane.id));
    await fs.mkdir(runtimeDir, { recursive: true });
    const mcpResult = await this._buildMcpConfig(runtimeDir, lane);
    lane.mcpConfigPath = mcpResult.configPath;
    const mcpServers = mcpResult.servers;

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
      args = buildExecutorCommandArgs(this.label, lane, { mcpServers });
    }

    let runtime = null; // hoisted so the catch can reap a child spawned before a throw
    try {
      const safeBinary = this._resolveBinary(binary);
      runtime = {
        runtimeId: randomUUID(),
        lane,
        status: 'active',
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
        binary: safeBinary,
        args,
        process: null,
        eventNormalizer: createAgentEventNormalizer(this.label),
        exitSeen: false,
        finalized: false,
        stdoutClosed: true,
        stderrClosed: true,
        exitCode: null,
        signal: null,
      };
      lane.artifactPath = `/artifacts/${lane.sessionId || 'orphan'}/${lane.id}`;
      const safeWorkdir = await this._resolveWorkdir(lane.workdir || this.defaultWorkingDir);

      const launch = buildProcessLaunch(safeBinary, args, lane);
      const usePty = launch.wrapper === 'pty';
      const child = usePty
        ? pty.spawn(launch.binary, launch.args, {
          cwd: safeWorkdir,
          env: this._buildEnv(lane),
          name: 'xterm-256color',
          cols: 100,
          rows: 28,
          encoding: 'utf8',
        })
        : spawn(launch.binary, launch.args, {
          shell: false,
          cwd: safeWorkdir,
          env: this._buildEnv(lane),
          detached: process.platform !== 'win32',
          // The prompt is passed as argv; the child must NOT inherit/keep an open
          // stdin pipe. `codex exec` blocks forever on "Reading additional input
          // from stdin..." waiting for EOF that never comes, and `claude --print`
          // wastes 3s warning about missing stdin. Close stdin so one-shot agents
          // run to completion.
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      runtime.usesPty = usePty;
      runtime.process = child;
      this.runtimes.set(String(lane.id), runtime);
      lane.processMeta = {
        pid: child.pid || null,
        pgid: process.platform === 'win32' ? null : (child.pid || null),
        binary: safeBinary,
        args: args.map((arg, index) => redactArgForDisplay(arg, index, args.length)),
        launchBinary: launch.binary,
        launchArgs: launch.args.map((arg, index) => redactArgForDisplay(arg, index, launch.args.length)),
        terminalWrapper: launch.wrapper,
        cwd: safeWorkdir,
        presentationMode: presentationModeForLane(lane),
        envPolicy: this.envWhitelist?.length ? 'allowlist' : 'default',
        startedAt: new Date(runtime.startedAt).toISOString(),
        endedAt: null,
        exitCode: null,
        signal: null,
        stopRequestedBy: null,
        stopResult: null,
        platform: process.platform,
        processGroupSupported: !usePty && process.platform !== 'win32',
      };
      runtime.terminalLogPath = path.join(runtimeDir, 'terminal.log');
      runtime.stdoutLogPath = path.join(runtimeDir, 'stdout.log');
      runtime.stderrLogPath = path.join(runtimeDir, 'stderr.log');
      const commandLine = commandLineForLog(safeBinary, args, lane);
      const terminalPreamble = usePty
        ? ''
        : `Command: ${commandLine}\nPresentation: ${presentationModeForLane(lane)}${launch.wrapper ? ` (${launch.wrapper} PTY)` : ''}\nCwd: ${safeWorkdir}\nStarted: ${lane.processMeta.startedAt}\n\n`;
      await fs.writeFile(
        runtime.terminalLogPath,
        terminalPreamble,
      );
      await fs.writeFile(runtime.stdoutLogPath, '');
      await fs.writeFile(runtime.stderrLogPath, '');

      if (!usePty) {
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
      }
      runtime.stdoutClosed = usePty ? true : !child.stdout;
      runtime.stderrClosed = usePty ? true : !child.stderr;
      // Bound total forwarded output so a runaway executor cannot exhaust memory
      // through queued data events feeding an async onLog callback.
      runtime.outputBytes = 0;
      runtime.outputCapped = false;
      const forward = (prefix, chunk, streamPath, streamName) => {
        // Any output is proof of life — reset the heartbeat clock so the reaper
        // never kills an actively-working agent that streams without calling the
        // lane heartbeat tool.
        runtime.heartbeatAt = Date.now();
        const text = String(chunk);
        // Cap only the PERSISTED log volume (disk + onLog), NOT event parsing — a
        // verbose agent (claude --include-partial-messages) can exceed the cap
        // before its final `result` event; destroying the stream lost the result.
        // Keep feeding the normalizer (bounded per-line + capped agentEvents) so
        // the final assistant message / result is always captured.
        if (!runtime.outputCapped) {
          const nextBytes = runtime.outputBytes + Buffer.byteLength(text, 'utf8');
          if (nextBytes > MAX_EXECUTOR_OUTPUT_BYTES) {
            const remainingBytes = Math.max(0, MAX_EXECUTOR_OUTPUT_BYTES - runtime.outputBytes);
            const cappedText = Buffer.from(text, 'utf8').subarray(0, remainingBytes).toString('utf8');
            if (cappedText) {
              fs.appendFile(streamPath, cappedText).catch(() => {});
              fs.appendFile(runtime.terminalLogPath, cappedText).catch(() => {});
            }
            runtime.outputBytes = MAX_EXECUTOR_OUTPUT_BYTES;
            runtime.outputCapped = true;
            fs.appendFile(runtime.terminalLogPath, `\n[orca] output LOG truncated after ${MAX_EXECUTOR_OUTPUT_BYTES} bytes (still parsing for the final result).\n`).catch(() => {});
            safeFire(this.onLog, lane, `[${this.label}] output log truncated after ${MAX_EXECUTOR_OUTPUT_BYTES} bytes.`);
          } else {
            runtime.outputBytes = nextBytes;
            fs.appendFile(streamPath, text).catch(() => {});
            fs.appendFile(runtime.terminalLogPath, text).catch(() => {});
            safeFire(this.onLog, lane, `${prefix} ${text.trim()}`);
          }
        }
        // ALWAYS parse events (bounded) so resultText/agent.done are captured even
        // after the log cap. Never destroy the stream — child exit is authoritative.
        for (const agentEvent of runtime.eventNormalizer.consume(streamName, text)) {
          safeFire(this.onAgentEvent, lane, agentEvent);
        }
      };
      const maybeFinalizeExit = () => {
        if (runtime.finalized || !runtime.exitSeen || !runtime.stdoutClosed || !runtime.stderrClosed) return;
        runtime.finalized = true;
        for (const agentEvent of runtime.eventNormalizer.flush()) {
          safeFire(this.onAgentEvent, lane, agentEvent);
        }
        if (lane.processMeta) {
          lane.processMeta.endedAt = lane.processMeta.endedAt || new Date().toISOString();
          lane.processMeta.exitCode = runtime.exitCode;
          lane.processMeta.signal = runtime.signal || null;
        }
        if (runtime.status !== 'active') return;
        runtime.status = runtime.exitCode === 0 ? 'done' : 'failed';
        this.runtimes.delete(String(lane.id));
        if (runtime.status === 'done') {
          safeFire(this.onComplete, lane, `${this.label} exited with code ${runtime.exitCode}`);
          return;
        }
        if (runtime.signal) {
          safeFire(this.onFail, lane, `${this.label} terminated by ${runtime.signal}`, 'scheduler');
        } else {
          safeFire(this.onFail, lane, `${this.label} exited with status ${runtime.exitCode}`, 'scheduler');
        }
      };

      if (usePty) {
        runtime.ptyDataDisposable = child.onData((chunk) => forward(`[${this.label}]`, chunk, runtime.stdoutLogPath, 'stdout'));
        runtime.ptyExitDisposable = child.onExit((event = {}) => {
          const code = Number.isFinite(event.exitCode) ? event.exitCode : null;
          const signal = event.signal || null;
          fs.appendFile(runtime.terminalLogPath, `\n[orca] process exited code=${code} signal=${signal || ''}\n`).catch(() => {});
          runtime.exitSeen = true;
          runtime.exitCode = code;
          runtime.signal = signal || null;
          if (lane.processMeta) {
            lane.processMeta.endedAt = lane.processMeta.endedAt || new Date().toISOString();
            lane.processMeta.exitCode = code;
            lane.processMeta.signal = signal || null;
          }
          maybeFinalizeExit();
        });
      } else {
        child.stdout?.on('data', (chunk) => forward(`[${this.label}]`, chunk, runtime.stdoutLogPath, 'stdout'));
        child.stderr?.on('data', (chunk) => forward(`[${this.label} err]`, chunk, runtime.stderrLogPath, 'stderr'));

        child.stdout?.on('close', () => {
          runtime.stdoutClosed = true;
          maybeFinalizeExit();
        });
        child.stderr?.on('close', () => {
          runtime.stderrClosed = true;
          maybeFinalizeExit();
        });

        child.on('error', (error) => {
          if (runtime.status !== 'active') return;
          runtime.status = 'failed';
          // Detach output listeners so a late buffered chunk can't fire onLog on a
          // lane whose runtime was already reaped.
          child.stdout?.destroy();
          child.stderr?.destroy();
          fs.appendFile(runtime.terminalLogPath, `\n[orca] process failed to launch: ${error.message} (${error.code || 'ERR'})\n`).catch(() => {});
          this.runtimes.delete(String(lane.id));
          safeFire(this.onFail, lane, `Executor process failed to launch: ${error.message} (${error.code || 'ERR'})`, 'scheduler');
        });

        child.on('exit', (code, signal) => {
          fs.appendFile(runtime.terminalLogPath, `\n[orca] process exited code=${code} signal=${signal || ''}\n`).catch(() => {});
          runtime.exitSeen = true;
          runtime.exitCode = code;
          runtime.signal = signal || null;
          if (lane.processMeta) {
            lane.processMeta.endedAt = lane.processMeta.endedAt || new Date().toISOString();
            lane.processMeta.exitCode = code;
            lane.processMeta.signal = signal || null;
          }
          maybeFinalizeExit();
        });
      }

      await safeFire(this.onLog, lane, `${this.label} adapter started (runtime ${runtime.runtimeId})`);
      if (lane.mcpConfigPath) {
        await safeFire(this.onLog, lane, `${this.label} lane MCP config loaded at ${lane.mcpConfigPath}`);
      }
      return { accepted: true, runtime };
    } catch (error) {
      // If the child was already spawned before the throw (e.g. a post-spawn log
      // writeFile failed with ENOSPC/EACCES), the scheduler will see accepted:false
      // and never call stop() — so the detached process group would survive as an
      // untracked zombie. Kill it and drop its runtime entry here.
      try {
        const proc = runtime?.process;
        if (proc) {
          if (runtime?.usesPty) {
            try { runtime.ptyDataDisposable?.dispose?.(); } catch { /* ignore */ }
            try { runtime.ptyExitDisposable?.dispose?.(); } catch { /* ignore */ }
            try { proc.kill('SIGHUP'); } catch { /* already gone */ }
          } else {
            proc.removeAllListeners('exit');
            proc.stdout?.removeAllListeners('data');
            proc.stdout?.removeAllListeners('close');
            proc.stderr?.removeAllListeners('data');
            proc.stderr?.removeAllListeners('close');
            proc.removeAllListeners('error');
            const pid = proc.pid;
            if (pid) {
              if (process.platform === 'win32') {
                try { proc.kill('SIGKILL'); } catch { /* already gone */ }
              } else {
                try { process.kill(-pid, 'SIGKILL'); } catch {
                  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
                }
              }
            }
          }
          this.runtimes.delete(String(lane.id));
        }
      } catch { /* best-effort cleanup */ }
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
    const proc = runtime.process;
    if (runtime.usesPty) {
      try { runtime.ptyDataDisposable?.dispose?.(); } catch { /* ignore */ }
      try { runtime.ptyExitDisposable?.dispose?.(); } catch { /* ignore */ }
      let killedPty = false;
      try {
        proc.kill('SIGHUP');
        killedPty = true;
      } catch { /* already exited */ }
      this.runtimes.delete(laneKey);
      const meta = runtime.lane?.processMeta || null;
      if (meta) {
        meta.endedAt = meta.endedAt || new Date().toISOString();
        meta.stopRequestedBy = context.actor || 'dashboard';
        meta.stopResult = killedPty ? 'sighup' : 'no_active_process';
      }
      await safeFire(this.onStop, runtime.lane, {
        actor: context.actor || 'dashboard',
        reason: context.reason || `${this.label} adapter stop requested`,
      });
      await safeFire(this.onLog, runtime.lane, `${this.label} adapter stopped (${killedPty ? 'sighup sent' : 'already exited'}).`);
      return {
        stopped: true,
        reason: killedPty ? 'Stop signal sent.' : 'No running process to stop.',
        processGroupSupported: false,
      };
    }

    runtime.process.removeAllListeners('exit');
    // Detach the stdout/stderr data and error listeners too: after we kill the
    // child, a late buffered chunk would otherwise call forward() → onLog on a
    // lane the registry has already terminalized, and keep the streams referenced.
    proc.stdout?.removeAllListeners('data');
    proc.stdout?.removeAllListeners('close');
    proc.stderr?.removeAllListeners('data');
    proc.stderr?.removeAllListeners('close');
    proc.removeAllListeners('error');
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
    const escalateAfterMs = Number.parseInt(process.env.ORCA_STOP_ESCALATE_MS || '', 10) || 4000;
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

  writeTerminalInput(laneId, input, context = {}) {
    const runtime = this.runtimes.get(String(laneId));
    if (!runtime || runtime.status !== 'active' || !runtime.process) {
      throw { status: 409, message: 'Lane terminal is not running.' };
    }
    if (!runtime.usesPty) {
      throw { status: 409, message: 'Lane is not backed by an interactive terminal.' };
    }
    const text = String(input ?? '');
    if (!text) throw { status: 422, message: 'Terminal input is required.' };
    if (Buffer.byteLength(text, 'utf8') > MAX_TERMINAL_INPUT_BYTES) {
      throw { status: 413, message: `Terminal input exceeds ${MAX_TERMINAL_INPUT_BYTES} bytes.` };
    }
    const normalized = context.raw ? text : (text.endsWith('\n') || text.endsWith('\r') ? text : `${text}\n`);
    runtime.process.write(normalized);
    runtime.heartbeatAt = Date.now();
    return { accepted: true, laneId: String(laneId), bytes: Buffer.byteLength(normalized, 'utf8') };
  }

  resizeTerminal(laneId, { cols, rows } = {}) {
    const runtime = this.runtimes.get(String(laneId));
    if (!runtime || runtime.status !== 'active' || !runtime.process) {
      throw { status: 409, message: 'Lane terminal is not running.' };
    }
    if (!runtime.usesPty) {
      throw { status: 409, message: 'Lane is not backed by an interactive terminal.' };
    }
    const nextCols = cleanTerminalDimension(cols, 100, 20, 240);
    const nextRows = cleanTerminalDimension(rows, 28, 8, 80);
    runtime.process.resize(nextCols, nextRows);
    return { accepted: true, laneId: String(laneId), cols: nextCols, rows: nextRows };
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
        // Kill the whole detached PROCESS GROUP (not just the direct child) — the
        // agent's fan-outs (node/git/browsers) live in that group and would
        // otherwise be orphaned. Mirror stop()'s negative-PID kill.
        if (runtime.usesPty) {
          try { runtime.ptyDataDisposable?.dispose?.(); } catch { /* ignore */ }
          try { runtime.ptyExitDisposable?.dispose?.(); } catch { /* ignore */ }
          try { runtime.process.kill('SIGHUP'); } catch { /* gone */ }
        } else {
          const pid = runtime.process.pid;
          if (pid && process.platform !== 'win32') {
            try { process.kill(-pid, 'SIGKILL'); } catch { try { runtime.process.kill('SIGKILL'); } catch { /* gone */ } }
          } else {
            try { runtime.process.kill('SIGKILL'); } catch { /* gone */ }
          }
        }
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

  getActiveLaneIds() {
    return [...this.runtimes.entries()]
      .filter(([, runtime]) => runtime.status === 'active')
      .map(([laneId]) => laneId);
  }
}

export class PendingExecutorAdapter {
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
