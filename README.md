<div align="center">

<img src="public/orca-mark.png" alt="Orca" width="96" />

# Orca

### A local harness that lets the coding agents you already run spawn and depend on each other — and watch them from your phone.

Orca is a **local daemon**. It ships **no agent, no model, no API keys, and no chat
UI**. You keep working in Claude Code, Codex, or any MCP-capable agent; Orca is the
harness those agents register with so one of them can reliably **spawn a subagent,
wait on it, and judge the result** — instead of you babysitting terminals.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<img src="docs/assets/hero.png" alt="The Orca dashboard: a live node graph of orchestrator agents and their executor subagents" width="820" />

</div>

---

## Status: in development, deliberately scaled back

Orca was built out **too aggressively before it was validated** — it grew a chat UI, an
in-app composer, provider plumbing, and a pile of features that were never proven
useful. So it was cut back on purpose.

What's left is the part that actually earns its place: **a harness around the CLI
agents you already use.** Not a platform, not an agent, not another place to type
prompts. If you want a different model or a different CLI, you change nothing here —
Orca drives whatever you already run.

Expect rough edges and breaking changes. Validated on macOS with phone access.
Windows/Linux are not validated yet.

## What it does

You are already running coding agents. The hard part is making one agent lean on
**another** — hand it a scoped task, wait for it to finish, and know whether the work
is any good — without sitting in a terminal watching.

- **Agent spawns agent.** An orchestrator agent registers with Orca for its working
  directory, then spawns **executor** subagents — same CLI or a different one. Full MCP
  passes through, and the contract is enforced by the server, not by prompt text. The
  orchestrator can wait on a subagent and treat its process exit as the authoritative
  "done".
- **A review gate, not self-approval.** An executor submits work; it is not accepted
  automatically. The orchestrator audits it and either accepts, sends it back with
  required changes, or blocks it. You review outcomes instead of keystrokes.
- **Isolation when it matters.** Lanes default to `auto`: a read-only or sole-writer
  lane runs directly in the checkout, and Orca only creates a dedicated git worktree
  when writers would collide. Accepted isolated work can be merged back; rejected work
  is discarded with its worktree.
- **A window from your phone.** The dashboard is served over your own Tailscale
  tailnet: a live node graph of your agents, their subagents, their status, and the
  **preview URLs** of whatever they're building. Plus break-glass controls — stop one
  executor, stop everything under an agent, or close an agent.

## Quickstart

```bash
npm install

# Recommended: bound where agents are allowed to register and work.
# Unset, an agent can register any folder under your home directory. Orca also
# always allows its own working directory, even when this is set.
export ORCA_REPO_ROOTS="$HOME/code"     # comma-separated absolute paths

npm start          # daemon + dashboard on http://127.0.0.1:3000
```

**Run one daemon per working directory.** Orca keeps its state in `.orca/` under
the directory you start it from, and the daemon running there holds an exclusive
lock on it. Before `npm start`, check that nothing is already serving it — a
terminal you forgot, or the [LaunchAgent](docs/macos-launchd-runbook.md):
`curl -s http://127.0.0.1:3000/api/health`. If one is, a second start is refused:
it exits with code 1, prints the running daemon's pid and URL, and changes no
state and signals no process. Use that daemon, or stop it first.

Point your agent at it over MCP. Orca is a plain stdio MCP server, so **any
MCP-capable client works** — register it however that client registers MCP servers:

```bash
# Run from your Orca checkout — the package isn't published to npm, so point the
# client at the bundled bridge by absolute path.
claude mcp add -s user orca -- node "$PWD/src/mcp-server.js"
codex  mcp add orca -- node "$PWD/src/mcp-server.js"
```

Keep `-s user` on the Claude command. `claude mcp add` defaults to **local**
scope, which records the server for the one directory you ran it in — so adding
it from the Orca checkout leaves your agent with no Orca tools in every other
project, with no error to tell you why. Codex has no scope flag; `codex mcp add`
already writes your user config.

For any other client, the equivalent config is:

```jsonc
{ "command": "node", "args": ["/absolute/path/to/orca/src/mcp-server.js"] }
```

The connection defaults to the **orchestrator** role. (Executor subagents that Orca
spawns get their role and ids injected automatically — you never wire those.)

The command above works as-is against a loopback daemon with **no** API token:
Orca grants local admin when nothing is configured. **Once you set
`ORCA_API_TOKEN`** — which you must before reaching the dashboard from your phone
(see [`docs/tailscale-mobile-access.md`](docs/tailscale-mobile-access.md)) — that
bootstrap is deliberately off, and the bare command above gets `401
Unauthorized`. Give the agent its own scoped credential rather than your API
token. One command does it and registers the result at user scope:

```bash
ORCA_API_TOKEN=<your token> node "$PWD/src/orca-cli.js" connect claude   # or: connect codex
```

Or ask for the config yourself:

```bash
curl -sX POST http://127.0.0.1:3000/api/mcp/orchestrator-bootstrap \
  -H "x-orca-token: $ORCA_API_TOKEN" -H 'content-type: application/json' \
  -d '{"actor":"my-agent","ttlMs":86400000}'
```

That returns paste-ready MCP config for Claude Code, Codex, and any other client,
each carrying an `ORCA_REFRESH_TOKEN`: a credential that can only obtain
orchestrator leases. Your API token never reaches the agent, and the credential
can be revoked on its own. Before you paste it:

