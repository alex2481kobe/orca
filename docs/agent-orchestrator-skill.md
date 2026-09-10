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

## Tool names and call shape

This document names tools by their contract id (`executor.spawn`). Your MCP
client lists the same tools with `__` in place of each `.` — `executor__spawn`,
`lane__terminal__tail`, `audit__queue_one`. Path ids (`orchestratorId`, `laneId`,
`projectId`) are top-level arguments; everything else a mutating tool takes goes
inside a `body` object:

```
orchestrator__register { body: { cwd: "/abs/path/to/project", title: "Auth refactor" } }
  → { id: "orc_…", projectId: "prj_…", … }        keep both ids
orchestrator__status   { orchestratorId: "orc_…" }
executor__spawn        { orchestratorId: "orc_…", body: { title, executorType, taskPrompt, … } }
lane__get              { laneId: "…" }
```

A path id defaults from the connection only when the connection was started with
it (spawned lanes are). Registering does not change those defaults, so pass the
`orchestratorId` you got back on every later call. Your MCP client's tool list is
authoritative — the surface is deliberately small and changes; do not call a tool
you cannot see in it.

## Connecting: install the MCP server at user scope

For Claude Code, register Orca at **user** scope:

```bash
claude mcp add -s user orca -- node /absolute/path/to/orca/src/mcp-server.js
```

`claude mcp add` defaults to **local** scope: the server is recorded for the one
directory you ran the command in and does not exist anywhere else. An
orchestrator that added Orca from one directory and later worked from another
silently had no Orca tools at all. `-s user` (long form `--scope user`) makes
Orca available from every directory. If you already added it without a scope,
remove that entry from the directory where you added it
(`claude mcp remove orca -s local`) — Claude Code prefers a local entry over the
user one there.

Codex has no scope flag: `codex mcp add` already writes your user config
(`~/.codex/config.toml`). Do not add `-s` to the Codex command.

**The bootstrap endpoint's Claude one-liner has no scope today.**
`POST /api/mcp/orchestrator-bootstrap` returns `bootstrap.clients.claudeCli.command`
as `claude mcp add orca …` with no `--scope`, so as-is it also registers at local
scope. Insert `-s user` after `mcp add` before you run it. The response's
`globalInstall` block is unrelated to scope: it is the same configs launched
through an `orca-mcp` command on your PATH, which exists only after `npm link` in
an Orca checkout (Orca is not published to npm). Use the `clients` block.

## Current limitations — read before you start

These describe Orca as it behaves today.

- **Never start a second daemon against the same working directory.** Orca keeps
  its state in `.orca/` under the daemon's working directory. A second start
  against that directory loads the state *before* it tries to bind the port, and
  its startup recovery can kill the running daemon's executor processes and mark
  their lanes failed. Only then does it fail with `EADDRINUSE`. There is no
  instance lock yet. If a tool call fails because Orca seems down, check before
  anyone starts it — `curl -s http://127.0.0.1:3000/api/health` or
  `lsof -nP -iTCP:3000 -sTCP:LISTEN` — and stop the existing daemon first. Never
  "restart Orca" as a reflex.
- **Your lease expires and nothing renews it.** Polling keeps your orchestrator
  alive, not your credential. See "Two clocks" below.
- **`orchestrator.status` only sees lanes Orca manages.** An agent launched
  outside Orca — a CLI in another terminal, a subagent of your own client — has no
  lane record, no isolation, no audit, and appears in neither status nor the
  dashboard. Wanting a particular model is never a reason to go around Orca:
  `executor.spawn` takes `model` per lane.
- **One lease is one orchestrator identity per project.** Orca matches your
  orchestrator by project plus lease. A user-scope MCP config carries one lease, so
  every client session using that config on the same project shares one
  orchestrator record: concurrent sessions are not separate orchestrators.
