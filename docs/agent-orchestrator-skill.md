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
(resign) an agent from it, but the dashboard has no chat box and no way to type
into a running agent. Real orchestration happens over MCP — through you (and
`lane.terminal.write` is the only path into a running executor's prompt).

## Role

The orchestrator owns lane decomposition, executor selection, progress review, and
audit quality. It does not bypass Orca's contracts, approval gates, or lane
isolation.

## Lifecycle (the loop)

1. **Register.** Call `orchestrator.register` with the project working directory
   (`cwd`). Orca binds you to that project and shows you on the dashboard.
   Registered orchestrators are the only actors allowed to spawn and audit;
   unregistered mutating calls are refused.
2. **Refresh your title and focus.** There is no separate status-push tool.
   Re-call `orchestrator.register` with the same `cwd` — it is idempotent and
   updates the self-authored `title` + `focus` line the dashboard shows. Poll
   `orchestrator.status` for the lane tree, capacity, and the next required tool;
   polling it also refreshes your lease, so a read-only monitoring loop keeps its
   ownership from going stale (after ~15 minutes idle another agent can take the
   orchestrator over via `takeoverOrchestratorId`).
3. **Spawn.** `executor.spawn { title, executorType, taskPrompt, model?,
   permissionsProfile?, intelligenceProfile?, worktreeMode?, idleShutdown? }` —
   one owner, one reviewable unit of work. There is no capability-discovery tool;
   these are the values:
   - `executorType`: `codex`, `claude`, `gemini-cli`, `composer-cli`, or `mock`
     (plus `cli` only when the operator enabled a generic CLI profile). An
     unsupported type is refused with the supported list.
   - `model`: passed straight through to that CLI's `--model`. Blank = the CLI's
     own default. Orca ships no model list.
   - `permissionsProfile`: how much the lane may do. Orca maps the string per
     CLI, so it does not mean the same thing everywhere:
     - Codex: `read-only` / `plan` / `ask` / `default` → `--sandbox read-only`;
       anything else, blank included, → `--sandbox workspace-write`. A Codex lane
       is always sandboxed.
     - Claude: passed as `--permission-mode` (`auto-edit` → `acceptEdits`,
       `bypass` → `bypassPermissions`); blank leaves the CLI's default. Orca
       routes Claude's permission prompts to you (`approval.list` /
       `approval.respond`) for every value **except** the force modes (`auto`,
       `auto-edit`, `auto-accept`, `bypass`, `force`, `yolo`), which self-approve.
     - `gemini-cli`: `--approval-mode`, unless the value is a plan/read-only one.
       `composer-cli`: only a force mode matters (it becomes `--force`).
     The exact string `read-only` additionally marks the lane a non-writer, which
     is what stops `auto` worktree mode from giving it a worktree.
   - `intelligenceProfile`: reasoning effort. Codex accepts
     `minimal|low|medium|high|xhigh`; Claude accepts `low|medium|high|xhigh|max`
     plus `ultracode`. `gemini-cli` and `composer-cli` ignore it.
   - `worktreeMode`: `auto` (default) or `isolated` — see "Worktree isolation is
     conditional" below. No other value is accepted.
   - `idleShutdown`: default `true` — a running lane with no output or tool
     activity for the idle window is reaped. Pass `false` for a lane that is
     legitimately quiet for a long time.
   Lanes above your capacity are accepted and stay **queued** until a slot frees
   (see "Lane capacity" below).
4. **Monitor.** Watch executors:
   - `lane.list` — all lanes for the project and their state.
   - `lane.get` — full detail for one lane (contract, logs, changed files,
     `resultText` — read this to see WHY a lane failed).
   - `lane.terminal.tail` — raw terminal output for a running lane; poll with
     `nextOffset`.
   - `lane.terminal.write` — answer a prompt a worker is blocked on. This is the
     one way to type into a running executor; the dashboard has no such control.
5. **Audit.** When an executor calls `lane.submit`, review before accepting:
   - `audit.queue_one` — pull a submitted lane into the audit queue.
   - `audit.findings.record` — record structured audit findings.
   - `audit.accept` — accept the work (lane is done).
   - `audit.request_fix` — send it back with required changes.
   - `audit.block` — block a lane that must not proceed.
   Do not treat an executor's own summary as final; audit it. Two server-side
   gates will refuse an empty sign-off with `409`:
   - `audit.accept` requires at least one finding or one reviewed file. Call
     `audit.findings.record` first.
   - A lane that has a `targetUrl` (UI/browser work) additionally requires
     **captured evidence** — a `.png/.jpg/.gif/.webp/.svg/.pdf/.mp4/.webm`
     artifact on the lane. Check with `lane.artifacts.list` / read it with
     `lane.artifacts.get` before accepting; if there is none, `audit.request_fix`
     and tell the executor to capture a screenshot.
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
`auto` wouldn't give it one, and keep concurrent writers file-disjoint.

