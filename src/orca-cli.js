#!/usr/bin/env node
// Orca's command line, for the two things done outside the MCP bridge.
//
//   doctor [--json] [--url URL]
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
// Neither command starts, stops or signals Orca.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveMcpLauncher } from './mcp-orchestrator-bootstrap.js';
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

const USAGE = `Usage:
  node ${shellQuote(path.join(ORCA_DIR, 'src', 'orca-cli.js'))} doctor [--json] [--url URL]
  node ${shellQuote(path.join(ORCA_DIR, 'src', 'orca-cli.js'))} connect <claude|codex> [--actor NAME] [--url URL] [--node PATH] [--print]`;

const CLIENT_LABELS = { claude: 'Claude Code', codex: 'Codex' };
const HTTP_TIMEOUT_MS = 5000;

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
    if (inline !== undefined) flags[key] = inline;
    else if (key === 'json' || key === 'print') flags[key] = true;
    else {
      flags[key] = argv[index + 1];
      index += 1;
    }
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

  // 2. launcher
  add('launcher', entry ? checkLauncher(entry, client) : { status: 'skip', summary: 'Not checked: nothing is registered.' });

  // 3. daemon
  const baseUrl = trimUrl(flags.url || env.ORCA_AGENT_TOOLS_BASE_URL || process.env.ORCA_AGENT_TOOLS_BASE_URL);
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

  // 5. fence, and 6. whether role scoping is enforced at all
  if (!facts) {
    add('fence', { status: 'skip', summary: 'Not checked: it needs a reachable Orca and a credential it accepts.' });
  } else if (facts.fence?.configured) {
    add('fence', { status: 'pass', summary: `ORCA_REPO_ROOTS is set; agents may work under ${(facts.fence.roots || []).join(', ')}.` });
  } else {
    add('fence', {
      status: 'warn',
      summary: `ORCA_REPO_ROOTS is not set, so agents may register any folder under ${(facts.fence?.roots || []).join(', ') || 'your home directory'}.`,
      fix: `when no lanes are running, stop Orca and start it fenced: cd ${shellQuote(ORCA_DIR)} && ORCA_REPO_ROOTS="$HOME/code" npm start`,
    });
  }
  if (facts) {
    add('api-token', facts.apiTokenConfigured
      ? { status: 'pass', summary: 'ORCA_API_TOKEN is set: only credentials Orca issued can act, each within its role.' }
      : {
        status: 'warn',
        summary: 'ORCA_API_TOKEN is not set, so every process on this machine is Orca admin and role scoping is advisory.',
        fix: `when no lanes are running, stop Orca and start it with a token: cd ${shellQuote(ORCA_DIR)} && ORCA_API_TOKEN="$(openssl rand -hex 32)" npm start`,
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
  const baseUrl = trimUrl(flags.url || process.env.ORCA_AGENT_TOOLS_BASE_URL);
  const actor = String(flags.actor || `${client}-user-config`);
  const headers = {};
  if (process.env.ORCA_API_TOKEN) headers['x-orca-token'] = process.env.ORCA_API_TOKEN;
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
    `Registered "orca" for ${label} at user scope: refresh credential ${res.json.credential?.id} (actor "${actor}"), launching ${bootstrap.nodePath}.`,
    `Restart your ${label} sessions to load it. From then on they obtain and renew their own leases; nothing needs re-running.`,
    ...(replaced.length ? [`This replaced the previous credential for actor "${actor}" (${replaced.join(', ')}); sessions still running on it must restart too.`] : []),
    ...warnings,
    `Check it any time with: ${fixCommands.doctor()}`,
  ].join('\n') + '\n');
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
if (command === 'doctor') {
  await doctor(flags);
} else if (command === 'connect') {
  await connect(rest, flags);
} else {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = command ? 2 : 0;
}