- **Tokenless wiring does not refresh on re-register.** Without a lease (the bare
  loopback quickstart) every caller shares the `dashboard` identity, and
  re-registering the same `cwd` creates another orchestrator record instead of
  refreshing yours. Keep the `id` from your first `orchestrator.register` and pass
  it as `orchestratorId`, or use a minted lease — the bootstrap endpoint works on a
  loopback daemon without an API token too.
- **Writer isolation is decided per orchestrator.** `auto` worktree mode counts
  competing writers only among *your* orchestrator's lanes. Two orchestrators on
  the same checkout can each get a "sole writer" lane running directly in it.
  Coordinate, or pass `worktreeMode: "isolated"`.

## Two clocks: orchestrator staleness vs lease expiry

Two different things expire, and polling touches only one of them.

| clock | what it is | what refreshes it | when it runs out |
| --- | --- | --- | --- |
| orchestrator staleness | `lastSeenAt` on your orchestrator record | polling `orchestrator.status` with the lease that owns it; re-registering | after ~15 minutes without a refresh *and* with no live lanes, the orchestrator counts as stale and another agent may take it over (`takeoverOrchestratorId`) |
| lease expiry | `expiresAt` on the tool lease in your MCP config | **nothing** — no call extends it | at `expiresAt`, every call made with that lease fails |

Lease lifetimes as minted today:

- `POST /api/mcp/orchestrator-bootstrap`: **12 hours** when `ttlMs` is omitted.
- `POST /api/agent-tools/leases`: **15 minutes** when `ttlMs` is omitted (an
  explicit `"ttlMs": null` on either route also gives 15 minutes).
- `ttlMs` is clamped to between 30 seconds and 24 hours. Pass `"ttlMs": 86400000`
  for the maximum.
- Each executor lane gets its own 24-hour lease automatically — so an
  orchestrator on a default 12-hour lease can expire while the executors it
  spawned still hold valid ones.

The bootstrap response carries `lease.expiresAt`. Note it.

**Symptom of an expired lease:** calls fail with
`401 {"error":"Tool lease has expired."}`, and `orchestrator.status` reports
`"activeOrchestrator": {"active": false, …}`, because an orchestrator whose lease
is no longer valid counts as stale.

**Recovery today** is manual:

1. Mint a new lease: `POST /api/mcp/orchestrator-bootstrap` with
   `{"actor":"<the same actor as before>","ttlMs":86400000}`. This needs
   workstation admin (the API token, or a tokenless loopback daemon). Minting
   again with the same `actor` revokes that actor's other live lease, so give each
   independent configuration its own actor.
2. Replace the token in your MCP config. For Claude Code:
   `claude mcp remove orca -s user`, then the `-s user` add command with the new
   `ORCA_TOOL_LEASE_TOKEN`. For Codex or Claude Desktop, edit the config file.
3. Restart the client session. The MCP bridge reads its token once, when it
   starts, so a running session keeps sending the dead token until it restarts.
4. Re-register with the same `cwd`. Because the old lease is dead your old
   orchestrator record is stale, and a registration with the same actor rebinds
   it — same id, same lanes — to the new lease. Or pass `takeoverOrchestratorId`
   explicitly.

A managed re-mint and revoke flow is Stage 5 of the
[hardening scope](audits/2026-09-10-hardening-scope/README.md); it does not
exist yet.

## Role

The orchestrator owns lane decomposition, executor selection, progress review, and
audit quality. It does not bypass Orca's contracts, approval gates, or lane
isolation.

## Lifecycle (the loop)

