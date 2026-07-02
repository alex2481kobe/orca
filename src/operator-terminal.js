import { randomUUID } from 'node:crypto';
import pty from '@lydell/node-pty';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_TERMINALS_PER_SESSION = 4;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_RETAINED_CHARS = 256 * 1024;
const TERMINAL_TAIL_DEFAULT_CHARS = 32 * 1024;
const TERMINAL_TAIL_MAX_CHARS = 128 * 1024;

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

function buildTerminalEnv(session, shellPath) {
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
    const logPath = path.join(artifactDir, 'terminal.log');

    const cols = cleanDimension(body.cols, 100, 20, 240);
    const rows = cleanDimension(body.rows, 28, 8, 80);
    const term = pty.spawn(launch.binary, launch.args, {
      cwd: startCwd,
      env: buildTerminalEnv(session, shellPath),
      name: 'xterm-256color',
      cols,
      rows,
      encoding: 'utf8',
    });

    const title = cleanText(body.title, 'Command tab', 80);
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
    };
    terminals.set(id, terminal);

    appendBounded(terminal, [
      `Orca command terminal (${terminal.wrapper})`,
      `Shell: ${terminal.shellName}`,
      `Cwd: ${startCwd}`,
      `Started: ${createdAt}`,
      '',
    ].join('\n'));
    await fs.writeFile(logPath, terminal.output);

    const forward = (chunk) => {
      const text = String(chunk || '');
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
    if (!context.raw) {
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

  return {
    listForSession,
    start,
    get: (id) => terminalSummary(terminalFor(id)),
    writeInput,
    resize,
    tail,
    stop,
    stopAll,
  };
}
