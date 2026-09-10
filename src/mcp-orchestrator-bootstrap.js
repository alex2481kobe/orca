// Orchestrator MCP bootstrap builder.
//
// Lets an EXTERNAL MCP client (Claude Code, Codex, Claude Desktop, any other) act
// as an Orca orchestrator. The same hand-rolled stdio MCP server that Orca injects
// into its own lanes (src/mcp-server.js) is pointed at by the client's MCP config,
// authenticated with a scoped orchestrator tool lease (never the full API token).
//
// This produces ready-to-paste config for each client plus the env block, so the
// agent gets Orca's orchestrator toolset (register, spawn and monitor executor
// lanes, approvals, evidence, audit) as native MCP tools. Open the dashboard URL
// in the desktop app's in-app browser for the visual surface, and wire the MCP
// config for tool access.
//
// Two halves. resolveMcpLauncher() checks the launcher against the filesystem and
// the runtime it names; callers that mint a lease must run it FIRST (see
// createOrchestratorMcpBootstrap). buildOrchestratorMcpConfigs() is pure
// formatting and touches nothing.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Absolute path to the stdio MCP server the client will spawn. Resolved the
// same way the lane executor-factory resolves it, so source and packaged builds
// both point at the right file.
export const MCP_SERVER_PATH = fileURLToPath(new URL('./mcp-server.js', import.meta.url));

// Oldest Node the bridge supports. Keep in step with package.json "engines".
export const MIN_BRIDGE_NODE_VERSION = '18.18.0';

const SERVER_KEY = 'orca';
// `claude mcp add` defaults to LOCAL scope: the server exists only in the
// directory the command ran in. Codex has no scope flag (it writes the user
// config), so this is Claude-only.
const CLAUDE_SCOPE_FLAGS = '-s user';
const NODE_BINARY = process.platform === 'win32' ? 'node.exe' : 'node';
const VERSION_PROBE_TIMEOUT_MS = 5000;
// A path segment carrying a release number (v24.14.1, 25.6.1,
// node-v20.11.1-darwin-arm64): the file lives inside one installed version and
// goes away with it.
const VERSION_IN_SEGMENT = /(?:^|[^\w.])(v?\d+\.\d+\.\d+)(?![\w.])/;
// Other agent tools' private directories under HOME. A Node inside one belongs to
// that tool, which can update or delete it without telling anyone.
const FOREIGN_TOOL_DIRS = [
  ['.codex', 'Codex'],
  ['.claude', 'Claude Code'],
];

function unprocessable(message) {
  return { status: 422, message };
}

function tomlString(value) {
  // TOML basic-string escaping for the values we emit (paths, tokens, URLs).
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildEnv({ baseUrl, leaseToken, role, projectId, sessionId }) {
  const env = {
    ORCA_AGENT_TOOLS_BASE_URL: String(baseUrl || ''),
    ORCA_TOOL_LEASE_TOKEN: String(leaseToken || ''),
    ORCA_ROLE: String(role || 'orchestrator'),
  };
  // Default path params let the agent omit ids on every call; it can still
  // target other sessions/projects explicitly when its lease is broad.
  if (projectId) env.ORCA_PROJECT_ID = String(projectId);
  if (sessionId) env.ORCA_SESSION_ID = String(sessionId);
  return env;
}

function looksAbsolutePath(value) {
  return path.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function validateLauncherPath(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw unprocessable(`${label} is required.`);
  }
  if (/[\x00-\x1f\x7f]/.test(text)) {
    throw unprocessable(`${label} contains control characters.`);
  }
  if (!looksAbsolutePath(text)) {
    throw unprocessable(`${label} must be an absolute executable path.`);
  }
  return text;
}

function realpathOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function inspectExecutable(file, label) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw unprocessable(`${label} "${file}" does not exist.`);
    }
    throw unprocessable(`${label} "${file}" cannot be read (${error.code || error.message}).`);
  }
  if (!stat.isFile()) {
    throw unprocessable(`${label} "${file}" is not a file.`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      throw unprocessable(`${label} "${file}" is not executable.`);
    }
  }
  return fs.realpathSync(file);
}

// The --version probe gets the daemon's environment minus Orca's own credentials:
// version-manager shims need PATH, HOME and their own variables to answer at all,
// and the API token and lease tokens are none of their business.
function probeEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_')));
}