1. **Register.** Call `orchestrator.register { body: { cwd, title?, focus?,
   approvedCapacity? } }` with the project working directory. Orca binds you to
   that project (keyed by the real path of `cwd`, which must lie inside the
   daemon's approved roots) and shows you on the dashboard. Keep the returned `id`
   (your `orchestratorId`) and `projectId`. Registered orchestrators are the only
   actors allowed to spawn and audit; unregistered mutating calls are refused.
2. **Refresh your title and focus.** There is no separate status-push tool.
   Re-call `orchestrator.register` with the same `cwd` on the same lease — it
   updates the self-authored `title` + `focus` line in place (but see the
   tokenless caveat above). Poll `orchestrator.status` for the lane tree,
   capacity, and the next required tool; polling it keeps your orchestrator from
   going stale. It does **not** extend your lease.
3. **Spawn — and choose each lane's model here.** Every executor you need goes
   through `executor.spawn`, including one that must run a particular model:
   `model` is a per-lane field. Do not launch a CLI yourself to get a different
   model — a worker started outside Orca has no lane, no isolation, no audit, and
   nothing on the dashboard.

   ```
   executor__spawn {
     orchestratorId: "orc_…",
     body: {
       title: "Scout the session flow",
       executorType: "codex",
       taskPrompt: "Read-only: map how sessions are issued; report file:line evidence.",
       model: "<a model name your codex CLI accepts>",
       permissionsProfile: "read-only",
       intelligenceProfile: "high",
       approved: true
     }
   }
   ```

   There is no capability-discovery tool; these are the values:
   - `title` is required. `taskPrompt` is the executor's instructions.
   - `approved`: the default policy requires approval to spawn, so a spawn
     without `approved: true` is refused with `409` and `requiresApproval: true`.
     Pass it only when the spawn really has been authorized — it records that
     authorization; it does not create it.
   - `executorType`: `codex`, `claude`, `gemini-cli`, `composer-cli`, or `mock`
     (plus `cli` only when the operator enabled a generic CLI profile). An
     unsupported type is refused with the supported list. **Omitted, it is
     `mock`**, which runs no real agent.
   - `model`: per lane, passed straight through to that CLI's `--model` (Codex,
     Claude, `gemini-cli` and `composer-cli` alike). Omit it for the CLI's own
     default. Orca ships no model list and does not validate the name — the CLI
     does, so a name it rejects shows up as a failed lane: read `lane.get`
     (`resultText`, logs) or `lane.terminal.tail`. Names are trimmed to 120
     characters.
   - `permissionsProfile`: how much the lane may do. Orca maps the string per
     CLI, so it does not mean the same thing everywhere:
     - Codex: `read-only` / `plan` / `ask` / `default` → `--sandbox read-only`;
       anything else, blank included, → `--sandbox workspace-write`. A Codex lane
       is always sandboxed.
     - Claude: passed verbatim as `--permission-mode` (`auto-edit` →
       `acceptEdits`, `bypass` → `bypassPermissions`); blank leaves the CLI's
       default. Orca routes Claude's permission prompts to you (`approval.list` /
       `approval.respond`) for every value **except** the force modes (`auto`,
       `auto-edit`, `auto-accept`, `bypass`, `force`, `yolo`), which self-approve.
     - `gemini-cli`: `--approval-mode`, unless the value is a plan/read-only one.
       `composer-cli`: only a force mode matters (it becomes `--force`).

     **For a scout or scoper lane, pass `read-only`** — on Codex that is an
     OS-enforced read-only sandbox. The exact string `read-only` also marks the
     lane a non-writer: it runs in the checkout without a worktree under `auto`,
     and it does not count as a competing writer for other lanes. Caveat for
     Claude: `read-only` is passed through as `--permission-mode read-only`,
     which is not one of Claude Code's modes (`acceptEdits`, `auto`,
     `bypassPermissions`, `manual`, `dontAsk`, `plan` in 2.1.267), so such a
     lane is likely to fail at launch. For a Claude scout use `plan` — and know
     that Orca then treats the lane as a writer for isolation purposes.
   - `intelligenceProfile`: reasoning effort. Codex accepts
     `minimal|low|medium|high|xhigh`; Claude accepts `low|medium|high|xhigh|max`
     plus `ultracode`. `gemini-cli` and `composer-cli` ignore it.
   - `worktreeMode`: `auto` (default) or `isolated` — see "Worktree isolation is
     conditional" below. Any other value is silently treated as `auto`, not
     rejected.
   - `idleShutdown`: default `true` — a running lane with no output or tool
     activity for the idle window is reaped. Pass `false` for a lane that is
     legitimately quiet for a long time.
   - `targetUrl` / `verificationCommand`: optional. A `targetUrl` puts the lane
     under the captured-evidence rule in step 5.

   **A spawn past your capacity is refused, not queued** — see "Lane capacity".
