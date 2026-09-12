#!/usr/bin/env node
// Orca's command line: everything done outside the MCP bridge.
//
//   setup --roots <dir>[,<dir>...] [--allow-home-root] [--state-dir DIR] [--no-start] [--connect claude|codex]
//       The one first-run command (src/cli-setup.js). Records the directories
//       agents may work in (the fence) in the user's Orca config file, keeps an
//       existing install's state where it is, starts Orca, and optionally
//       connects agent CLIs.
//
//   start | stop [--force] | status [--json] | logs [--lines N]
//       The daemon's lifecycle (src/cli-lifecycle.js). One daemon per machine,
//       owned by no agent session: start runs it detached, stop signals only the
//       process its instance lock proves owns the state, and refuses while
//       executors are running unless --force.
//
//   service install [--dry-run] [--no-load] [--replace] | service uninstall
//       A per-user macOS LaunchAgent for the same daemon: start at login, restart
//       after a crash.
//
//   doctor [--json] [--url URL] [--node PATH]
//       Read-only. Checks that the MCP server is registered at user scope, that its
//       launcher Node is valid, that Orca is reachable, that the client's
//       credential is live, and how the daemon is fenced. Every failed check
//       prints its fix. Exits 1 when a check fails. Writes nothing and renews
//       nothing.
//
//   connect <claude|codex> [--actor NAME] [--url URL] [--node PATH] [--print]
//       One-command setup: asks Orca for a client config (POST
//       /api/mcp/orchestrator-bootstrap, which needs workstation admin: a loopback
//       Orca with no API token, or ORCA_API_TOKEN in this command's environment)
//       and registers it through the client's own CLI at user scope. The config
//       carries a refresh credential, so the client reconnects by itself from then
//       on. --print only prints the command.
//
//   gc [--apply] [--older-than-days N] [--purge-archive --purge-older-than-days N]
//      [--state-dir DIR] [--json]
//       State retention (src/orca-gc-cli.js, docs/state-retention.md). A dry run
//       unless --apply; --apply only MOVES into the state directory's archive/,
//       refuses while a daemon owns the state directory, and holds its lock
//       while it works. Deleting from the archive needs --purge-archive AND an age.
//       It acts on the same state directory start/stop/status do.
//
// doctor, connect and gc never start, stop or signal Orca; start, stop, status,
// logs and service are the only commands that do.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { nodeRuntimeWarnings, resolveMcpLauncher } from './mcp-orchestrator-bootstrap.js';
import { inspectInstanceLock } from './instance-lock.js';
import { STATE_SOURCE_LABELS } from './orca-paths.js';
import {
  lifecycleContext,
  logs,
  resolveDaemonUrl,
  serviceInstall,
  serviceUninstall,
  start,
  status,
  stop,
} from './cli-lifecycle.js';
import { setup } from './cli-setup.js';
import { resolveApiToken } from './api-token.js';
import { GC_BOOLEAN_FLAGS, GC_USAGE, runGcCommand } from './orca-gc-cli.js';
import {
  DEFAULT_BASE_URL,
  LEASE_HEADER,
  ORCA_DIR,
  REFRESH_HEADER,
  explainNetworkError,
  fixCommands,
  networkCode,
  shellQuote,
} from './mcp-connection.js';

const CLI = `node ${shellQuote(path.join(ORCA_DIR, 'src', 'orca-cli.js'))}`;
const USAGE = `Usage:
  ${CLI} setup --roots <dir>[,<dir>...] [--allow-home-root] [--state-dir DIR] [--no-start] [--connect claude|codex]
  ${CLI} start [--port N] [--host H] [--wait SECONDS]
  ${CLI} stop [--force] [--wait SECONDS]
  ${CLI} status [--json]
  ${CLI} logs [--lines N]
  ${CLI} service install [--dry-run] [--no-load] [--replace] [--token-file PATH] [--node PATH] [--port N]
  ${CLI} service uninstall [--force]
  ${CLI} doctor [--json] [--url URL] [--node PATH]
  ${CLI} connect <claude|codex> [--actor NAME] [--url URL] [--node PATH] [--print]
  ${CLI} ${GC_USAGE}`;