function probeNodeVersion(file, label) {
  const run = spawnSync(file, ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_PROBE_TIMEOUT_MS,
    env: probeEnv(),
    windowsHide: true,
  });
  if (run.error) {
    const cause = run.error.code === 'ETIMEDOUT'
      ? `no answer within ${VERSION_PROBE_TIMEOUT_MS / 1000}s`
      : (run.error.code || run.error.message);
    throw unprocessable(`${label} "${file}" did not report a Node.js version (${cause}).`);
  }
  const firstLine = String(run.stdout || '').trim().split('\n')[0].trim();
  const match = run.status === 0 ? /^v(\d+)\.(\d+)\.(\d+)$/.exec(firstLine) : null;
  if (!match) {
    // Say why: a binary that dies before printing (a Homebrew node whose shared
    // library an upgrade removed aborts in dyld) is otherwise indistinguishable
    // from one that is not Node at all.
    const printed = firstLine ? JSON.stringify(firstLine.slice(0, 60)) : 'nothing';
    const ended = run.signal ? `, killed by ${run.signal}` : (run.status ? `, exit ${run.status}` : '');
    const stderrLine = String(run.stderr || '').trim().split('\n')[0].trim();
    const stderr = stderrLine ? `; stderr: ${JSON.stringify(stderrLine.slice(0, 160))}` : '';
    throw unprocessable(`${label} "${file}" did not report a Node.js version (--version printed ${printed}${ended}${stderr}).`);
  }
  return match.slice(1, 4).map(Number);
}

function assertSupportedNode(file, version, label) {
  const minimum = MIN_BRIDGE_NODE_VERSION.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (version[index] > minimum[index]) return;
    if (version[index] < minimum[index]) {
      throw unprocessable(`${label} "${file}" is Node v${version.join('.')}; Orca's MCP bridge needs Node >=${MIN_BRIDGE_NODE_VERSION}.`);
    }
  }
}

// The daemon's own Node, named the way its PATH names it. process.execPath is
// always the resolved binary, which under a version manager or Homebrew is a
// version-pinned path (.../node-versions/v24.14.1/..., .../Cellar/node/25.6.1/...)
// that breaks on the next upgrade. The first PATH entry resolving to the same
// binary is the alias the operator actually runs, and it follows upgrades.
function findPathAlias(execPath) {
  const target = realpathOrNull(execPath);
  if (!target) return null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || /[\x00-\x1f\x7f]/.test(dir)) continue;
    const candidate = path.join(dir, NODE_BINARY);
    if (realpathOrNull(candidate) === target) return candidate;
  }
  return null;
}

function runtimeWarnings(nodePath) {
  const warnings = [];
  const pinned = nodePath.split(/[\\/]+/).map((segment) => VERSION_IN_SEGMENT.exec(segment)).find(Boolean);
  if (pinned) {
    warnings.push(`${nodePath} is inside one installed Node version (${pinned[1]}). It stops working when that version is removed or upgraded away. Pass "nodePath" with a version-independent path you maintain, such as your version manager's default alias or your package manager's bin link.`);
  }
  const home = os.homedir();
  for (const [dir, owner] of FOREIGN_TOOL_DIRS) {
    const root = path.join(home, dir);
    const relative = path.relative(root, nodePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      warnings.push(`${nodePath} is inside ${owner}'s private directory (${root}). ${owner} can update or remove that Node without notice, and this config then stops starting. Prefer a Node you install and maintain yourself.`);
    }
  }
  return warnings;
}

// Choose and check the Node + bridge pair a client config will launch. Throws
// (422 for a bad nodePath) and changes nothing. An explicit nodePath is kept
// exactly as given: an alias stays an alias, so the config follows it when it is
// repointed. Without one, the daemon's own Node is named through its PATH alias
// when it has one. Orca never installs Node or picks an unrelated runtime.
export function resolveMcpLauncher({ nodePath = null, serverPath = MCP_SERVER_PATH } = {}) {
  const bridge = validateLauncherPath(serverPath || MCP_SERVER_PATH, 'serverPath');
  if (!fs.existsSync(bridge)) {
    throw { status: 500, message: `Orca's MCP bridge is missing at ${bridge}; this Orca installation is incomplete.` };
  }
  let runtime;
  if (nodePath) {
    const chosen = validateLauncherPath(nodePath, 'nodePath');
    const realPath = inspectExecutable(chosen, 'nodePath');
    const version = probeNodeVersion(chosen, 'nodePath');
    assertSupportedNode(chosen, version, 'nodePath');
    runtime = { nodePath: chosen, source: 'explicit', realPath, version: `v${version.join('.')}` };
  } else {
    const alias = findPathAlias(process.execPath);
    const chosen = validateLauncherPath(alias || process.execPath, 'nodePath');
    runtime = {
      nodePath: chosen,
      source: alias && alias !== process.execPath ? 'path-alias' : 'daemon-runtime',
      realPath: realpathOrNull(process.execPath) || process.execPath,
      version: process.version,
    };
  }
  runtime.warnings = runtimeWarnings(runtime.nodePath);
  return { runtime, serverPath: bridge };
}