**An isolated worktree is not reclaimed for you.** Retention pruning deliberately
*skips* an isolated lane that still holds un-integrated work — record and worktree
both stay on disk indefinitely, so nothing silently deletes unmerged code. You
release it by finishing the lane: `lane.integrate` (merge it back) or
`lane.worktree.discard` (throw it away). `lane.delete` also removes the worktree,
but only for a terminal lane and it takes the record with it.

## Lane capacity

An orchestrator runs a bounded number of lanes at once; the rest queue. The
default is **4** and there is no tool to change it — set the `ORCA_LANE_CONCURRENCY`
env var on the Orca server process (values above 64 are clamped to 64).

Trap: the value is only applied to an orchestrator record that has **no** capacity
field yet. An orchestrator already persisted in `.orca/state.json` keeps the
capacity it was created with, so changing the env var does **not** retro-apply to
existing orchestrators — it takes effect for ones registered afterwards.

## Lane controls, approvals, and events

`lane.controls.update` adjusts a lane's contract fields after spawn: `model`,
`permissionsProfile`, `intelligenceProfile` (reasoning effort — the field is not
called `effort`), and — when the user left them blank — `targetUrl` and
`verificationCommand` you have learned for this work. Setting `targetUrl` is what
puts the lane under the captured-evidence rule above. `lane.shutdown`,
`lane.retry`, and `lane.delete` cover stop, re-run, and cleanup.

When an executor needs a gated action it surfaces an approval: `approval.list`
then `approval.respond`. A governed Claude executor **blocks** until you decide.

`event.drain` is the only event tool — there is no ack or replay call, because
draining IS the acknowledgement. Whatever a drain returns is consumed and will
never be returned again, so **persist the events before you act on them**; if
your call fails mid-processing, those events are gone. Query params: `limit`,
`type`, `afterSeq`.

Your MCP client's tool list is authoritative — the surface is deliberately small
and changes; do not call a tool you cannot see in it.

`fleet.emergency_stop` is the break-glass path: it stops running agents. Use it
when something is genuinely running away, not as routine cleanup.

## Live preview links

If you start a dev server for the user, register it with `project.preview.set`
so the link renders on the dashboard and on their phone:

```
project.preview.set { projectId, body: { label, localUrl, port?, kind?, id? } }
```

`localUrl` is the loopback URL you actually started (e.g.
`http://127.0.0.1:5173`); Orca derives the tailnet URL. `kind` is one of
`dev-server`, `vite`, `preview`, `dashboard`, `artifact`, `docs`, `other`. Pass an
existing link's `id` to update it instead of adding another. `projectId` comes
from your `orchestrator.register` response (a lane's MCP connection fills it in
automatically).

## Server-side knobs that change your behavior

These are env vars on the Orca server process, not tools. Know them because they
silently change what you observe:

- `ORCA_LANE_CONCURRENCY` — lanes per orchestrator (default 4, max 64). See
  "Lane capacity" for the backfill trap.
- `ORCA_LANE_IDLE_TIMEOUT_MS` — how long a *running* lane may produce no output
  or tool activity before it is stopped as idle (default 900000 = 15 min; `0`
  disables it). A lane spawned with `idleShutdown:false` is exempt.
- `ORCA_AUTO_AUDIT` — auto-audit is **on** by default: when an executor lane
  finishes and its flow requires an audit, Orca queues it and nudges **you** —
  the lane's owning orchestrator — to review it. Orca does not spawn a dedicated
  auditor lane; you are the audit tier. Set it to `false` and nothing audits a
  finished lane until you call `audit.queue_one` yourself. Auditor and
  orchestrator lanes are never auto-audited (no self-audit).

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

- **Codex and Claude are equally supported — measured, not assumed.** On the
  versions we test (codex-cli 0.144.5, claude 2.1.220) BOTH reach Orca's MCP tools
  from inside a governed lane, Codex under `--sandbox read-only` and
  `workspace-write` alike. There is no CLI to prefer. See
  [`cli-capabilities.md`](cli-capabilities.md) for the version-stamped matrix and
  `npm run verify:cli-capabilities`, which re-proves it against your installed CLIs
  and fails if the behavior ever changes.

  **Never hand an executor full sandbox access to "fix" a suspected MCP problem.**
  Orca does not require a spawned executor to phone home: **process exit is the
  authoritative completion signal** and the daemon that spawned the child captures
  its output. MCP callback is for richer mid-run reporting; a lane that cannot reach
  MCP still runs, completes, and gets audited.

  Genuine CLI quirks worth knowing: a sandboxed `codex exec` cannot bind localhost
  ports (grant that access explicitly if a lane must serve a preview), and
  `codex exec` has no `-a/--ask-for-approval` flag — use `-c approval_policy=...`.
- **Done executors linger, then drop off the dashboard.** A finished executor
  stays visible for a few minutes, then ages out of the dashboard projection.
  That is expected pruning, not lost work — the lane's artifacts (`outcome.txt`,
  `transcript.json`) persist on disk regardless.
