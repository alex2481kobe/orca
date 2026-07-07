import { randomUUID } from 'node:crypto';
import pty from '@lydell/node-pty';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { availableToolIdsForRole } from './agent-tools.js';
import { getExecutorProfile } from './executor-factory.js';
import { buildOrchestratorMcpConfigs } from './mcp-orchestrator-bootstrap.js';

const MAX_TERMINALS_PER_SESSION = 4;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_RETAINED_CHARS = 256 * 1024;
const TERMINAL_TAIL_DEFAULT_CHARS = 32 * 1024;
const TERMINAL_TAIL_MAX_CHARS = 128 * 1024;
const AGENT_MARKER_RE = /\x1b]777;ORCA_AGENT_STARTED=([A-Za-z0-9_-]+)\x07/g;
const AGENT_EXIT_MARKER_RE = /\x1b]777;ORCA_AGENT_EXITED=([A-Za-z0-9_-]+):(-?\d+)\x07/g;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, fallback = '', max = 160) {
  const text = String(value ?? '').replace(/\x00/g, '').trim();
  return (text || fallback).slice(0, max);
}

function publicShellName(value) {
  return path.basename(String(value || '').trim()) || 'shell';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function envPathParts() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function canExecute(file) {
  try {
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(binary, skipDir = '') {
  const value = String(binary || '').trim();
  if (!value) return '';
  if (path.isAbsolute(value)) return value;
  for (const dir of envPathParts()) {
    if (skipDir && path.resolve(dir) === path.resolve(skipDir)) continue;
    const candidate = path.join(dir, value);
    if (await canExecute(candidate)) return candidate;
  }
  return value;
}

function chooseShell(explicitShell) {
  const candidates = [
    explicitShell,
    process.env.SHELL,
    process.platform === 'win32' ? process.env.ComSpec : '',
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return candidates.find((value) => {
    if (process.platform === 'win32') return true;
    return path.isAbsolute(value);
  }) || '/bin/sh';
}

function buildShellLaunch(shellPath) {
  const shellName = publicShellName(shellPath);
  const loginFlag = shellName.includes('zsh') || shellName.includes('bash') ? '-l' : '';
  const shellArgs = loginFlag ? [loginFlag] : [];
  return {
    binary: shellPath,
    args: shellArgs,
    displayBinary: shellPath,
    displayArgs: shellArgs,
    wrapper: 'pty',
  };
}

function buildTerminalEnv(session, shellPath, bridge = null) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';
  env.CLICOLOR_FORCE = env.CLICOLOR_FORCE || '1';
  env.FORCE_COLOR = env.FORCE_COLOR || '1';
  env.SHELL = shellPath || env.SHELL || '/bin/sh';
  env.ORCA_SESSION_ID = session.id;
  env.ORCA_PROJECT_ID = session.projectId || '';
  if (bridge?.wrapperDir) {
    env.PATH = `${bridge.wrapperDir}${path.delimiter}${env.PATH || ''}`;
  }
  if (bridge?.env) {
    for (const [key, value] of Object.entries(bridge.env)) {
      env[key] = String(value || '');
    }
  }
  if (bridge?.zdotdir) {
    env.ORCA_REAL_ZDOTDIR = env.ZDOTDIR || env.HOME || '';
    env.ZDOTDIR = bridge.zdotdir;
  }
  if (bridge?.terminalId) env.ORCA_TERMINAL_ID = bridge.terminalId;
  if (bridge?.leaseId) env.ORCA_TOOL_LEASE_ID = bridge.leaseId;
  return env;
}

function cleanDimension(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function appendBounded(terminal, chunk) {
  const text = String(chunk || '');
  if (!text) return;
  terminal.output += text;
  terminal.size += text.length;
  if (terminal.output.length > MAX_RETAINED_CHARS) {
    const extra = terminal.output.length - MAX_RETAINED_CHARS;
    terminal.output = terminal.output.slice(extra);
    terminal.baseOffset += extra;
    terminal.truncated = true;
  }
  terminal.updatedAt = nowIso();
}

function terminalSummary(terminal) {
  if (!terminal) return null;
  return {
    id: terminal.id,
    sessionId: terminal.sessionId,
    projectId: terminal.projectId,
    title: terminal.title,
    state: terminal.state,
    cwd: terminal.cwd,
    shell: terminal.shellName,
    pid: terminal.pid || null,
    wrapper: terminal.wrapper || null,
    cols: terminal.cols,
    rows: terminal.rows,
    createdAt: terminal.createdAt,
    updatedAt: terminal.updatedAt,
    endedAt: terminal.endedAt || null,
    exitCode: terminal.exitCode ?? null,
    signal: terminal.signal || null,
    size: terminal.size,
    baseOffset: terminal.baseOffset,
    truncated: Boolean(terminal.truncated),
    agentBridge: terminal.agentBridge ? {
      state: terminal.agentBridge.state || 'ready',
      role: terminal.agentBridge.role || 'orchestrator',
      actor: terminal.agentBridge.actor || null,
      leaseId: terminal.agentBridge.leaseId || null,
      executorType: terminal.agentBridge.executorType || null,
      activeLaneId: terminal.agentBridge.activeLaneId || null,
      startedAt: terminal.agentBridge.startedAt || null,
      wrapperCommands: Array.isArray(terminal.agentBridge.wrapperCommands) ? terminal.agentBridge.wrapperCommands : [],
    } : null,
  };
}

async function writeWrapperScript({ wrapperPath, realBinary, injectedArgs = [], executorType }) {
  const marker = `\x1b]777;ORCA_AGENT_STARTED=${executorType}\x07`;
  const exitPrefix = `\x1b]777;ORCA_AGENT_EXITED=${executorType}:`;
  const exitSuffix = '\x07';
  const lines = [
    '#!/bin/sh',
    `printf ${shellQuote(marker)}`,
    `${shellQuote(realBinary)}${injectedArgs.length ? ` ${injectedArgs.map(shellQuote).join(' ')}` : ''} "$@"`,
    'status=$?',
    `printf ${shellQuote(exitPrefix)}"$status"${shellQuote(exitSuffix)}`,
    'exit "$status"',
    '',
  ];
  await fs.writeFile(wrapperPath, lines.join('\n'), { mode: 0o700 });
  await fs.chmod(wrapperPath, 0o700);
}

async function writeZshBridgeEnv({ shellDir }) {
  await fs.mkdir(shellDir, { recursive: true });
  await fs.chmod(shellDir, 0o700).catch(() => {});
  const zshenv = [
    '# Orca keeps manual agent launches connected to this session.',
    'orca_agent_bridge_path() {',
    '  if [ -n "$ORCA_AGENT_BRIDGE_BIN" ]; then',
    '    path=("$ORCA_AGENT_BRIDGE_BIN" ${path:#$ORCA_AGENT_BRIDGE_BIN})',
    '    export PATH',
    '    rehash >/dev/null 2>&1 || hash -r >/dev/null 2>&1 || true',
    '  fi',
    '}',
    'if [ -n "$ORCA_REAL_ZDOTDIR" ] && [ "$ORCA_REAL_ZDOTDIR" != "$ZDOTDIR" ] && [ -r "$ORCA_REAL_ZDOTDIR/.zshenv" ]; then',
    '  . "$ORCA_REAL_ZDOTDIR/.zshenv"',
    'fi',
    'orca_agent_bridge_path',
    'if autoload -Uz add-zsh-hook >/dev/null 2>&1; then',
    '  add-zsh-hook precmd orca_agent_bridge_path >/dev/null 2>&1 || true',
    '  add-zsh-hook preexec orca_agent_bridge_path >/dev/null 2>&1 || true',
    'fi',
    '',
  ].join('\n');
  await fs.writeFile(path.join(shellDir, '.zshenv'), zshenv, { mode: 0o600 });
  return shellDir;
}

async function createTerminalAgentBridge(registry, session, terminalId, artifactDir) {
  const allowedTools = availableToolIdsForRole('orchestrator');
  if (!allowedTools.length) return null;
  const actor = `operator-terminal:${terminalId}`;
  const { lease, leaseToken } = registry.createToolLease({
    role: 'orchestrator',
    projectId: session.projectId,
    sessionId: session.id,
    allowedTools,
    ttlMs: 24 * 60 * 60 * 1000,
    actor,
    replaceActiveForActor: true,
  });
  const configs = buildOrchestratorMcpConfigs({
    baseUrl: registry.serverBaseUrl(),
    leaseToken,
    role: 'orchestrator',
    projectId: session.projectId,
    sessionId: session.id,
  });
  const wrapperDir = path.join(artifactDir, 'bin');
  await fs.mkdir(wrapperDir, { recursive: true });
  await fs.chmod(wrapperDir, 0o700).catch(() => {});
  const zdotdir = await writeZshBridgeEnv({ shellDir: path.join(artifactDir, 'shell', 'zsh') });
  const claudeConfigPath = path.join(artifactDir, 'claude-mcp.json');
  await fs.writeFile(claudeConfigPath, JSON.stringify(configs.clients.claudeDesktop.config, null, 2), { mode: 0o600 });

  const wrapperCommands = [];
  const codexProfile = getExecutorProfile('codex') || {};
  const codexReal = await resolveExecutable(codexProfile.defaultBinary || 'codex', wrapperDir);
  if (codexReal && path.isAbsolute(codexReal)) {
    const injectedArgs = [
      '-c', `mcp_servers.orca.command=${JSON.stringify(configs.nodePath)}`,
      '-c', `mcp_servers.orca.args=${JSON.stringify([configs.serverPath])}`,
      ...Object.entries(configs.env).flatMap(([key, value]) => ['-c', `mcp_servers.orca.env.${key}=${JSON.stringify(String(value))}`]),
    ];
    await writeWrapperScript({
      wrapperPath: path.join(wrapperDir, 'codex'),
      realBinary: codexReal,
      injectedArgs,
      executorType: 'codex',
    });
    wrapperCommands.push('codex');
  }

  const claudeProfile = getExecutorProfile('claude') || {};
  const claudeReal = await resolveExecutable(claudeProfile.defaultBinary || 'claude', wrapperDir);
  if (claudeReal && path.isAbsolute(claudeReal)) {
    await writeWrapperScript({
      wrapperPath: path.join(wrapperDir, 'claude'),
      realBinary: claudeReal,
      injectedArgs: ['--mcp-config', claudeConfigPath],
      executorType: 'claude',
    });
    wrapperCommands.push('claude');
  }

  return {
    state: 'ready',
    role: 'orchestrator',
    actor,
    leaseId: lease.id,
    terminalId,
    wrapperDir,
    zdotdir,
    wrapperCommands,
    env: {
      ...configs.env,
      ORCA_AGENT_BRIDGE_BIN: wrapperDir,
      ORCA_ROLE: 'orchestrator',
      ORCA_TERMINAL_ID: terminalId,
    },
  };
}

export function createOperatorTerminalManager({ registry }) {
  const terminals = new Map();

  function sessionFor(sessionLocator) {
    const session = registry.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    return session;
  }

  function terminalFor(id) {
    const terminal = terminals.get(String(id || ''));
    if (!terminal) throw { status: 404, message: 'Terminal not found.' };
    return terminal;
  }

  function listForSession(sessionLocator) {
    const session = sessionFor(sessionLocator);
    return [...terminals.values()]
      .filter((terminal) => terminal.sessionId === session.id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(terminalSummary);
  }

  async function start(sessionLocator, body = {}, context = {}) {
    const session = sessionFor(sessionLocator);
    const activeCount = [...terminals.values()]
      .filter((terminal) => terminal.sessionId === session.id && terminal.state === 'running')
      .length;
    if (activeCount >= MAX_TERMINALS_PER_SESSION) {
      throw { status: 409, message: `Session already has ${MAX_TERMINALS_PER_SESSION} active terminal tabs.` };
    }

    const startCwd = registry.resolveLaneWorkdir(session, body.cwd || session.repoRoot || session.worktreeRoot);
    const shellPath = chooseShell(body.shell);
    const launch = buildShellLaunch(shellPath);
    const createdAt = nowIso();
    const id = randomUUID();
    const artifactDir = path.join(process.cwd(), 'artifacts', String(session.id), 'operator-terminals', id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.chmod(artifactDir, 0o700).catch(() => {});
    const logPath = path.join(artifactDir, 'terminal.log');
    const agentBridge = await createTerminalAgentBridge(registry, session, id, artifactDir);

    const cols = cleanDimension(body.cols, 100, 20, 240);
    const rows = cleanDimension(body.rows, 28, 8, 80);
    const term = pty.spawn(launch.binary, launch.args, {
      cwd: startCwd,
      env: buildTerminalEnv(session, shellPath, agentBridge),
      name: 'xterm-256color',
      cols,
      rows,
      encoding: 'utf8',
    });

    const title = cleanText(body.title, 'terminal', 80);
    const terminal = {
      id,
      projectId: session.projectId,
      sessionId: session.id,
      title,
      cwd: startCwd,
      shellName: publicShellName(shellPath),
      shellPath,
      wrapper: launch.wrapper,
      cols,
      rows,
      state: 'running',
      pid: term.pid || null,
      process: term,
      logPath,
      output: '',
      size: 0,
      baseOffset: 0,
      truncated: false,
      createdAt,
      updatedAt: createdAt,
      endedAt: null,
      exitCode: null,
      signal: null,
      agentBridge,
    };
    terminals.set(id, terminal);

    appendBounded(terminal, [
      `Orca terminal (${terminal.wrapper})`,
      `Shell: ${terminal.shellName}`,
      `Cwd: ${startCwd}`,
      `Started: ${createdAt}`,
      agentBridge?.wrapperCommands?.length
        ? `Orca agent bridge: ${agentBridge.wrapperCommands.join(', ')}`
        : '',
      '',
    ].filter((line) => line !== '').join('\n') + '\n');
    await fs.writeFile(logPath, terminal.output);

    const attachAgent = (executorType) => {
      if (!terminal.agentBridge) return;
      const normalized = cleanText(executorType, 'agent', 40).toLowerCase();
      terminal.agentBridge.state = 'active';
      terminal.agentBridge.executorType = normalized;
      terminal.agentBridge.startedAt = terminal.agentBridge.startedAt || nowIso();
      try {
        const result = registry.attachNativeAgentTerminal(session.id, {
          terminalId: terminal.id,
          executorType: normalized,
          cwd: terminal.cwd,
          pid: terminal.pid,
          cols: terminal.cols,
          rows: terminal.rows,
          leaseId: terminal.agentBridge.leaseId,
          actor: `${normalized}:${terminal.id.slice(0, 8)}`,
          title: terminal.title,
        });
        terminal.agentBridge.activeLaneId = result?.lane?.id || result?.laneId || terminal.agentBridge.activeLaneId || null;
      } catch (error) {
        registry.recordAudit({
          type: 'operator_terminal_agent_attach_failed',
          actor: terminal.agentBridge.actor || 'operator-terminal',
          projectId: session.projectId,
          sessionId: session.id,
          summary: `Operator terminal agent attach failed for ${normalized}`,
          status: 'failed',
          evidence: { terminalId: terminal.id, error: error.message || String(error) },
        });
      }
    };

    const detachAgent = (executorType, exitCode = 0) => {
      if (!terminal.agentBridge) return;
      const normalized = cleanText(executorType, 'agent', 40).toLowerCase();
      const activeLaneId = terminal.agentBridge.activeLaneId || null;
      terminal.agentBridge.state = 'ready';
      terminal.agentBridge.executorType = null;
      terminal.agentBridge.startedAt = null;
      terminal.agentBridge.activeLaneId = null;
      try {
        registry.resignOrchestrator?.(session.id, {
          leaseId: terminal.agentBridge.leaseId,
          reason: 'terminal agent exited',
        });
      } catch { /* another orchestrator may already own the session */ }
      if (!activeLaneId) return;
      const lane = registry.getLane(activeLaneId);
      if (!lane || lane.processMeta?.attachedOperatorTerminalId !== terminal.id) return;
      lane.processMeta = {
        ...(lane.processMeta || {}),
        exitCode,
        signal: null,
        endedAt: nowIso(),
      };
      if (['starting', 'running'].includes(String(lane.state || '').toLowerCase())) {
        if (Number(exitCode) === 0) registry.markLaneCompleted(lane);
        else registry.markLaneFailed(lane, `${normalized} terminal agent exited with code ${exitCode}`, 'operator-terminal');
      } else {
        registry.persistState?.();
      }
    };

    const stripAgentMarkers = (chunk) => {
      let text = String(chunk || '');
      text = text.replace(AGENT_MARKER_RE, (_match, executorType) => {
        attachAgent(executorType);
        return '';
      });
      text = text.replace(AGENT_EXIT_MARKER_RE, (_match, executorType, exitCode) => {
        detachAgent(executorType, Number.parseInt(exitCode, 10) || 0);
        return '';
      });
      return text;
    };

    const forward = (chunk) => {
      const text = stripAgentMarkers(chunk);
      if (!text) return;
      appendBounded(terminal, text);
      fs.appendFile(logPath, text).catch(() => {});
    };
    term.onData(forward);
    term.onExit((event = {}) => {
      const code = Number.isFinite(event.exitCode) ? event.exitCode : null;
      const signal = event.signal || null;
      if (terminal.state === 'stopped') {
        terminal.exitCode = code;
        terminal.signal = signal || terminal.signal;
      } else {
        terminal.state = code === 0 ? 'done' : 'failed';
        terminal.exitCode = code;
        terminal.signal = signal || null;
      }
      terminal.endedAt = nowIso();
      if (terminal.agentBridge?.activeLaneId) {
        detachAgent(terminal.agentBridge.executorType || 'agent', code === null ? 1 : code);
      }
      appendBounded(terminal, `\n[orca] terminal exited code=${code} signal=${signal || ''}\n`);
      fs.appendFile(logPath, `\n[orca] terminal exited code=${code} signal=${signal || ''}\n`).catch(() => {});
    });

    registry.recordAudit({
      type: 'operator_terminal_started',
      actor: cleanText(context.actor, 'dashboard', 120),
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Operator terminal "${title}" started`,
      status: 'passed',
      evidence: {
        terminalId: id,
        cwd: startCwd,
        shell: terminal.shellName,
        wrapper: terminal.wrapper || null,
        agentBridge: terminal.agentBridge ? {
          leaseId: terminal.agentBridge.leaseId,
          wrapperCommands: terminal.agentBridge.wrapperCommands,
        } : null,
      },
    });

    return terminalSummary(terminal);
  }

  function writeInput(id, input, context = {}) {
    const terminal = terminalFor(id);
    if (terminal.state !== 'running' || !terminal.process) {
      throw { status: 409, message: 'Terminal is not running.' };
    }
    const text = String(input ?? '');
    if (!text) throw { status: 422, message: 'Terminal input is required.' };
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
      throw { status: 413, message: `Terminal input exceeds ${MAX_INPUT_BYTES} bytes.` };
    }
    const normalized = context.raw ? text : (text.endsWith('\n') || text.endsWith('\r') ? text : `${text}\n`);
    terminal.process.write(normalized);
    if (!context.raw && !context.skipAudit) {
      registry.recordAudit({
        type: 'operator_terminal_input',
        actor: cleanText(context.actor, 'dashboard', 120),
        projectId: terminal.projectId,
        sessionId: terminal.sessionId,
        summary: `Operator terminal input sent to "${terminal.title}"`,
        status: 'passed',
        evidence: {
          terminalId: terminal.id,
          chars: normalized.length,
          firstToken: normalized.trim().split(/\s+/)[0]?.slice(0, 80) || '',
        },
      });
    }
    return terminalSummary(terminal);
  }

  function writeAgentMessage(id, message, context = {}) {
    const terminal = terminalFor(id);
    const bridge = terminal.agentBridge || null;
    if (bridge?.state !== 'active' || !bridge?.executorType) {
      throw { status: 409, message: 'Terminal does not have an active agent session.' };
    }
    const text = cleanText(message, '', MAX_INPUT_BYTES);
    if (!text) throw { status: 422, message: 'Message is required.' };
    const summary = writeInput(id, text, {
      actor: context.actor || 'dashboard',
      raw: false,
      skipAudit: true,
    });
    const session = registry.getSession(terminal.sessionId);
    if (session && typeof registry.ensureOrchestratorThread === 'function') {
      const thread = registry.ensureOrchestratorThread(session);
      const now = nowIso();
      thread.executorType = bridge.executorType || thread.executorType || null;
      registry.appendOrchestratorThreadMessage(thread, {
        id: randomUUID(),
        role: 'user',
        content: text,
        laneId: bridge.activeLaneId || null,
        createdAt: now,
        source: 'terminal',
        terminalId: terminal.id,
      });
      thread.activeLaneId = bridge.activeLaneId || thread.activeLaneId || null;
      thread.updatedAt = now;
      registry.persistState?.();
    }
    registry.recordAudit({
      type: 'operator_terminal_agent_message',
      actor: cleanText(context.actor, 'dashboard', 120),
      projectId: terminal.projectId,
      sessionId: terminal.sessionId,
      summary: `Message sent to native ${bridge.executorType} terminal agent`,
      status: 'passed',
      evidence: {
        terminalId: terminal.id,
        executorType: bridge.executorType,
        chars: text.length,
      },
    });
    return summary;
  }

  function resize(id, { cols, rows } = {}, context = {}) {
    const terminal = terminalFor(id);
    if (terminal.state !== 'running' || !terminal.process) {
      throw { status: 409, message: 'Terminal is not running.' };
    }
    const nextCols = cleanDimension(cols, terminal.cols || 100, 20, 240);
    const nextRows = cleanDimension(rows, terminal.rows || 28, 8, 80);
    terminal.process.resize(nextCols, nextRows);
    terminal.cols = nextCols;
    terminal.rows = nextRows;
    terminal.updatedAt = nowIso();
    registry.recordAudit({
      type: 'operator_terminal_resized',
      actor: cleanText(context.actor, 'dashboard', 120),
      projectId: terminal.projectId,
      sessionId: terminal.sessionId,
      summary: `Operator terminal "${terminal.title}" resized`,
      status: 'passed',
      evidence: { terminalId: terminal.id, cols: nextCols, rows: nextRows },
    });
    return terminalSummary(terminal);
  }

  function tail(id, { offset = null, maxChars = TERMINAL_TAIL_DEFAULT_CHARS } = {}) {
    const terminal = terminalFor(id);
    const parsedMax = Number.parseInt(maxChars, 10);
    const limit = Math.max(1, Math.min(TERMINAL_TAIL_MAX_CHARS, Number.isFinite(parsedMax) ? parsedMax : TERMINAL_TAIL_DEFAULT_CHARS));
    const parsedOffset = offset === null || offset === undefined || offset === ''
      ? null
      : Number.parseInt(offset, 10);
    const startOffset = Number.isFinite(parsedOffset) && parsedOffset >= terminal.baseOffset
      ? Math.min(parsedOffset, terminal.baseOffset + terminal.output.length)
      : Math.max(terminal.baseOffset, terminal.baseOffset + terminal.output.length - limit);
    const relativeStart = Math.max(0, startOffset - terminal.baseOffset);
    const text = terminal.output.slice(relativeStart, relativeStart + limit);
    return {
      terminal: terminalSummary(terminal),
      offset: startOffset,
      nextOffset: startOffset + text.length,
      size: terminal.baseOffset + terminal.output.length,
      truncated: terminal.truncated || startOffset > terminal.baseOffset,
      eof: startOffset + text.length >= terminal.baseOffset + terminal.output.length,
      text,
    };
  }

  async function stop(id, context = {}) {
    const terminal = terminalFor(id);
    if (terminal.state !== 'running') return terminalSummary(terminal);
    terminal.state = 'stopped';
    terminal.signal = 'SIGHUP';
    terminal.endedAt = nowIso();
    try { terminal.process.kill('SIGHUP'); } catch { /* already gone */ }
    registry.recordAudit({
      type: 'operator_terminal_stopped',
      actor: cleanText(context.actor, 'dashboard', 120),
      projectId: terminal.projectId,
      sessionId: terminal.sessionId,
      summary: `Operator terminal "${terminal.title}" stopped`,
      status: 'passed',
      evidence: { terminalId: terminal.id },
    });
    return terminalSummary(terminal);
  }

  async function stopAll(reason = 'shutdown') {
    const targets = [...terminals.values()].filter((terminal) => terminal.state === 'running');
    for (const terminal of targets) {
      terminal.state = 'stopped';
      terminal.signal = 'SIGHUP';
      terminal.endedAt = nowIso();
      appendBounded(terminal, `\n[orca] terminal stopped: ${reason}\n`);
      try { terminal.process.kill('SIGHUP'); } catch { /* already gone */ }
    }
    return { stopped: targets.length };
  }

  const manager = {
    listForSession,
    start,
    get: (id) => terminalSummary(terminalFor(id)),
    writeInput,
    writeAgentMessage,
    resize,
    tail,
    stop,
    stopAll,
  };
  registry.operatorTerminals = manager;
  return manager;
}
