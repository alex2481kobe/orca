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

// All client snippets for one launcher (node+path, or a PATH command).
function buildClientConfigs(launcher, env) {
  const claudeDesktop = buildClaudeDesktopConfig({ launcher, env });
  return {
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
      `No Orca source checkout is required: install the Orca app (or 'npm i -g orca'), then paste a config below into your desktop app/CLI and restart it.`,
      `Open ${dashboardUrl || baseUrl || 'the Orca dashboard URL'} in the desktop app's in-app browser to drive Orca visually.`,
      `For programmatic control, add the MCP server config for your client (Claude Desktop JSON or Codex TOML).`,
      `The server exposes Orca's orchestrator tools; call session__next_action first — the server enforces the workflow.`,
    ],
    clients,
    // Same configs but launched via the PATH-resolved 'orca-mcp' command instead
    // of an absolute node+path (for global installs / arbitrary CLIs).
    globalInstall,
  };
}
