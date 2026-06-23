# Companion mode — drive Orca from any agent

Most of Orca is about running agents *inside* Orca. Companion mode is the inverse:
an **outside** agent (Codex, Claude, Cursor, a cron script, or anything that can
run a command or make an HTTP call) uses Orca's tools to spawn and supervise
sub-agents and run the governed flow, **without** being an Orca MCP client and
without living in the dashboard. You supercharge the agent you are already using
by delegating fan-out to Orca, while Orca keeps the hardening and the flow.

That means a single current chat can become the operator for a whole run: Codex
can launch and audit Claude executor lanes, Claude can launch and audit Codex
lanes, and either can include approved API-backed or custom-CLI lanes when the
host is configured for them.

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
(`~/.orca/agent-leases.json`, 0600). Leases are cached by base URL, role, project,
and session so an orchestrator chat and a supervisor chat do not accidentally
reuse each other's authority. A token is only required when you've hardened Orca
(`ORCA_API_TOKEN` set) or are driving it remotely (then set
`ORCA_TOOL_LEASE_TOKEN`).

```bash
# One shot: provision a lease, create an auto-fan-out session, and enroll as orchestrator.
orca-agent start "My run" --leader claude --cap 2
# -> { sessionId, owner, spawnPolicy: "auto", next: "orca-agent bulk-add <id>" }

# Attach this chat to an existing session instead. Use --takeover only when you
# intentionally replace the current active orchestrator.
orca-agent enroll <sessionId> --project <projectId>
orca-agent enroll <sessionId> --project <projectId> --takeover

orca-agent create-session <projectId> "Repo run" \
  --repo-root /path/to/repo --worktree-mode isolated --cap 2 --leader codex
echo '[{"title":"Add nav"},{"title":"Write tests"}]' | orca-agent bulk-add <sessionId>
orca-agent status  <sessionId>     # ownership + live lane tree + backlog roll-up
orca-agent backlog <sessionId>
orca-agent tail <laneId> --max-bytes 4096
orca-agent watch <laneId> --idle-ms 5000
orca-agent watch-session <sessionId> --project <projectId> --idle-ms 5000 --json
orca-agent watch-session <sessionId> --project <projectId> --done --idle-ms 5000 --json
orca-agent resign  <sessionId>     # hand off

# Project links for phone/Tailscale use:
orca-agent projects
orca-agent links <projectId>
orca-agent link-upsert <projectId> "Example App" "http://127.0.0.1:5173" \
  --tailnet "http://mac.tailnet.ts.net:5173" --port 5173 --kind vite --favorite --check
orca-agent tailscale-status
orca-agent tailscale-setup

# See the exact rulebook every surface obeys (shared, single source):
orca-agent rules orchestrator

# Escape hatch: call ANY Orca tool/endpoint with your lease.
orca-agent call POST /api/lanes/<laneId>/audit/accept '{"findings":["ok"]}'
orca-agent next --session <sessionId>   # ask the server what's legal next

# Need the lease/config for an MCP client instead? bootstrap prints it + a
# ready-to-run `claude mcp add` command.
orca-agent bootstrap --project <projectId>
orca-agent bootstrap --role supervisor --project <projectId>
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

Host-level Tailscale Serve changes remain an explicit workstation/admin action:
`orca-agent tailscale-serve enable --port 3000` uses the admin path locally and
never enables Funnel. Scoped MCP/orchestrator leases can read status/setup plans
and save project links, but they do not receive the Serve mutation tool.

## Using it from a chat right now

You don't need the CLI on `PATH` — from any shell-capable agent:

```bash
node scripts/orca-agent.mjs enroll <sessionId>
```

That makes *this* chat the active orchestrator. From then on it holds the session
(others are refused) and must follow the server's `nextAction` flow — the same
contract an MCP-connected orchestrator obeys.

To make the current chat a supervisor instead, use the supervisor commands:

```bash
node scripts/orca-agent.mjs supervisor-overview --project <projectId> --session <sessionId>
node scripts/orca-agent.mjs supervisor-status <sessionId> --project <projectId>
node scripts/orca-agent.mjs supervisor-watch <laneId> --project <projectId> --session <sessionId> --idle-ms 5000
node scripts/orca-agent.mjs supervisor-watch-all --project <projectId> --session <sessionId> --idle-ms 5000 --json
node scripts/orca-agent.mjs supervisor-watch-all --project <projectId> --session <sessionId> --done --idle-ms 5000 --json
node scripts/orca-agent.mjs supervisor-audit <sessionId> request_fix "Needs one more check" \
  --project <projectId> --finding "Missing acceptance evidence" --next-task "Add the proof"
node scripts/orca-agent.mjs supervisor-resign --project <projectId> --session <sessionId>
```

When a supervisor requests a fix, the normal orchestrator view carries it too:
`node scripts/orca-agent.mjs status <sessionId> --project <projectId>` prints the
current supervisor review and next task below the lane tree.

Once attached, the dashboard's Settings -> Supervisor page lists that chat as a
registered supervisor agent. This is the intentionally bounded "god supervisor"
surface: it can inspect, watch, audit, and resign, but it cannot mutate plans,
backlog tasks, worktree policy, settings, orchestrator ownership, or executor
lanes.

`supervisor-resign` revokes only the caller's supervisor lease and clears that
cached lease entry. It does not remove other supervisors or dashboard operators.
Use `tail` when the chat needs a bounded snapshot and `watch` when it needs the
live terminal feel from a worker lane; both use scoped leases, so session/project
boundaries are still enforced by Orca.

See also [`desktop-app-control.md`](desktop-app-control.md) for the MCP-client setup
(Codex CLI/app, Claude Code CLI, Claude Desktop, and compatible MCP clients).
