# Orchestrator agent skill

Use this document when an agent is acting as an Orca **orchestrator** over MCP.
Keep it public-safe and editable inside an installed app.

## What Orca is (v2)

Orca is a local daemon. Agents connect to it over MCP. An **orchestrator**
registers itself for a project working directory, spawns **executor** agents into
isolated lanes under a hard contract, monitors them, and audits their work before
accepting it. A read-only dashboard shows projects → orchestrators → executors and
is viewed on a phone over Tailscale. The orchestrator never edits code directly;
it decomposes work, spawns executors, and gates their output.

## Role

The orchestrator owns lane decomposition, executor selection, progress review, and
audit quality. It does not bypass Orca's contracts, approval gates, or worktree
isolation.

## Lifecycle (the loop)

1. **Register.** Call `orchestrator.register` with the project working directory
   (`cwd`). Orca binds you to that project and lists you in the dashboard. Registered
   orchestrators are the only actors allowed to spawn and audit; unregistered
   mutating calls are refused.
2. **Update.** Use `orchestrator.update` to publish your current plan/status, and
   `orchestrator.status` to read back the live lane tree for your project.
3. **Spawn.** Read `executor.capabilities` first to see which executor types, models,
   permission modes, and effort levels are available. Then call `executor.spawn` to
   create a scoped lane under contract — one owner, one reviewable unit of work,
   within capacity. Each lane runs in its own isolated git worktree.
4. **Monitor.** Watch executors read-only:
   - `lane.list` — all lanes for the project and their state.
   - `lane.get` — full detail for one lane (contract, status, submission).
   - `lane.terminal.tail` — raw terminal output for a running lane.
   You steer executors through spawn/shutdown/retry/audit — you do not type into a
   running executor.
5. **Audit.** When an executor submits, review before accepting:
   - `audit.queue_one` / `audit.queue_all_ready` — pull submitted lanes into the
     audit queue.
   - `audit.accept` — accept the work (lane is done).
   - `audit.request_fix` — send it back with required changes.
   - `audit.block` — block a lane that must not proceed.
   - `audit.findings.record` — record structured audit findings.
   Do not treat an executor's own summary as final; audit it.
6. **Resign.** When the work is done, call `orchestrator.resign` so Orca stops
   listing you as an active orchestrator for the project.

## Lane controls

- `lane.controls.update` — adjust a lane's contract fields (model, permissions,
  effort, and similar) after spawn.
- `lane.shutdown` — stop a running executor lane.
- `lane.retry` — re-run a stopped or failed lane.
- `lane.delete` — remove a lane you no longer need.

Orca reclaims each lane's isolated worktree **automatically** when the lane is
deleted or pruned — there is no manual worktree-removal step and no worktree tool.

## Approvals

When an executor needs a gated action, it surfaces an approval. Manage them with:

- `approval.list` — pending approvals for your project.
- `approval.request` — request an approval on behalf of a lane.
- `approval.respond` — approve or deny.

Keep install, shell, credential, and network-mutation actions explicit and
approval-gated.

## Events

The dashboard and clients stay in sync through an event stream:

- `event.drain` — pull new events.
- `event.ack` — acknowledge processed events.
- `event.replay` — re-read a range of past events.

## Setup and access

- `orca.setup_guide` — the canonical onboarding walkthrough (how to register a
  client over MCP and get connected). Point new clients at this instead of
  memorizing wiring.
- `tailscale.status` — read the private-access state for phone viewing.
- `tailscale.serve.configure` — a workstation/admin operation to expose the
  read-only dashboard privately over the tailnet. Never enable a public tunnel.

## Security rules

- Never ask for or print API tokens, provider secrets, pairing codes, or raw
  credential values in lane instructions.
- Do not expose the dashboard through public tunnels; private tailnet access only.
- Treat paired phones as read-only viewer devices, not host-admin devices.
- Keep install, shell, credential, and network-mutation actions explicit,
  approval-gated, and auditable.

## Integration notes (for adopting projects)

- **The orchestrator is the unit, not the "session."** You register an
  orchestrator per working directory and spawn executor lanes under it. Some API
  responses and on-disk artifact paths still carry a `sessionId` field — that is
  an internal legacy alias of the orchestrator id; do not build integrations that
  depend on a separate "session" concept.
- **Sandboxed Codex has two landmines.** A `codex exec` running under
  `--sandbox workspace-write`/`read-only` (a) cancels outbound MCP calls and
  (b) cannot bind localhost ports. If you run Codex as an orchestrator or
  executor, run it with full access (or an approved network policy), or its MCP
  calls to Orca will silently fail and it will blame Orca. Capture executor exit
  status via the file+exit contract, not by expecting the sandboxed process to
  reach the daemon.
- **Done executors linger, then drop from the dashboard.** A finished executor
  stays visible for a few minutes, then ages out of `/api/overview`. That is
  expected pruning, not lost work — the lane's artifacts (`outcome.txt`,
  `transcript.json`) persist on disk regardless.
