# Orchestrator agent skill

Use this document when an orchestrator agent is coordinating Orca work
for a user. Keep it public-safe and editable inside an installed app.

## Role

The orchestrator owns project/session direction, lane decomposition, tool
selection, progress review, and handoff quality. It does not directly bypass
Orca policy gates.

> **Executor note:** the in-app orchestrator *turn* (a headless lane Orca spawns
> for a session chat) defaults to **claude**, because claude's headless mode can
> drive Orca's MCP tools (approvals route through `--permission-prompt-tool`).
> Headless **`codex exec` cannot call MCP tools under a sandbox** (it cancels
> them unless run with full, unsandboxed access), so codex is best used as an
> *executor* doing scoped code work — not as the headless orchestrator. External
> interactive MCP clients (the Codex app, Claude Desktop, Claude Code CLI) are
> unaffected: they approve tool calls interactively and can orchestrate fully.

## Required behavior

- Read the current project, session, and lane state before assigning work.
- Use the agent-tool discovery contract instead of guessing route names.
- External MCP orchestrators must call `orchestrator.enroll` for the session
  before mutating it. Orca rejects unregistered mutating tool calls so every
  active orchestrator is visible in the dashboard/session state.
- Read `executor.capabilities` from discovery or the next-action envelope before
  spawning lanes. Pick models, permissions, intelligence/effort, MCP tools, and
  background-agent expectations from the selected executor's advertised
  capabilities.
- Create lanes only when the work is scoped, reviewable, and within capacity.
- Choose executor run mode through lane fields documented in
  `docs/agent-run-modes.md`; make high-risk modes such as auto-edit or bypass
  explicit in the lane.
- Assign exactly one owner per lane and name the expected reviewer.
- Prefer server-authoritative project live links over pasted local URLs.
- Ask executors to report any started dev server as a live link with label,
  URL, kind, and port.
- Health-check saved live links through Orca before telling the user a
  link is ready.
- Capture previews through saved evidence presets or future preview-target
  tools, not one-off URLs copied from chat.
- Require evidence for UI, browser, or artifact changes before acceptance.
- Use audit/critique tools for completed lanes instead of treating executor
  summaries as final.

## Executor lane lifecycle (the controls you have)

You drive executor agents entirely through lane tools — there is no separate
"agent process" surface. The lifecycle and the tool/route for each step:

- **Spawn** an executor: `lane.create` (POST `/api/sessions/:id/lanes`) with a
  chosen `executorType` (codex, claude, gemini-cli, custom-cli, an API provider,
  or `mock`). The lane shows up immediately in the session as a tracked lane.
- **Respawn** (re-run after stop/failure): `lane.retry`
  (POST `/api/lanes/:id/retry`).
- **Despawn / stop** a running executor: `lane.shutdown` (POST
  `/api/lanes/:id/stop`); clean up its worktree with the worktree-remove tool.
  The dashboard also exposes an operator **Stop lane** button.
- **Deactivate** work from the workflow: stop live lanes with `lane.shutdown`;
  use `audit.block` only for audit-stage work, or `task.update` with
  `state:"blocked"` for backlog items.
- **Pause new spawns** for a session: set `spawnPolicy: 'never'` (PATCH the
  session). New lanes stay `queued` until you restore `within_capacity`. This is
  the pause control — Orca does not suspend an already-running CLI process
  mid-turn (those are live OS processes); stop + retry is the model for that.
- **Cap concurrency**: `approvedCapacity` is a ceiling, not a target. The
  scheduler never runs more executor lanes than the approved capacity.
- **Worktree mode**: default `worktreeMode` is `isolated`, so git sessions create
  per-lane worktrees when possible. Use `session.worktree_policy.update` or
  `capacity.set_policy` with `worktreeMode: 'shared'` only when the user wants
  one checkout. In shared mode, keep lane ownership/file paths disjoint, avoid
  broad refactors, and prefer capacity `1` unless a supervisor explicitly accepts
  the conflict risk.

Executor activity is **read-only** to the operator: each lane streams structured
`agentEvents` (the "what is this executor doing" feed) plus raw terminal logs;
the dashboard renders them as a read-only monitor. Do not expect operators to
type into a running executor — they steer via stop/retry/audit/critique.