- **It reconnects by itself.** The bridge exchanges the credential for its own
  lease, every call renews that lease, and after a long idle the bridge gets a new
  one and repeats the refused call. No config rewrite, no restart. `ttlMs` sets
  the lease window (12 hours when omitted, 24 hours at most). See
  [Connecting and reconnecting](docs/agent-orchestrator-skill.md#connecting-and-reconnecting).
  When something does fail, `node "$PWD/src/orca-cli.js" doctor` says what and
  prints the fix.
- **The returned Claude command already carries `-s user`**, so running it from
  any directory registers Orca for every directory. The Codex command has no
  scope flag.
- **Check which Node it launches.** Every returned config runs an absolute Node
  plus Orca's bridge, so nothing has to be on your PATH. Without `nodePath`, Orca
  names the Node it runs on through its PATH entry (for example
  `/opt/homebrew/bin/node`) instead of the version-pinned install path behind it.
  Pass `"nodePath"` to choose one; it is kept exactly as given, so an alias keeps
  following its target. `bootstrap.runtime` reports the choice, and
  `bootstrap.runtime.warnings` says when that Node sits inside one installed
  version or inside another tool's private directory such as `~/.codex`. A
  `nodePath` that is missing, not executable, not Node, or older than Node 18.18
  is refused with `422`.
- **Give each separate client configuration its own `actor`.** Minting again with
  the same `actor` replaces that actor's credential and revokes every lease it
  issued; the response lists them in `bootstrap.leaseLifecycle.replacedCredentialIds`
  and `replacedLeaseIds`. A refused request (a bad `nodePath`, say) changes
  nothing.

Then, from inside that agent:

```
register me in Orca for my current directory, titled "Auth refactor"
spawn a read-only codex scout on model <a model your codex CLI accepts> to summarize src/, then report back
```

Each lane chooses its own CLI and model (`executorType` and `model` on
`executor.spawn`), so an orchestrator never has to launch an agent outside Orca
to get a different model. How to drive the loop: the
[orchestrator skill](docs/agent-orchestrator-skill.md) and the
[executor skill](docs/agent-executor-skill.md).

Watch it at `http://127.0.0.1:3000`, or from your phone once Tailscale is set up
(see [`docs/tailscale-mobile-access.md`](docs/tailscale-mobile-access.md)). To keep
Orca running after the terminal closes on macOS, use the
[LaunchAgent runbook](docs/macos-launchd-runbook.md).

## The loop

```
you, in Claude Code / Codex        Orca daemon                    dashboard
───────────────────────────        ───────────                    ─────────
orchestrator.register       ──▶    project = realpath(cwd)   ──▶  ┌─ Auth refactor ─┐
                                   agent bound to that dir        │ Running · claude │
executor.spawn              ──▶    launch · sandbox · capture     └────────┬─────────┘
                                   exit code = authoritative done      ┌───┴───┐
lane.get / lane.terminal.tail ─▶   read its output                  Refactor  Add
                                                                    token     rotation
audit.accept / request_fix  ──▶    accept, or send back with         store    tests
lane.integrate / discard           required changes                 Running   Complete
```

## Contracts & security

An executor is bounded by server-side gates, not by prompt text:

- **Scoped tool leases** — a SHA-256 token allowlist checked on every MCP/HTTP call.
  A lease is bound to its role's tool set, so a client can never call a tool the
  server didn't grant it.
- **A realpath workspace jail** — the executor runs in its orchestrator's directory
  (or a per-lane worktree) and cannot escape it.
- **The CLI's own sandbox** — e.g. codex `--sandbox read-only` (OS-enforced, a real
  read-only scout) vs `--sandbox workspace-write`.
- **Deny-by-default routes** — every `/api/*` route refuses unauthenticated callers
  except two intentionally public, data-free endpoints (`GET /api/health`,
  `GET /api/auth/status`). A sweep test enforces this.
- **Tailnet-only, fail-closed pairing** — the dashboard is private to your Tailscale
  tailnet (never a public Funnel), and a remote device sees nothing until it pairs
  with a one-time code over an HttpOnly session cookie.

Two auth tiers: **admin** (the workstation, or an API token) can mint pairing codes,
change network access, and revoke devices. **Operator** (admin plus any paired
browser) can read the workflow *and* use the break-glass stops. A paired phone is an
operator — it can stop a running agent, so pair only devices you trust.

## Remote access

Install the dashboard as a PWA and reach it from your phone over private Tailscale
Serve — no public exposure. Setup and teardown:
[`docs/tailscale-mobile-access.md`](docs/tailscale-mobile-access.md).

<div align="center">
<img src="docs/assets/phone-dashboard.png" alt="Orca on a phone: the live agent graph" width="250" />
<img src="docs/assets/pairing.png" alt="Pairing a device with a one-time code over Tailscale" width="540" />
</div>

## Roadmap

Today Orca is a simple harness: you drive it from your own agent, and it keeps the
spawn → audit → integrate loop honest. What's being built and tested next:

- **Always-on agents.** The daemon keeps an agent running and re-prompts it around
  the clock, so long work continues without you re-launching it.
- **"What's next" orchestration.** An orchestrator that picks the next task off its
  own backlog instead of waiting to be told each time.
- **A supervisor tier.** One agent overseeing your orchestrators, so multiple projects
  can make progress in parallel and reliably.

Each of these lands only once it's validated end-to-end — that's the lesson that
produced the current, smaller Orca.

## Architecture

A single always-on Node daemon with a hand-rolled stdio MCP bridge and **one runtime
dependency** (`@lydell/node-pty`, for the PTY). It holds the registry (projects,
orchestrator agents, executor lanes), the scheduler that launches and reaps
executors, the tool-lease auth, and the Tailscale/PWA remote surface. State lives
under `.orca/` in your working directory (`state.json`, paired-device sessions, and
per-lane worktrees); nothing leaves the box.

## License

[Apache-2.0](LICENSE).