const CLIENT_LABELS = { claude: 'Claude Code', codex: 'Codex' };
const HTTP_TIMEOUT_MS = 5000;

const BOOLEAN_FLAGS = new Set(['json', 'print', 'force', 'dry-run', 'allow-home-root', 'no-start', 'no-load', 'replace', ...GC_BOOLEAN_FLAGS]);
// May repeat; each value may also be a comma-separated list.
const LIST_FLAGS = new Set(['roots', 'connect']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    let value;
    if (inline !== undefined) value = inline;
    else if (BOOLEAN_FLAGS.has(key)) value = true;
    else {
      value = argv[index + 1];
      index += 1;
    }
    if (LIST_FLAGS.has(key)) (flags[key] ||= []).push(value);
    else flags[key] = value;
  }
  return { positional, flags };
}

const trimUrl = (value) => String(value || DEFAULT_BASE_URL).replace(/\/$/, '');

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const init = { method, headers: { accept: 'application/json', ...headers }, signal: controller.signal };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    let json = null;
    if (/json/i.test(contentType)) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: res.status, json, text, contentType };
  } catch (error) {
    return { networkError: error };
  } finally {
    clearTimeout(timer);
  }
}

// ---- reading client configs (never writing them) ---------------------------

function realpathOr(dir) {
  try { return fs.realpathSync(dir); } catch { return dir; }
}

function claudeConfigPath(home) {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
}

function readClaude(home, cwd) {
  const file = claudeConfigPath(home);
  let config = {};
  let error = null;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (readError) {
    if (readError.code !== 'ENOENT') error = readError.message;
  }
  const user = config.mcpServers?.orca || null;
  let local = null;
  for (const dir of new Set([cwd, realpathOr(cwd)])) {
    const entry = config.projects?.[dir]?.mcpServers?.orca;
    if (entry) {
      local = { dir, entry };
      break;
    }
  }
  return { file, user, local, error };
}

// Just enough TOML to read the [mcp_servers.orca] entry `codex mcp add` writes:
// strings, arrays of strings, and env as a table or an inline table.
function parseTomlValue(text) {
  let index = 0;
  const skip = () => { while (index < text.length && /\s/.test(text[index])) index += 1; };
  const readString = () => {
    const quote = text[index];
    index += 1;
    let out = '';
    while (index < text.length && text[index] !== quote) {
      if (quote === '"' && text[index] === '\\') {
        const next = text[index + 1];
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        index += 2;
      } else {
        out += text[index];
        index += 1;
      }
    }
    index += 1;
    return out;
  };
  const readValue = () => {
    skip();
    const char = text[index];
    if (char === '"' || char === "'") return readString();
    if (char === '[' || char === '{') {
      const isArray = char === '[';
      const close = isArray ? ']' : '}';
      const out = isArray ? [] : {};
      index += 1;
      for (;;) {
        skip();
        if (index >= text.length || text[index] === close) {
          index += 1;
          return out;
        }
        if (isArray) {
          out.push(readValue());
        } else {
          const start = index;
          while (index < text.length && text[index] !== '=') index += 1;
          const key = text.slice(start, index).trim().replace(/^"|"$/g, '');
          index += 1;
          out[key] = readValue();
        }
        skip();
        if (text[index] === ',') index += 1;
      }
    }
    const start = index;
    while (index < text.length && !/[,\]}#]/.test(text[index])) index += 1;
    return text.slice(start, index).trim();
  };
  return readValue();
}

function readCodex(home) {
  const file = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { file, entry: null, error: error.code === 'ENOENT' ? null : error.message };
  }
  const entry = { env: {} };
  let found = false;
  let table = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1].replace(/["\s]/g, '');
      continue;
    }
    if (table !== 'mcp_servers.orca' && table !== 'mcp_servers.orca.env') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
    const value = parseTomlValue(line.slice(eq + 1).trim());
    found = true;
    if (table === 'mcp_servers.orca.env') entry.env[key] = String(value);
    else if (key === 'env' && value && typeof value === 'object' && !Array.isArray(value)) Object.assign(entry.env, value);
    else entry[key] = value;
  }
  return { file, entry: found ? entry : null, error: null };
}