This whole flow (external-orchestrator bootstrap → session with orchestrator CLI
+ capacity → spawn/stop/retry/pause executor lanes → read-only events) is proven
by `npm run smoke:orchestrator-lifecycle`.

## Durable loop fields

Use `loop.create` when the user wants a daemon/soak/24-7 workflow instead of a
single executor pass. Important body fields:

- `runMode`: `nonstop` for always-on loops, or `bounded` for finite runs.
- `maxIterations`: finite cap for `bounded`; `0` means `nonstop`.
- `skills`: short skill references to apply on each iteration.
- `directives`: bounded user-approved operating rules injected into each
  loop-created task.

Skills and directives do not override Orca policy, approval gates, safety rules,
or lane scope. They are task context for the executors the loop queues.

## Configurable agent flow (read it from `session.next_action`)

The user (or you) can shape how work moves between agents via the layered `flow`
settings group (defaults → project → session → lane). Every `next_action`
envelope includes a `flow` block — **read it and obey it**; do not assume the
default loop. Fields:

- `flow.template`:
  - `orchestrator-only` — you do the work yourself; do **not** spawn executors.
  - `orchestrator-executor` — spawn executors; their results return to you.
  - `orchestrator-executor-audit` — executor work must be audited before it
    returns to you.
- `flow.auditTier`: `orchestrator` (you audit) or `separate-auditor` (spawn a
  dedicated auditor/mini-orchestrator lane to review, then report back to you).
- `flow.fixRouting`: when an audit requests a fix, send it to `same-agent`
  (`lane.retry`) or `new-agent` (`lane.create` a fresh executor). The envelope's
  `nextRequiredTool` already reflects this.
- `flow.maxAuditLoops` / `flow.loopsRemaining`: the audit→fix budget. When it hits
  zero a lane is **escalated** to the user (`lane_audit_escalated`) — stop looping
  and surface it.
- `flow.requireAuditPass` / `flow.returnToOrchestratorAllowed`: if
  `returnToOrchestratorAllowed` is false, the lane is **not** done — it must pass
  an audit (`audit.accept`) before you treat the work as complete.

## Filling in optional lane fields

`targetUrl` (dev/preview URL) and `verificationCommand` are optional. If the user
left them blank, **learn them and write them back** via `lane.controls.update`
(model/permissions/intelligence/targetUrl/verificationCommand). e.g. once you know
the dev server URL or how to verify the work, set them so evidence capture and
audits can use them. `targetUrl` is SSRF-validated server-side.

## Live project links

When a project has a running dev server, register it through
`project.quick_link.upsert` or the dashboard quick-link form. For a Vite app on
port 5173, use:

```json
{
  "label": "Example App",
  "url": "http://localhost:5173",
  "localUrl": "http://127.0.0.1:5173",
  "port": 5173,
  "kind": "vite",
  "favorite": true
}
```

Use `project.quick_link.health` to check a saved link. Do not run arbitrary URL
probes from agent text; Orca validates hosts and sensitive routes.

## Preview evidence

When a lane affects a web UI, docs app, generated artifact, or dashboard route,
ask for evidence against a saved preview target. The dashboard and API expose
lane evidence presets derived from the lane target URL and project live links.
Use those server-resolved presets so capture, health checks, and remote links
stay consistent.

Native mobile or desktop previews are optional host capabilities, not baseline
requirements. If a host does not report Android, Xcode, or Tauri preview support,
fall back to browser/PWA evidence and record the native preview as externally
blocked.

## Startup limits

An orchestrator can request server status or restart behavior only while a
Orca server or desktop host is already running. A stopped server cannot
start itself through its own MCP/API surface. Native startup belongs to the
Tauri host, a user-run CLI command, or an OS supervisor.

## Security rules

- Never ask for or print API tokens, provider secrets, pairing codes, or raw
  credential values in lane instructions.
- Do not enable public tunnels for dashboard access. Tailscale Funnel is out of
  scope for v1.
- Treat paired phones as operator devices, not host-admin devices.
- Keep install, shell, credential, and network mutation actions explicit,
  approval-gated, and auditable.
