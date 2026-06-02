# Controlling Orca from Codex app / Claude Desktop

Orca can be driven from a desktop AI app (the Codex app or Claude Desktop) in two
complementary ways. Both run entirely on the local machine (loopback); neither
exposes the Orca API token.

## Way A — in-app browser (visual)

Open the Orca dashboard URL in the desktop app's built-in browser. You get the
full Orca UI — orchestrator chat, lanes, approvals, goal/plan editing, evidence —
exactly as in a normal browser. The dashboard URL is shown on the **Pair → Desktop
app control** card (the same private/local URL used for phone pairing).

This path uses the desktop app's own remote-control of its embedded browser. No
extra configuration is required beyond opening the URL.

## Way B — MCP tooling (programmatic)

Give the desktop agent Orca's orchestrator tools as native MCP tools. The agent
then acts as the Orca **orchestrator**: spawn/stop lanes, manage tasks, respond to
approvals, change mode/permissions/goal/plan, capture evidence, and run audits —
without screen-driving the UI.

### Generate the config

In the dashboard, go to **Pair → Desktop app control → Generate desktop-app
config** (or `POST /api/mcp/orchestrator-bootstrap` with the API token). This mints
a **scoped orchestrator tool lease** (default 12h TTL, never the raw API token) and
returns paste-ready config for each client.

The lease can be scoped to a single project/session by passing `projectId` /
`sessionId`; unscoped leases work session/project-wide.

### Claude Desktop

Merge the `orca` entry into `mcpServers` in
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "orca": {
      "command": "/path/to/node",
      "args": ["/abs/path/to/src/mcp-server.js"],
      "env": {
        "ORCA_AGENT_TOOLS_BASE_URL": "http://127.0.0.1:3000",
        "ORCA_TOOL_LEASE_TOKEN": "<scoped-lease-token>",
        "ORCA_ROLE": "orchestrator"
      }
    }
  }
}
```

### Codex app

Append to `~/.codex/config.toml`:

```toml
[mcp_servers.orca]
command = "/path/to/node"
args = ["/abs/path/to/src/mcp-server.js"]

[mcp_servers.orca.env]
ORCA_AGENT_TOOLS_BASE_URL = "http://127.0.0.1:3000"
ORCA_TOOL_LEASE_TOKEN = "<scoped-lease-token>"
ORCA_ROLE = "orchestrator"
```

Restart the desktop app after editing its config so it spawns the MCP server.

### How it works

The desktop app spawns `src/mcp-server.js` over stdio — the same hand-rolled MCP
server Orca injects into its own lanes. It authenticates each Orca HTTP tool call
with the scoped lease (`x-orca-tool-lease`), and the server enforces the workflow:
call `session__next_action` first to learn the required next tool; out-of-order
calls are refused with a `nextAction` envelope.

### Security

- The lease grants only the orchestrator toolset and expires. The full API token
  is never placed in any client config.
- The bootstrap endpoint is API-token (or paired-browser) gated, so only an
  authenticated operator can issue a lease.
- All tool calls stay on loopback; nothing is exposed to the tailnet by this flow.

## Both paths together

Way A and Way B are compatible. You can open the dashboard in the in-app browser
for the visual surface while the same desktop agent holds an MCP lease for
programmatic control. Orca's own orchestrator chat keeps working for full control
from within Orca itself.
