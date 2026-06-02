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
// with the standard mcpServers shape (command/args/env).
function buildClaudeDesktopConfig({ nodePath, serverPath, env }) {
  return {
    mcpServers: {
      [SERVER_KEY]: {
        command: nodePath,
        args: [serverPath],
        env,
      },
    },
  };
}

// Codex app reads ~/.codex/config.toml with [mcp_servers.<name>] tables.
function buildCodexConfigToml({ nodePath, serverPath, env }) {
  const lines = [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(serverPath)}]`,
    '',
    `[mcp_servers.${SERVER_KEY}.env]`,
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key} = ${tomlString(value)}`);
  }
  return `${lines.join('\n')}\n`;
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
  const claudeDesktop = buildClaudeDesktopConfig({ nodePath: resolvedNode, serverPath, env });
  return {
    serverKey: SERVER_KEY,
    nodePath: resolvedNode,
    serverPath,
    env,
    dashboardUrl: dashboardUrl || baseUrl || null,
    // Way A — visual: open the dashboard in the desktop app's in-app browser.
    // Way B — programmatic: wire one of the MCP configs below for full tooling.
    instructions: [
      `Open ${dashboardUrl || baseUrl || 'the Orca dashboard URL'} in the desktop app's in-app browser to drive Orca visually.`,
      `For programmatic control, add the MCP server config for your client (Claude Desktop JSON or Codex TOML) and restart the app.`,
      `The server exposes Orca's orchestrator tools; call session__next_action first — the server enforces the workflow.`,
    ],
    clients: {
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
        snippet: buildCodexConfigToml({ nodePath: resolvedNode, serverPath, env }),
      },
      generic: {
        label: 'Generic MCP client',
        merge: 'Use this mcpServers map directly.',
        config: claudeDesktop,
        snippet: JSON.stringify(claudeDesktop, null, 2),
      },
    },
  };
}
