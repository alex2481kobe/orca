# Orchestrator agent skill

Use this document when an agent is acting as an Orca **orchestrator** over MCP.
Keep it public-safe.

## What Orca is

Orca is a local daemon. Agents connect to it over MCP. An **orchestrator**
registers itself for a project working directory, spawns **executor** agents into
scoped lanes under a hard contract, monitors them, and audits their work before
accepting it. The orchestrator never edits code directly: it decomposes work,
spawns executors, and gates their output.

Orca ships no agent, no model, and no API keys of its own — it drives the CLI
agent you already run.

The dashboard shows the live state of every project, orchestrator, and executor
lane as an interactive node canvas, reachable from a phone over private Tailscale.
It is a **monitoring surface with break-glass controls**, not an agent console:
a human can stop an executor, stop the agents under an orchestrator, or close
(resign) an agent from it, but there is no chat and no way to type into a running
agent. Real orchestration happens over MCP — through you.

## Role

The orchestrator owns lane decomposition, executor selection, progress review, and
audit quality. It does not bypass Orca's contracts, approval gates, or lane
isolation.

## Lifecycle (the loop)

1. **Register.** Call `orchestrator.register` with the project working directory
   (`cwd`). Orca binds you to that project and shows you on the dashboard.
   Registered orchestrators are the only actors allowed to spawn and audit;
   unregistered mutating calls are refused.
2. **Publish status.** Push your current plan/status so a human watching the
   dashboard knows what you are doing, and read `orchestrator.status` to get the
   live state of your project's lanes back.
3. **Spawn.** Check the available executor types, models, permission modes, and
   effort levels first, then call `executor.spawn` to create a scoped lane under
   contract — one owner, one reviewable unit of work, within capacity.
4. **Monitor.** Watch executors without touching them:
   - `lane.list` — all lanes for the project and their state.
   - `lane.get` — full detail for one lane (contract, status, submission).
   - `lane.terminal.tail` — raw terminal output for a running lane.
   You steer executors through spawn/shutdown/retry/audit — you do not type into a
   running executor.
5. **Audit.** When an executor calls `lane.submit`, review before accepting:
   - `audit.queue_one` — pull a submitted lane into the audit queue.
   - `audit.findings.record` — record structured audit findings.
   - `audit.accept` — accept the work (lane is done).
   - `audit.request_fix` — send it back with required changes.
   - `audit.block` — block a lane that must not proceed.
   Do not treat an executor's own summary as final; audit it.
6. **Land isolated work.** A lane that ran in its own worktree is not in the
   project checkout yet: after accepting, call `lane.integrate` to merge it, or
   `lane.worktree.discard` to throw it away. Lanes that ran directly in the
   checkout have nothing to merge — `lane.integrate` refuses them by design.
7. **Resign.** When the work is done, call `orchestrator.resign` so Orca stops
   listing you as an active orchestrator for the project.

## Worktree isolation is conditional

`executor.spawn` takes `worktreeMode`, and the default is `auto`:

- **read-only or sole-writer lanes run directly in the project checkout** — no
  worktree. Do not force one for a scout or a lone writer.
- **only overlapping writers get a dedicated isolated worktree.**

Pass `isolated` explicitly when you know a lane needs its own worktree even though
`auto` wouldn't give it one, and keep concurrent writers file-disjoint. Orca reclaims
a lane's worktree automatically when the lane is deleted or pruned — there is no
manual removal step.

## Lane controls, approvals, and events

Beyond the loop above, you can adjust a lane's contract fields after spawn
(model, permissions, effort), shut a lane down, retry a stopped or failed lane,
and delete a lane you no longer need. When an executor needs a gated action it
surfaces an approval for you to grant or deny. An event stream keeps clients in
sync (drain, ack, replay). Ask the server for your current tool list rather than
memorizing names — the surface is deliberately small and changes.

`fleet.emergency_stop` is the break-glass path: it stops running agents. Use it
when something is genuinely running away, not as routine cleanup.

## Security rules

- Never ask for or print API tokens, provider secrets, pairing codes, or raw
  credential values in lane instructions.
- Do not expose the dashboard through public tunnels; private tailnet access only.
- A paired phone or laptop is an **operator**, not a workstation admin. It can
  read the workspace and use the dashboard's stop/close controls. It cannot mint
  pairing codes, change private-access settings, revoke another device, or grant
  a lane unsandboxed permissions. Do not design around a phone being able to do
  workstation-admin work.
- Keep install, shell, credential, and network-mutation actions explicit,
  approval-gated, and auditable.

## Integration notes (for adopting projects)

- **Sandboxed Codex has two landmines.** A `codex exec` running under
  `--sandbox workspace-write`/`read-only` (a) cancels outbound MCP calls and
  (b) cannot bind localhost ports. If you run Codex as an orchestrator or
  executor, run it with full access (or an approved network policy), or its MCP
  calls to Orca will silently fail and it will blame Orca. Capture executor exit
  status via the file+exit contract, not by expecting the sandboxed process to
  reach the daemon.
- **Done executors linger, then drop off the dashboard.** A finished executor
  stays visible for a few minutes, then ages out of the dashboard projection.
  That is expected pruning, not lost work — the lane's artifacts (`outcome.txt`,
  `transcript.json`) persist on disk regardless.