// Claude Desktop reads ~/Library/Application Support/Claude/claude_desktop_config.json
// with the standard mcpServers shape (command/args/env).
function buildClaudeDesktopConfig({ launcher, env }) {
  return {
    mcpServers: {
      [SERVER_KEY]: {
        command: launcher.command,
        args: launcher.args,
        env,
      },
    },
  };
}

// Codex app reads ~/.codex/config.toml with [mcp_servers.<name>] tables.
function buildCodexConfigToml({ launcher, env }) {
  const argsToml = launcher.args.map((a) => tomlString(a)).join(', ');
  const lines = [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(launcher.command)}`,
    `args = [${argsToml}]`,
    '',
    `[mcp_servers.${SERVER_KEY}.env]`,
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key} = ${tomlString(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

// Shell-quote a value for a copy-paste command line (single-quote unless safe).
function shArg(value) {
  const str = String(value);
  return /^[A-Za-z0-9_./:=-]+$/.test(str) ? str : `'${str.replace(/'/g, `'\\''`)}'`;
}

// `claude mcp add` / `codex mcp add` one-liners, the simplest connect path for
// the CLI clients. Claude Code passes env as repeated `-e K=V`, Codex CLI as
// repeated `--env K=V`.
function buildCliCommand(binary, scopeFlags, envFlag, launcher, env) {
  const envFlags = Object.entries(env).map(([k, v]) => `${envFlag} ${shArg(`${k}=${v}`)}`).join(' ');
  const launch = [launcher.command, ...launcher.args].map(shArg).join(' ');
  const scope = scopeFlags ? `${scopeFlags} ` : '';
  return `${binary} mcp add ${scope}${SERVER_KEY} ${envFlags} -- ${launch}`;
}

function buildClientConfigs(launcher, env) {
  const claudeDesktop = buildClaudeDesktopConfig({ launcher, env });
  const claudeCommand = buildCliCommand('claude', CLAUDE_SCOPE_FLAGS, '-e', launcher, env);
  const codexCommand = buildCliCommand('codex', '', '--env', launcher, env);
  return {
    claudeCli: {
      label: 'Claude Code CLI',
      merge: 'Run this once, from any directory, then restart your session. It registers the "orca" MCP server for Claude Code at user scope, so Orca is available in every directory.',
      command: claudeCommand,
      snippet: claudeCommand,
    },
    codexCli: {
      label: 'Codex CLI',
      merge: 'Run this once, from any directory, then restart your session. It registers the "orca" MCP server in your Codex user config (~/.codex/config.toml, or $CODEX_HOME/config.toml); Codex has no scope flag.',
      command: codexCommand,
      snippet: codexCommand,
    },
    claudeDesktop: {
      label: 'Claude Desktop',
      configPath: '~/Library/Application Support/Claude/claude_desktop_config.json',
      merge: 'Merge the "orca" entry into the existing mcpServers object.',
      config: claudeDesktop,
      snippet: JSON.stringify(claudeDesktop, null, 2),
    },
    codex: {
      label: 'Codex app',
      configPath: '~/.codex/config.toml',
      merge: 'Append these tables to your Codex config.toml.',
      snippet: buildCodexConfigToml({ launcher, env }),
    },
    generic: {
      label: 'Generic MCP client',
      merge: 'Use this mcpServers map directly.',
      config: claudeDesktop,
      snippet: JSON.stringify(claudeDesktop, null, 2),
    },
  };
}

const RUNTIME_SOURCE_TEXT = {
  explicit: 'the nodePath you selected, kept exactly as given',
  'path-alias': 'the Node this Orca daemon runs on, named by its PATH entry instead of its version-pinned install path',
  'daemon-runtime': 'the Node this Orca daemon runs on; no PATH entry names it, so this is its install path',
};

function runtimeInstructions(runtime, nodePath) {
  if (!runtime) return [];
  const target = runtime.realPath && runtime.realPath !== nodePath ? `, currently resolving to ${runtime.realPath}` : '';
  const how = RUNTIME_SOURCE_TEXT[runtime.source] || runtime.source;
  return [
    `Node for these configs: ${nodePath} (${runtime.version}${target}). This is ${how}. To choose another, pass "nodePath" in the bootstrap request.`,
    ...(runtime.warnings || []).map((warning) => `Warning: ${warning}`),
  ];
}