function which(command) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

// ---- doctor -------------------------------------------------------------------

function checkLauncher(entry, client) {
  const command = String(entry.command || '');
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const bridge = args.find((arg) => /mcp-server\.js$/.test(arg)) || args[0] || '';
  let nodePath = command;
  const notes = [];
  if (command && !/[\\/]/.test(command)) {
    nodePath = which(command);
    if (!nodePath) {
      return { status: 'fail', summary: `The registered command "${command}" is not on PATH, so the client cannot start Orca's bridge.`, fix: fixCommands.connect(client) };
    }
    notes.push(`The entry runs "${command}" from PATH (now ${nodePath}); a PATH change can break it.`);
  }
  try {
    const { runtime, serverPath } = resolveMcpLauncher({ nodePath, serverPath: bridge });
    notes.push(...(runtime.warnings || []));
    const summary = `Launches ${nodePath} (${runtime.version}) with ${serverPath}.`;
    if (!notes.length) return { status: 'pass', summary };
    return { status: 'warn', summary: `${summary} ${notes.join(' ')}`, fix: fixCommands.connect(client, '--node <a Node path you maintain>') };
  } catch (error) {
    return { status: 'fail', summary: `The registered launcher cannot start Orca's bridge: ${error?.message || error}`, fix: fixCommands.connect(client) };
  }
}

function daemonNetworkCheck(error, baseUrl, client) {
  const code = networkCode(error);
  if (code === 'ECONNREFUSED') {
    return { status: 'fail', summary: `Orca is not running at ${baseUrl}: the connection was refused, so nothing is listening there.`, fix: fixCommands.start() };
  }
  if (code === 'TIMEOUT') {
    return { status: 'fail', summary: `Orca at ${baseUrl} did not answer within ${HTTP_TIMEOUT_MS / 1000} s.`, fix: `check the terminal or log Orca runs in; if it is hung and no lanes are running, stop it and run: ${fixCommands.start()}` };
  }
  const firstLine = explainNetworkError(error, { baseUrl, client }).split('\n')[0];
  return { status: 'fail', summary: firstLine, fix: code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? fixCommands.connect(client) : fixCommands.start() };
}

