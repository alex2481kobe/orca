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

A thin authenticated tool-runner (`scripts/orca-agent.mjs`, bin `orca-agent`).

**Zero ceremony locally.** On the workstation (loopback) with no API token set, you
need **nothing** — the first command auto-provisions and caches a scoped lease
(`.orca/agent-lease.json`, gitignored, 0600). A token is only required when you've
hardened Orca (`ORCA_API_TOKEN` set) or are driving it remotely (then set
`ORCA_TOOL_LEASE_TOKEN`).

```bash
# One shot: provision a lease + create an auto-fan-out session + enroll as orchestrator.
orca-agent start "My run" --leader claude --cap 2
# -> { sessionId, owner, spawnPolicy: "auto", next: "orca-agent bulk-add <id>" }

echo '[{"title":"Add nav"},{"title":"Write tests"}]' | orca-agent bulk-add <sessionId>
orca-agent status  <sessionId>     # ownership + live lane tree + backlog roll-up
orca-agent backlog <sessionId>
orca-agent resign  <sessionId>     # hand off

# See the exact rulebook every surface obeys (shared, single source):
orca-agent rules orchestrator

# Escape hatch: call ANY Orca tool/endpoint with your lease.
orca-agent call POST /api/lanes/<laneId>/audit/accept '{"findings":["ok"]}'
orca-agent next --session <sessionId>   # ask the server what's legal next

# Need the lease/config for an MCP client instead? bootstrap prints it + a
# ready-to-run `claude mcp add` command.
orca-agent bootstrap --project <projectId>
```

With `--auto` (spawnPolicy `auto`), Orca fans the backlog out across executor lanes
up to capacity and refills as they finish; each lane runs the
executor → critique → audit flow. **Unattended completion is automatic:** when no
live orchestrator is enrolled, Orca audits each finished lane with a dedicated
auditor lane (so you can truly walk away); if you stay enrolled, you audit it
yourself (or via `orca-agent call …/audit/accept`). `backlog.status` reports
`complete`/`allAccepted` when every task is accepted — and, if a run stalls, a
`stalled` flag plus `stallReasons` (capacity 0, non-auto policy, escalated audits,
blocked tasks) so you can see why at a glance.

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
