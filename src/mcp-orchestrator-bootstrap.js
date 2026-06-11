// Orchestrator MCP bootstrap builder.
//
// Lets an EXTERNAL desktop app (Codex app, Claude Desktop) act as an Orca
// orchestrator. The same hand-rolled stdio MCP server that Orca injects into its
// own lanes (src/mcp-server.js) is pointed at by the desktop app's MCP config,
// authenticated with a scoped orchestrator tool lease (never the full API token).
//
// This produces ready-to-paste config for each client plus the env block, so the
// desktop agent gets Orca's full orchestrator toolset (spawn/stop lanes, tasks,
// approvals, mode/permission/goal/plan changes, evidence, audit) as native MCP
// tools — while Orca's own dashboard chats/flows keep working unchanged. The two
// control paths are complementary: open the dashboard URL in the desktop app's
// in-app browser for the visual surface, and wire the MCP config for tool access.

import { fileURLToPath } from 'node:url';

// Absolute path to the stdio MCP server the desktop app will spawn. Resolved the
// same way the lane executor-factory resolves it, so source and packaged builds
// both point at the right file.
export const MCP_SERVER_PATH = fileURLToPath(new URL('./mcp-server.js', import.meta.url));

const SERVER_KEY = 'orca';

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
  // Default path params let the desktop agent omit ids on every call; it can
  // still target other sessions/projects explicitly when its lease is broad.
  if (projectId) env.ORCA_PROJECT_ID = String(projectId);
  if (sessionId) env.ORCA_SESSION_ID = String(sessionId);
  return env;
}

// Claude Desktop reads ~/Library/Application Support/Claude/claude_desktop_config.json
// with the standard mcpServers shape (command/args/env). `launcher` is how to
// start the stdio MCP server: either {command:node, args:[absolutePath]} or a
// PATH command like {command:'orca-mcp', args:[]} for a global install.
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

// `claude mcp add` / `codex mcp add` one-liners — the simplest connect path for
// the CLI clients (vs hand-editing JSON/TOML). flagStyle is how each CLI passes
// env: Claude Code uses repeated `-e K=V`, Codex CLI uses repeated `--env K=V`.
function buildCliCommand(binary, flag, launcher, env) {
  const envFlags = Object.entries(env).map(([k, v]) => `${flag} ${shArg(`${k}=${v}`)}`).join(' ');
  const launch = [launcher.command, ...launcher.args].map(shArg).join(' ');
  return `${binary} mcp add ${SERVER_KEY} ${envFlags} -- ${launch}`;
}

// All client snippets for one launcher (node+path, or a PATH command).
function buildClientConfigs(launcher, env) {
  const claudeDesktop = buildClaudeDesktopConfig({ launcher, env });
  return {
    claudeCli: {
      label: 'Claude Code CLI',
      merge: 'Run this once; it registers the "orca" MCP server for Claude Code, then restart your session.',
      command: buildCliCommand('claude', '-e', launcher, env),
      snippet: buildCliCommand('claude', '-e', launcher, env),
    },
    codexCli: {
      label: 'Codex CLI',
      merge: 'Run this once to register the "orca" MCP server for the Codex CLI.',
      command: buildCliCommand('codex', '--env', launcher, env),
      snippet: buildCliCommand('codex', '--env', launcher, env),
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

// Build every client config from one lease. `nodePath` defaults to the running
// node binary; callers may override (e.g. when the desktop app uses a different
// runtime path). `serverPath` defaults to the bundled MCP server.
export function buildOrchestratorMcpConfigs({
  baseUrl,
  leaseToken,
  role = 'orchestrator',
  projectId = null,
  sessionId = null,
  dashboardUrl = null,
  nodePath,
  serverPath = MCP_SERVER_PATH,
} = {}) {
  const resolvedRole = String(role || 'orchestrator');
  const env = buildEnv({ baseUrl, leaseToken, role, projectId, sessionId });
  const resolvedNode = String(nodePath || process.execPath);
  // Primary launcher: absolute node + bundled server path. This resolves to
  // wherever mcp-server.js actually lives — the installed app bundle, a global
  // npm install, or a source checkout — so it works WITHOUT the user opening
  // Orca's source. No Orca process needs to be started from source: the desktop
  // app/CLI spawns this stdio server itself, and it talks to the already-running
  // Orca HTTP API over loopback using the scoped lease.
  const nodeLauncher = { command: resolvedNode, args: [serverPath] };
  // Alternative for users who installed Orca globally (`npm i -g`): the `orca-mcp`
  // bin is on PATH, so no absolute path is needed at all.
  const binLauncher = { command: 'orca-mcp', args: [] };

  const clients = buildClientConfigs(nodeLauncher, env);
  const globalInstall = buildClientConfigs(binLauncher, env);

  return {
    serverKey: SERVER_KEY,
    nodePath: resolvedNode,
    serverPath,
    env,
    dashboardUrl: dashboardUrl || baseUrl || null,
    // Way A — visual: open the dashboard in the desktop app's in-app browser.
    // Way B — programmatic: wire one of the MCP configs below for full tooling.
    instructions: [
      `Fastest path (Claude Code CLI / Codex CLI): run the one-line "claude mcp add"/"codex mcp add" command below, then restart your session.`,
      `Otherwise paste the Claude Desktop JSON or Codex TOML into that client's config and restart it. The config uses an absolute node + bundled mcp-server.js path, so no Orca source checkout is required (Orca is not published to npm; the 'orca-mcp' bin variant only works after 'npm link' in a checkout).`,
      `Open ${dashboardUrl || baseUrl || 'the Orca dashboard URL'} in the desktop app's in-app browser to drive Orca visually.`,
      resolvedRole === 'supervisor'
        ? `The server exposes Orca's supervisor tools; call supervisor__overview first, then inspect or update individual sessions as needed — the server enforces the workflow.`
        : `The server exposes Orca's orchestrator tools; call session__next_action first, then orchestrator__enroll — the server enforces the workflow.`,
    ],
    clients,
    // Same configs but launched via the PATH-resolved 'orca-mcp' command instead
    // of an absolute node+path (for global installs / arbitrary CLIs).
    globalInstall,
  };
}