async function doctor(flags) {
  const home = os.homedir();
  const cwd = process.cwd();
  const checks = [];
  const add = (id, result) => checks.push({ id, ...result });

  // 1. registration, at user scope
  const claude = readClaude(home, cwd);
  const codex = readCodex(home);
  const registered = [];
  if (claude.user) registered.push({ client: 'claude', label: `Claude Code (${claude.file})`, entry: claude.user });
  if (codex.entry) registered.push({ client: 'codex', label: `Codex (${codex.file})`, entry: codex.entry });
  const unreadable = [claude.error && `${claude.file}: ${claude.error}`, codex.error && `${codex.file}: ${codex.error}`].filter(Boolean);
  if (!registered.length) {
    add('registration', {
      status: 'fail',
      summary: `No "orca" MCP server is registered at user scope for Claude Code (${claude.file}) or Codex (${codex.file}).${claude.local ? ` There is only a local-scope entry, for ${claude.local.dir}.` : ''}${unreadable.length ? ` Unreadable: ${unreadable.join('; ')}.` : ''}`,
      fix: fixCommands.connect('claude'),
    });
  } else if (claude.local) {
    add('registration', {
      status: 'warn',
      summary: `Registered at user scope for ${registered.map((item) => item.label).join(' and ')}, but a local-scope "orca" entry for ${claude.local.dir} overrides it in that directory.`,
      fix: `cd ${shellQuote(claude.local.dir)} && claude mcp remove orca -s local`,
    });
  } else {
    add('registration', { status: 'pass', summary: `Registered at user scope for ${registered.map((item) => item.label).join(' and ')}.` });
  }
  const primary = registered[0] || null;
  const client = primary?.client || 'claude';
  const entry = primary?.entry || null;
  const env = entry?.env || {};

  // 2. launcher — every registered client, not just the first: a second client
  // can point at a different Node, and only checking one hides that.
  if (!registered.length) {
    add('launcher', { status: 'skip', summary: 'Not checked: nothing is registered.' });
  } else {
    for (const item of registered) {
      add(registered.length > 1 ? `launcher:${item.client}` : 'launcher', checkLauncher(item.entry, item.client));
    }
  }

  // 2b. the Node Orca would BAKE IN next. `connect` and `service install` write
  // a Node path into files Orca does not own — a client's MCP config, and a
  // LaunchAgent that starts Orca at every login. Orca installs and manages no
  // toolchain; what it owes the user is to say when the Node it found belongs to
  // something else, BEFORE it is written down and long before it silently stops
  // resolving. `--node PATH` asks the same question about a Node you are about
  // to pass to connect or service install.
  const proposed = flags.node === undefined ? null : String(flags.node);
  if (proposed !== null && !proposed.trim()) {
    add('node', { status: 'fail', summary: '--node needs a path.', fix: `${CLI} doctor --node /path/to/node` });
  } else {
    // Both paths that get written down: what connect/service install choose, and
    // this process's own Node. They are normally the same; if they ever diverge,
    // reporting only one would hide the worse of the two.
    const chosen = (() => {
      try { return resolveMcpLauncher({}).runtime.nodePath; } catch { return process.execPath; }
    })();
    const candidates = proposed ? [path.resolve(proposed.trim())] : [...new Set([chosen, process.execPath])];
    const candidate = candidates[0];
    const who = proposed ? `The Node you asked about, ${candidate},` : `The Node connect and service install would write down, ${candidate},`;
    const notes = [...new Set(candidates.flatMap((item) => nodeRuntimeWarnings(item)))];
    add('node', notes.length
      ? {
        status: 'warn',
        summary: `${notes.join(' ')} Orca keeps running on it either way; what breaks is what Orca writes down — ${fixCommands.connect(client)} bakes it into your client's MCP config, and \`${CLI} service install\` bakes it into the LaunchAgent that starts Orca at every login, where nothing is watching when it stops resolving.`,
        fix: `point both at a Node you maintain: ${fixCommands.connect(client, '--node /path/to/node')} and ${CLI} service install --node /path/to/node --replace`,
      }
      : { status: 'pass', summary: `${who} is not inside another tool's directory or one installed Node version, so connect and service install can write it down safely.` });
  }

  // 3. daemon
  //
  // Two URLs matter and they are not always the same one. `owned` is the daemon
  // this installation runs — what start/stop/status act on, found through the
  // state directory's instance lock. `baseUrl` is what the CLIENT is wired to.
  // doctor checks the client's, because that is the connection under test, but
  // it must say when the two disagree: reporting a healthy daemon that is not
  // the one you manage is a true answer to the wrong question, and it is how
  // this check previously printed "Nothing is failing" about someone else's
  // daemon while the reader's own was misconfigured.
  const owned = resolveDaemonUrl(
    { ...flags, url: undefined },
    { env: { ...process.env, ORCA_AGENT_TOOLS_BASE_URL: '' }, home },
  );
  const baseUrl = trimUrl(flags.url || env.ORCA_AGENT_TOOLS_BASE_URL || process.env.ORCA_AGENT_TOOLS_BASE_URL || owned.url);
  const health = await httpJson(`${baseUrl}/api/health`);
  let daemonUp = false;
  if (health.networkError) {
    add('daemon', daemonNetworkCheck(health.networkError, baseUrl, client));
  } else if (health.status === 503) {
    add('daemon', { status: 'warn', summary: `Orca at ${baseUrl} is starting or shutting down (503).`, fix: 'run this doctor again in a few seconds' });
  } else if (health.status !== 200 || health.json?.status !== 'ok') {
    add('daemon', {
      status: 'fail',
      summary: `Something answered at ${baseUrl} (HTTP ${health.status}, ${health.contentType || 'no content type'}), but it is not Orca.`,
      fix: fixCommands.connect(client, '--url <the URL Orca printed when it started>'),
    });
  } else {
    daemonUp = true;
    add('daemon', { status: 'pass', summary: `Orca is answering at ${baseUrl}.` });
  }

  // 3b. is the client wired to the daemon this machine actually manages?
  const sameUrl = (a, b) => String(a).replace(/\/$/, '') === String(b).replace(/\/$/, '');
  if (!flags.url && owned.stateDir && !sameUrl(baseUrl, owned.url)) {
    add('target', {
      status: 'warn',
      summary: `${client === 'claude' ? 'Claude Code' : 'Codex'} is wired to Orca at ${baseUrl}, but the daemon this machine manages is ${owned.url} (${owned.source}; ${owned.running ? 'running now' : 'not running'}). start, stop, status and gc act on ${owned.stateDir}, so the checks above describe a different daemon than the one you control.`,
      fix: `point the client at your own daemon: ${fixCommands.connect(client)}   (it now targets ${owned.url} by default)`,
    });
  } else if (owned.stateDir) {
    add('target', { status: 'pass', summary: `The checks above describe the daemon this machine manages (${owned.url}, state in ${owned.stateDir}).` });
  }

  // 4. credential, plus the daemon facts the last two checks read
  let facts = null;
  if (!daemonUp) {
    add('credential', { status: 'skip', summary: `Not checked: Orca is not reachable at ${baseUrl}.` });
  } else if (!entry) {
    add('credential', { status: 'skip', summary: 'Not checked: nothing is registered.' });
  } else {
    const refresh = env.ORCA_REFRESH_TOKEN || '';
    const lease = env.ORCA_TOOL_LEASE_TOKEN || '';
    if (!refresh && !lease) {
      const probe = await httpJson(`${baseUrl}/api/agent-tools/doctor`);
      if (probe.status === 200) {
        facts = probe.json?.daemon || null;
        add('credential', {
          status: 'warn',
          summary: 'The registered entry carries no credential. It works only because this Orca has no ORCA_API_TOKEN, as the shared "dashboard" identity, so every session re-registering gets a new orchestrator record.',
          fix: fixCommands.connect(client),
        });
      } else {
        add('credential', { status: 'fail', summary: `The registered entry carries no credential, and Orca at ${baseUrl} requires one (HTTP ${probe.status}).`, fix: fixCommands.connect(client) });
      }
    } else {
      const res = await httpJson(`${baseUrl}/api/agent-tools/doctor`, { headers: refresh ? { [REFRESH_HEADER]: refresh } : { [LEASE_HEADER]: lease } });
      const credential = res.json?.credential;
      if (res.status === 200 && credential) {
        facts = res.json.daemon || null;
        add('credential', refresh
          ? { status: 'pass', summary: `Refresh credential ${credential.id} (actor "${credential.actor}") is live. This client obtains its own leases; they renew while used and are replaced by the bridge after they lapse.` }
          : {
            status: 'warn',
            summary: `The entry carries one fixed lease (${credential.id}, actor "${credential.actor}", expires ${credential.expiresAt}) and no refresh credential. It renews while used, but once it lapses this client cannot recover by itself.`,
            fix: fixCommands.connect(client),
          });
      } else {
        const reason = res.networkError ? explainNetworkError(res.networkError, { baseUrl, client }).split('\n')[0] : (res.json?.error || `HTTP ${res.status}`);
        add('credential', {
          status: 'fail',
          summary: `Orca refused the registered entry's ${refresh ? 'refresh credential' : 'lease'}: ${reason}`,
          fix: `${fixCommands.connect(client)} — then restart your ${CLIENT_LABELS[client]} sessions`,
        });
      }
    }
  }

  // 5. fence: the running daemon's own view when it can be read (that is what it
  // enforces), else what this machine's config resolves to.
  let local = null;
  try { local = lifecycleContext({}); } catch (error) { add('state', { status: 'fail', summary: error.message, fix: 'set ORCA_STATE_DIR / ORCA_CONFIG_DIR to absolute paths, or unset them' }); }
  const daemonFence = facts?.fence?.status ? facts.fence : null;
  const fence = daemonFence || local?.fence || null;
  if (fence) {
    const where = daemonFence ? '' : ` (read from ${fence.source === 'ORCA_REPO_ROOTS' ? 'ORCA_REPO_ROOTS in this environment' : fence.configPath}: the running daemon's own view could not be read)`;
    if (fence.status !== 'configured') {
      add('fence', { status: 'fail', summary: `${fence.summary}${where}`, fix: fence.fix });
    } else if (fence.homeWide) {
      add('fence', { status: 'warn', summary: `${fence.summary}${where} ${fence.warnings.join(' ')}`, fix: fixCommands.setup() });
    } else {
      add('fence', { status: 'pass', summary: `${fence.summary}${where}` });
    }
  }

  // 6. the state directory start, stop and status act on, and who owns it
  if (local) {
    let owner = null;
    try { owner = inspectInstanceLock(local.state.dir); } catch { owner = null; }
    const label = STATE_SOURCE_LABELS[local.state.source] || local.state.source;
    const realOr = (dir) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
    if (facts?.stateDir && realOr(facts.stateDir) !== realOr(local.state.dir)) {
      add('state', {
        status: 'warn',
        summary: `The daemon at ${baseUrl} keeps its state in ${facts.stateDir}, but this machine resolves ${local.state.dir} (${label}), which start, stop and status act on.`,
        fix: `${fixCommands.setup(['<your roots>'])} --state-dir ${shellQuote(facts.stateDir)}   (or set ORCA_STATE_DIR)`,
      });
    } else {
      add('state', { status: 'pass', summary: `State in ${local.state.dir} (${label}); ${owner?.held && owner.reason === 'running' ? `owned by the running daemon, pid ${owner.holder.pid}` : 'no daemon owns it right now'}.` });
    }
  }

  // 7. whether role scoping is enforced at all
  if (facts) {
    add('api-token', facts.apiTokenConfigured
      ? { status: 'pass', summary: 'ORCA_API_TOKEN is set: only credentials Orca issued can act, each within its role.' }
      : {
        status: 'warn',
        summary: 'ORCA_API_TOKEN is not set, so every process on this machine is Orca admin and role scoping is advisory.',
        fix: `when no executors are running: ${fixCommands.stop()}, then ORCA_API_TOKEN="$(openssl rand -hex 32)" ${fixCommands.start()} (keep the token out of git and plists)`,
      });
  }

  const failed = checks.some((check) => check.status === 'fail');
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: !failed, baseUrl, checks }, null, 2)}\n`);
  } else {
    const marks = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };
    const out = [`Orca doctor (${baseUrl})`];
    for (const check of checks) {
      out.push(`  ${marks[check.status] || check.status}  ${check.id.padEnd(12)} ${check.summary}`);
      if (check.fix) out.push(`        ${' '.repeat(12)} fix: ${check.fix}`);
    }
    out.push(failed ? 'Fix the FAIL lines above, then run this again.' : 'Nothing is failing.');
    process.stdout.write(`${out.join('\n')}\n`);
  }
  process.exitCode = failed ? 1 : 0;
}

// ---- connect ------------------------------------------------------------------

async function connect(positional, flags) {
  const client = positional[0];
  if (!CLIENT_LABELS[client]) {
    process.stderr.write(`connect needs a client: claude or codex.\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const label = CLIENT_LABELS[client];
  // The daemon this installation owns, not whatever answers on the default port:
  // the bootstrap below replaces the credential for this actor on whichever
  // daemon serves it, so aiming at the wrong one breaks that one's clients.
  const target = resolveDaemonUrl(flags);
  const baseUrl = trimUrl(target.url);
  const actor = String(flags.actor || `${client}-user-config`);
  const headers = {};
  const apiToken = resolveApiToken(process.env);
  if (apiToken.error) {
    process.stderr.write(`${apiToken.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (apiToken.token) headers['x-orca-token'] = apiToken.token;
  const body = { actor };
  if (flags.node) body.nodePath = String(flags.node);
  const res = await httpJson(`${baseUrl}/api/mcp/orchestrator-bootstrap`, { method: 'POST', headers, body });
  if (res.networkError) {
    process.stderr.write(`${explainNetworkError(res.networkError, { baseUrl, client })}\n`);
    process.exitCode = 1;
    return;
  }
  if (res.status === 401 || res.status === 403) {
    process.stderr.write([
      `Orca at ${baseUrl} refused to issue a client config (HTTP ${res.status}: ${res.json?.error || 'no reason given'}).`,
      'connect needs workstation admin: run it on the machine Orca runs on, and if Orca has an API token, with ORCA_API_TOKEN set to it:',
      `  ORCA_API_TOKEN=<Orca's API token> ${fixCommands.connect(client)}`,
    ].join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  const bootstrap = res.json?.bootstrap;
  const spec = bootstrap?.clients?.[client === 'claude' ? 'claudeCli' : 'codexCli'];
  if (res.status !== 201 || !spec?.argv) {
    process.stderr.write(`Orca at ${baseUrl} could not issue a client config (HTTP ${res.status}): ${res.json?.error || res.text?.slice(0, 200) || 'no reason given'}\n`);
    process.exitCode = 1;
    return;
  }
  const warnings = (bootstrap.runtime?.warnings || []).map((warning) => `Warning: ${warning}`);
  if (flags.print) {
    process.stdout.write(`${[spec.command, ...warnings].join('\n')}\n`);
    return;
  }
  const removed = spawnSync(spec.binary, spec.removeArgv, { encoding: 'utf8' });
  if (removed.error?.code === 'ENOENT') {
    process.stderr.write(`${spec.binary} is not on PATH. Run this yourself, then restart your ${label} sessions:\n${spec.command}\n`);
    process.exitCode = 1;
    return;
  }
  const added = spawnSync(spec.binary, spec.argv, { encoding: 'utf8' });
  if (added.error || added.status !== 0) {
    const why = added.error?.message || String(added.stderr || added.stdout || '').trim() || `exit ${added.status}`;
    process.stderr.write(`${spec.binary} mcp add failed: ${why}\nRun it yourself, then restart your ${label} sessions:\n${spec.command}\n`);
    process.exitCode = 1;
    return;
  }
  const replaced = bootstrap.leaseLifecycle?.replacedCredentialIds || [];
  process.stdout.write([
    `Registered "orca" for ${label} at user scope against Orca at ${baseUrl} (${target.source}): refresh credential ${res.json.credential?.id} (actor "${actor}"), launching ${bootstrap.nodePath}.`,
    `Restart your ${label} sessions to load it. From then on they obtain and renew their own leases; nothing needs re-running.`,
    ...(replaced.length ? [`This replaced the previous credential for actor "${actor}" (${replaced.join(', ')}); sessions still running on it must restart too.`] : []),
    ...warnings,
    `Check it any time with: ${fixCommands.doctor()}`,
  ].join('\n') + '\n');
}

const out = {
  log: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};
const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
const connectClient = async (client) => {
  process.exitCode = 0;
  await connect([client], flags);
  return process.exitCode || 0;
};
const COMMANDS = {
  doctor: () => doctor(flags),
  connect: () => connect(rest, flags),
  setup: () => setup(flags, out, { start, connect: connectClient }),
  start: () => start(flags, out),
  stop: () => stop(flags, out),
  status: () => status(flags, out),
  logs: () => logs(flags, out),
  service: () => {
    if (rest[0] === 'install') return serviceInstall(flags, out);
    if (rest[0] === 'uninstall') return serviceUninstall(flags, out);
    out.err(`service needs install or uninstall.\n${USAGE}`);
    return 2;
  },
  gc: () => runGcCommand(flags),
};
if (!command) {
  process.stdout.write(`${USAGE}\n`);
} else if (!Object.hasOwn(COMMANDS, command)) {
  process.stderr.write(`Unknown command "${command}".\n${USAGE}\n`);
  process.exitCode = 2;
} else {
  try {
    const code = await COMMANDS[command]();
    if (typeof code === 'number') process.exitCode = code;
  } catch (error) {
    out.err(`orca-cli ${command}: ${error?.message || error}`);
    process.exitCode = 2;
  }
}