function leaseInstructions(lease) {
  if (!lease) {
    return [
      'The lease in this config expires and nothing renews it: 12 hours unless the bootstrap request set "ttlMs", 24 hours at most. When calls fail with "Tool lease has expired.", mint a new bootstrap, replace the token in this config, and restart the client session. Minting again with the same actor revokes the previous lease.',
    ];
  }
  const lines = [
    `This lease (${lease.id}) expires at ${lease.expiresAt}. Nothing renews it: polling and tool calls keep your orchestrator record fresh but never extend the lease. Bootstrap mints 12 hours unless the request sets "ttlMs", and 24 hours is the maximum. After it expires every call fails with "Tool lease has expired."; mint a new bootstrap, put the new token in this config, and restart the client session.`,
    `Minting another bootstrap with actor "${lease.actor}" for the same project and session revokes this lease immediately, and any client still using it starts failing with "Tool lease has been revoked.". Give each separate client configuration its own actor. A bootstrap request that is refused (a bad nodePath, say) changes no lease.`,
  ];
  const replaced = lease.replacedLeaseIds || [];
  if (replaced.length) {
    const noun = replaced.length === 1 ? 'lease' : 'leases';
    lines.push(`This bootstrap revoked ${replaced.length} earlier ${noun} held by actor "${lease.actor}" for the same scope: ${replaced.join(', ')}. Clients configured with ${replaced.length === 1 ? 'that token' : 'those tokens'} now fail with "Tool lease has been revoked."; give them this config.`);
  }
  return lines;
}

// Build every client config from one lease. Pure: it validates the launcher
// strings but touches no file. `nodePath` defaults to the running node binary;
// createOrchestratorMcpBootstrap passes the one resolveMcpLauncher chose, plus the
// `runtime` report and the `lease` it minted so the output can disclose both.
export function buildOrchestratorMcpConfigs({
  baseUrl,
  leaseToken,
  role = 'orchestrator',
  projectId = null,
  sessionId = null,
  dashboardUrl = null,
  nodePath,
  serverPath = MCP_SERVER_PATH,
  runtime = null,
  lease = null,
} = {}) {
  const env = buildEnv({ baseUrl, leaseToken, role, projectId, sessionId });
  const resolvedNode = validateLauncherPath(nodePath || process.execPath, 'nodePath');
  const resolvedServerPath = validateLauncherPath(serverPath || MCP_SERVER_PATH, 'serverPath');
  // One launcher for every client: absolute node + bundled bridge. It needs
  // nothing on PATH. The client spawns this stdio server itself, and it talks to
  // the already-running Orca HTTP API over loopback using the scoped lease.
  const launcher = { command: resolvedNode, args: [resolvedServerPath] };
  const dashboard = dashboardUrl || baseUrl || null;

  return {
    serverKey: SERVER_KEY,
    nodePath: resolvedNode,
    serverPath: resolvedServerPath,
    ...(runtime ? { runtime } : {}),
    ...(lease ? {
      leaseLifecycle: {
        leaseId: lease.id,
        actor: lease.actor,
        expiresAt: lease.expiresAt,
        renewable: false,
        replacedLeaseIds: [...(lease.replacedLeaseIds || [])],
      },
    } : {}),
    env,
    dashboardUrl: dashboard,
    // Way A (visual): open the dashboard in the desktop app's in-app browser.
    // Way B (programmatic): wire one of the MCP configs below for full tooling.
    instructions: [
      'Fastest path: run the one-line command for your client below, then restart your session. The Claude Code command registers Orca at user scope (-s user), so it works from every directory, not only the one you run it in. If you added Orca earlier without a scope, also run "claude mcp remove orca -s local" in the directory where you added it, because Claude Code prefers that local entry there. The Codex command needs no scope flag: codex mcp add writes your user config (~/.codex/config.toml, or $CODEX_HOME/config.toml).',
      `Otherwise paste the Claude Desktop JSON or Codex TOML into that client's config and restart it. Every config launches ${resolvedNode} with Orca's bridge at ${resolvedServerPath}, both by absolute path, so nothing needs to be on PATH. Moving or deleting that Orca directory, or removing that Node, breaks the config.`,
      ...runtimeInstructions(runtime, resolvedNode),
      `Open ${dashboard || 'the Orca dashboard URL'} in the desktop app's in-app browser to drive Orca visually.`,
      `The server exposes Orca's orchestrator tools. Call orchestrator__register with your working directory first (Orca binds you to the project keyed by that cwd; re-call it with the same cwd to refresh your title + focus), executor__spawn to launch executors under contract (choose each lane's model there), lane__list / lane__get / lane__terminal__tail to monitor them, and audit__queue_one + one verdict call (audit__accept / audit__request_fix / audit__block) to enforce the completion contract before resigning with orchestrator__resign. The server enforces the workflow.`,
      ...leaseInstructions(lease),
    ],
    clients: buildClientConfigs(launcher, env),
  };
}