4. **Monitor.** Watch executors:
   - `lane.list` — all lanes for the project and their state.
   - `lane.get` — full detail for one lane (contract, logs, changed files,
     `resultText` — read this to see WHY a lane failed).
   - `lane.terminal.tail` — raw terminal output for a running lane; poll with
     `nextOffset`.
   - `lane.terminal.write` — answer a prompt a worker is blocked on. This is the
     one way to type into a running executor; the dashboard has no such control.
5. **Audit — one verdict call per lane.** When an executor submits (or exits),
   review its real output, then make **one** of these calls. Each applies its
   verdict immediately:
   - `audit.accept { laneId, body: { findings, reviewedFiles } }` — accept.
   - `audit.request_fix { laneId, body: { findings, nextTask } }` — send it back.
   - `audit.block { laneId, body: { reason, findings } }` — stop it. `reason` is
     required.
   - `audit.findings.record { laneId, body: { verdict, findings, reviewedFiles } }`
     — the same thing as one call: `verdict` (`accepted`, `fix_requested` or
     `blocked`) is required and is applied at once.

   **`audit.findings.record` does not stage findings for a later accept.** After
   it records `verdict: "accepted"` the lane is already accepted, and a following
   `audit.accept` is refused with `409`, because an accepted lane is no longer in
   an auditable state. `audit.queue_one` queues a lane for audit if auto-audit has
   not already done so.

   Do not treat an executor's own summary as final; audit it. Two server-side
   gates refuse an empty sign-off with `409`:
   - Accepting requires at least one finding or one reviewed file — in the call
     itself, or recorded on the lane by an earlier audit call.
   - A lane that has a `targetUrl` (UI/browser work) additionally requires
     **captured evidence** — a `.png/.jpg/.gif/.webp/.svg/.pdf/.mp4/.webm`
     artifact on the lane. Check with `lane.artifacts.list` / read it with
     `lane.artifacts.get` before accepting; if there is none, `audit.request_fix`
     and tell the executor to capture a screenshot.
6. **Land isolated work.** A lane that ran in its own worktree is not in the
   project checkout yet. `lane.integrate` merges it only when the lane is
   isolated, audit-accepted, its executor process has exited, and its worktree
   has **no uncommitted changes**. Integration merges the lane branch's
   *commits*; edits that were never committed would be left behind, so Orca
   refuses with `409` and `dirty: true`, listing `changedFiles`, `worktreePath`
   and `branch`. Tell isolated writers to commit their scoped changes on the lane
   branch before they submit; if one could not, commit those files yourself in
   `worktreePath` and integrate again. `body.push: true` also pushes, and
   requires workstation admin auth. `lane.worktree.discard` throws the worktree
   away instead. Lanes that ran directly in the checkout have nothing to merge —
   `lane.integrate` refuses them by design.
7. **Resign.** When the work is done, call `orchestrator.resign` so Orca stops
   listing you as an active orchestrator for the project.

## Worktree isolation is conditional

`executor.spawn` takes `worktreeMode`, and the default is `auto`:

- **read-only or sole-writer lanes run directly in the project checkout** — no
  worktree. Do not force one for a scout or a lone writer.
- **only overlapping writers get a dedicated isolated worktree.** Only the exact
  `permissionsProfile: "read-only"` counts as a reader, and writers are counted
  among your own orchestrator's lanes only.

Pass `isolated` explicitly when you know a lane needs its own worktree even though
`auto` wouldn't give it one, and keep concurrent writers file-disjoint. Two
current behaviors to know: any value other than `auto` or `isolated` is silently
treated as `auto`, and `isolated` in a directory that is not a git working tree
runs the lane directly in that directory, because there is nothing to branch.

