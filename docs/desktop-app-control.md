# Controlling Orca from Codex, Claude, and MCP clients

Orca can be driven from a desktop AI app or CLI MCP client in two complementary
ways. Both run entirely on the local machine (loopback); neither exposes the Orca
API token.

The primary tested controller paths are Codex CLI, the Codex app, Claude Code
CLI, and Claude Desktop. Other MCP-capable clients can use the same stdio server
if they can launch a local command with environment variables.

This is the "one agent manages the fleet" flow: Codex can act as the orchestrator
for Claude executor lanes, Claude can orchestrate Codex lanes, and either can mix
in API-backed or approved custom-CLI lanes. Orca owns the workflow state, leases,
capacity, evidence, critique, and audit gates.

## Way A — in-app browser (visual)

Open the Orca dashboard URL in the desktop app's built-in browser. You get the
full Orca UI — orchestrator chat, lanes, approvals, goal/plan editing, evidence —
exactly as in a normal browser. The dashboard URL is shown on the **Pair → Desktop
app control** card (the same private/local URL used for phone pairing).

This path uses the desktop app's own remote-control of its embedded browser. No
extra configuration is required beyond opening the URL.

## Way B — MCP tooling (programmatic)

Give the desktop or CLI agent Orca's orchestrator tools as native MCP tools. The
agent then acts as the Orca **orchestrator**: spawn/stop lanes, manage tasks,
respond to approvals, change mode/permissions/goal/plan, capture evidence, and
run audits — without screen-driving the UI.

### Generate the config

In the dashboard, go to **Pair → Desktop app control → Generate desktop-app
config** (or `POST /api/mcp/orchestrator-bootstrap` with the API token). This mints
a **scoped orchestrator tool lease** (default 12h TTL, never the raw API token) and
returns paste-ready config for each client.

The lease can be scoped to a single project/session by passing `projectId` /
`sessionId`; unscoped leases work session/project-wide.

### Claude Code CLI

Register the server in one command (the dashboard generates this exact line with
your live lease and paths), then start a new session:

```bash
claude mcp add orca \
  -e ORCA_AGENT_TOOLS_BASE_URL=http://127.0.0.1:3000 \
  -e ORCA_TOOL_LEASE_TOKEN=<scoped-lease-token> \
  -e ORCA_ROLE=orchestrator \
  -- node /abs/path/to/src/mcp-server.js
```

Then tell the chat to act as the orchestrator. The loop is:
`session__next_action` → `orchestrator__enroll { sessionId }` (claim the session;
`orchestrator__resign` hands off) → `task__bulk_add` a backlog → with
`spawnPolicy:"auto"` Orca fans tasks out across executor lanes and audits them to
accepted → `orchestrator__status` shows the live lane tree.

### Codex CLI

```bash
codex mcp add orca \
  --env ORCA_AGENT_TOOLS_BASE_URL=http://127.0.0.1:3000 \
  --env ORCA_TOOL_LEASE_TOKEN=<scoped-lease-token> \
  --env ORCA_ROLE=orchestrator \
  -- node /abs/path/to/src/mcp-server.js
```

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

### No Orca source checkout required

You do **not** need to clone or open Orca's source, or launch anything from
within the repo, to drive Orca as an external orchestrator. Three ways the
generated config can point at the stdio MCP server:

1. **Installed app (default):** the generated config's absolute path resolves to
   the `mcp-server.js` shipped inside the installed Orca app bundle — not a dev
   source tree.
2. **`orca-mcp` on PATH:** Orca is **not published to npm**, so `npm i -g orca`
   will not work. To get the `orca-mcp` command, run `npm link` inside a checkout.
   The bootstrap's `globalInstall` config variant then uses `command: "orca-mcp"`
   with no absolute path at all.
3. **Source checkout:** `command: node`, `args: ["…/src/mcp-server.js"]`.

In every case the desktop app/CLI spawns the stdio MCP server itself and it talks
to the **already-running** Orca HTTP API over loopback using the scoped lease —
you never start an Orca process from source by hand.

Global-install config (Codex example):

```toml
[mcp_servers.orca]
command = "orca-mcp"
args = []

[mcp_servers.orca.env]
ORCA_AGENT_TOOLS_BASE_URL = "http://127.0.0.1:3000"
ORCA_TOOL_LEASE_TOKEN = "<scoped-lease-token>"
ORCA_ROLE = "orchestrator"
```

### How it works

The desktop app spawns the Orca stdio MCP server (`orca-mcp` / `mcp-server.js`) —
the same hand-rolled server Orca injects into its own lanes. It authenticates each
Orca HTTP tool call with the scoped lease (`x-orca-tool-lease`), and the server
enforces the workflow: call `session__next_action` first to learn the required
next tool; out-of-order calls are refused with a `nextAction` envelope. The
`initialize` response also delivers the role-specific orchestrator rulebook, so an
agent told "act as the orchestrator" knows the rules at connect time.

The orchestrator is only the coordinator. Executor lanes still run through Orca's
validated provider profiles and worktree isolation. Codex and Claude are the
primary tested CLI executors for desktop-app orchestration flows; API-backed
profiles and custom CLI adapters are available where configured and approved.

### Security

- The lease grants only the orchestrator toolset and expires. The full API token
  is never placed in any client config.
- The bootstrap endpoint is **admin-gated** (API token, or the loopback
  workstation when no token is set) — a paired phone/browser is operator-only and
  cannot mint an orchestrator lease.
- `orchestrator__enroll` only **binds** an already-issued lease to a session and
  marks ownership; it never mints or widens a credential. Takeover/resign
  coordinate handoff between chats.
- All tool calls stay on loopback; nothing is exposed to the tailnet by this flow.

## Both paths together

Way A and Way B are compatible. You can open the dashboard in the in-app browser
for the visual surface while the same desktop agent holds an MCP lease for
programmatic control. Orca's own orchestrator chat keeps working for full control
from within Orca itself.
