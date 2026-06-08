# Companion mode — drive Orca from any agent

Most of Orca is about running agents *inside* Orca. Companion mode is the inverse:
an **outside** agent (Claude Code, Codex, Cursor, a cron script — anything that can
run a command or make an HTTP call) uses Orca's tools to spawn and supervise
sub-agents and run the governed flow, **without** being an Orca MCP client and
without living in the dashboard. You "supercharge" your own work by delegating
fan-out to Orca, while Orca keeps the hardening and the flow.

This is also the answer to *"can my current chat be the orchestrator?"* — yes. An
MCP client can't hot-attach a new server mid-session, but the MCP server is only a
thin proxy over Orca's loopback HTTP API. Call that surface directly and you are a
first-class, flow-enforced orchestrator immediately.

## Why it's still safe

Every call carries a **scoped tool lease** (`x-orca-tool-lease`), never the raw API
token. The server — not the client — enforces:

- **Lease scoping:** a lease only grants its role's tools, optionally pinned to a
  project/session/lane.
- **Workflow state gates:** out-of-order calls are refused with a `nextAction`
  envelope telling you the only legal next step.
- **Exclusive orchestrator ownership:** once you `orchestrator.enroll`, a *different*
  orchestrator lease cannot mutate that session — it gets `409` until it takes over
  (`takeover:true`) or you `resign`. A stale owner (15 min idle, or a dead lease)
  never blocks a live agent.

## The `orca-agent` CLI

A thin authenticated tool-runner (`scripts/orca-agent.mjs`, bin `orca-agent`). It
reads `ORCA_AGENT_TOOLS_BASE_URL` and `ORCA_TOOL_LEASE_TOKEN` from the env (the same
vars the MCP server uses).

```bash
# 1) Mint an orchestrator lease (admin: needs ORCA_API_TOKEN, or run on the
#    loopback workstation with no token configured). Prints the token + a ready
#    `claude mcp add` command too.
ORCA_API_TOKEN=… orca-agent bootstrap --project <projectId>
export ORCA_TOOL_LEASE_TOKEN=<printed token>

# 2) Become the orchestrator and run a backlog.
orca-agent create-session <projectId> "My run" --auto --cap 2 --leader claude
orca-agent enroll <sessionId>
echo '[{"title":"Add nav"},{"title":"Write tests"}]' | orca-agent bulk-add <sessionId>
orca-agent status  <sessionId>     # ownership + live lane tree + backlog roll-up
orca-agent backlog <sessionId>
orca-agent resign  <sessionId>     # hand off

# Escape hatch: call ANY Orca tool/endpoint with your lease.
orca-agent call POST /api/lanes/<laneId>/audit/accept '{"findings":["ok"]}'
orca-agent next --session <sessionId>   # ask the server what's legal next
```

With `--auto` (spawnPolicy `auto`), Orca fans the backlog out across executor lanes
up to capacity and refills as they finish; each lane runs the
executor → critique → audit flow. Drive the audits with `orca-agent call
…/audit/accept` (or let a separate-auditor lane do it), and `backlog.status` reports
`complete` when every task is accepted.

## Using it from a chat right now

You don't need the CLI on `PATH` — from any shell-capable agent:

```bash
node scripts/orca-agent.mjs enroll <sessionId>
```

That makes *this* chat the active orchestrator. From then on it holds the session
(others are refused) and must follow the server's `nextAction` flow — the same
contract an MCP-connected orchestrator obeys.

See also [`desktop-app-control.md`](desktop-app-control.md) for the MCP-client setup
(Claude Code CLI / Codex / Claude Desktop).