When the project checkout already has dependencies, Orca links every existing
root and package/app `node_modules` directory into a new isolated worktree at the
same relative path. This lets the lane run the prepared toolchain without an
install or network access. The link targets are shared and mutable: executors may
run existing tools, but must not run dependency install, update, or prune commands
inside the lane. If the checkout has no prepared dependencies, or only some links
can be created, the lane records a visible toolchain warning instead of silently
pretending its checks can run.

**An isolated worktree is not reclaimed for you.** Retention pruning deliberately
*skips* an isolated lane that still holds un-integrated work — record and worktree
both stay on disk indefinitely, so nothing silently deletes unmerged code. You
release it by finishing the lane: `lane.integrate` (merge it back) or
`lane.worktree.discard` (throw it away). `lane.delete` also removes the worktree,
but only for a terminal lane and it takes the record with it.

## Lane capacity

Each orchestrator has a capacity: how many of its lanes may be live at once.
Auditor lanes do not count; a lane that has submitted but whose process is still
running keeps its slot until it exits.

- **Spawning past capacity is refused, not queued.** `executor.spawn` returns
  `409` ("Orchestrator is at capacity") with a `nextAction`. Wait for a lane to
  finish, or accept or stop one, then spawn again. A lane spawned within capacity
  starts as `queued`, and the scheduler starts it on its next tick.
- **You can set it at registration.** `orchestrator.register` accepts
  `approvedCapacity` (alias `laneConcurrencyLimit`; if you pass both they must
  match). Re-register with the same `cwd` on your lease to change it. Values are
  clamped to 64. Do not pass `0`: it switches the spawn-time check off, but the
  scheduler then has no slot to start anything, so lanes stay `queued`.
- **The default comes from the server.** `ORCA_LANE_CONCURRENCY` on the Orca
  server process (default **4**, clamped to 64) is the capacity a new
  orchestrator record gets when registration does not set one. It is read when the
  server starts and is not retro-applied: an orchestrator already persisted in
  `.orca/state.json` keeps its stored capacity until a registration changes it.

## Lane controls, approvals, and events

`lane.controls.update` adjusts a lane's contract fields after spawn: `model`,
`permissionsProfile`, `intelligenceProfile` (reasoning effort — the field is not
called `effort`), and — when the user left them blank — `targetUrl` and
`verificationCommand` you have learned for this work. Setting `targetUrl` is what
puts the lane under the captured-evidence rule above. It changes the stored
settings only: a CLI that is already running keeps the model and permissions it
was launched with. `lane.shutdown`, `lane.retry`, and `lane.delete` cover stop,
re-run, and cleanup. Like spawning, `lane.controls.update` and `lane.shutdown`
are approval-gated by the default policy.

When an executor needs a gated action it surfaces an approval: `approval.list`
then `approval.respond`. A governed Claude executor **blocks** until you decide.

`event.drain` is the only event tool — there is no ack or replay call, because
draining IS the acknowledgement. Whatever a drain returns is consumed and will
never be returned again, so **persist the events before you act on them**; if
your call fails mid-processing, those events are gone. Query params: `limit`,
`type`, `afterSeq`.

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

- `ORCA_REPO_ROOTS` — the directories you may register in (comma- or
  newline-separated absolute paths). The daemon's own working directory is always
  added, even when this is set. Unset, the approved root is the home directory
  (plus the working directory if it lies outside home). Registering a `cwd`
  outside them is refused with `422`.
- `ORCA_LANE_CONCURRENCY` — default capacity for newly registered orchestrators
  (default 4, max 64). See "Lane capacity".
- `ORCA_LANE_IDLE_TIMEOUT_MS` — how long a *running* lane may produce no output
  or tool activity before it is stopped as idle (default 900000 = 15 min). `0`
  does **not** disable it today: the value falls back to the 15-minute default.
  A lane spawned with `idleShutdown:false` is exempt.
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
