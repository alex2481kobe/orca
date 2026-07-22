<div align="center">

<img src="public/orca-mark.png" alt="Orca" width="96" />

# Orca

### Your coding agents, spawning coding agents — supervised, isolated, and visible from your phone.

Orca is a **local daemon** — a loop and harness for the coding agents you already
run. It does **not** ship its own agent. You bring your existing CLI or desktop-app
agent (Claude Code, Codex, any MCP-capable agent), and Orca lets one agent reliably
**spawn and depend on subagents** — from the same CLI or a different one — with full
MCP, governed lanes, dynamic isolated git worktrees, and an audit → integrate/discard
loop.

It also gives those agents a **secure remote face**: over Tailscale, from your phone,
you see your registered agents, their working trees, and the live preview URLs of the
projects they are building — remotely and privately.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![local‑first](https://img.shields.io/badge/local--first-✓-success)
![PWA](https://img.shields.io/badge/PWA-installable-success)
![validated](https://img.shields.io/badge/validated-macOS%20%2B%20phone-lightgrey)

</div>

---

## What Orca is

You are already running coding agents. The hard part is making one agent reliably
lean on **other** agents — spawn a subagent, hand it a scoped task, wait on its
result, and know whether the work is any good — without babysitting a terminal.

Orca is the local daemon that does exactly that. You keep working in your normal CLI
or desktop agent; Orca is the harness those agents register with so they can spawn and
depend on subagents under hard, server-enforced contracts. Orca brings no model, no
API keys, no chat UI of its own — it drives the agent you already have.

## What you get

- **Reliable agent-spawns-agent.** An orchestrator agent registers with Orca for its
  working directory, then spawns **executor** subagents — from the **same** CLI or a
  **different** one — each into its own scoped lane. Full MCP passes through, and the
  contract is enforced by the server, not by prompt text. The orchestrator can wait on
  a subagent and treat its process exit as the authoritative "done" signal.
- **Governed lanes + dynamic isolated worktrees.** Each executor runs in its own
  dynamically created, isolated git worktree it cannot escape, under a scoped tool
  lease and the CLI's own OS-level sandbox. Orca reclaims the worktree automatically
  when the lane is deleted or pruned.
- **The audit → integrate/discard loop.** An executor submits its work; it is **not**
  self-accepted. The orchestrator audits the result and either integrates it or sends
  it back with required changes (or discards it). You review outcomes, you don't drive
  keystrokes.
- **A remote window into your agents.** The read-only dashboard is a PWA served over
  your own Tailscale tailnet. From your phone you see your registered agents, their
  working trees, lane status (`working`, `auditing`, `waiting for approval`, `done`),
  and the **live preview URLs** of the projects they are building — privately, with
  HttpOnly-cookie pairing and fail-closed remote access.

## The loop

```
you, in Claude Code / Codex          Orca daemon                 dashboard (read-only)
─────────────────────────            ───────────                 ─────────────────────
"register me here"        ──MCP──▶   project = realpath(cwd)  ▶  ▸ my-project (web/...)
                                     orchestrator bound to you      · Auth refactor
"spawn an executor to X"  ──MCP──▶   launch, sandbox, capture         ├ Rewrite scope · working
                                     supervise → exit = done          └ Add tests · done
audit → integrate/discard ──MCP──▶   accept lane, or request fix ▶     accepted ✓ / sent back
```

## Quickstart

```bash
npm install
npm start                 # Orca daemon on http://127.0.0.1:3000  (open it: the tree)
```

Point an agent at it over MCP (the orchestrator role mints a scoped lease):

```bash
# Run from your Orca checkout — the package isn't published to npm, so point the
# client at the bundled server by absolute path:
claude mcp add orca -- node "$PWD/src/mcp-server.js"   # or: codex mcp add orca -- node "$PWD/src/mcp-server.js"
```

Then, from inside that agent, register and spawn:

```
register me in Orca for my current directory, titled "Auth refactor"
spawn a read-only scout executor to summarize src/, then report back
```

Watch it at `http://127.0.0.1:3000`, or on your phone once Tailscale is configured
(see `docs/tailscale-mobile-access.md`).

## Contracts & security

An executor is bounded by server-side gates — not by prompt text:

- **Scoped tool leases** — a SHA-256-token allowlist checked on every MCP/HTTP call,
  so an executor can only call the tools its role grants.
- **A realpath workspace jail** — the executor runs in its orchestrator's directory
  (or a per-lane git worktree) and cannot escape it.
- **The CLI's own sandbox** — e.g. codex `--sandbox read-only` (OS-enforced, a true
  read-only scout) vs `--sandbox workspace-write` (writes jailed to the workspace).
- **Deny-by-default routes** — every `/api/*` route refuses unauthenticated callers
  (401/403) except two intentionally public, data-free endpoints (`GET /api/health`,
  `GET /api/auth/status`).
- **Tailnet-only, fail-closed pairing** — the dashboard is private to your Tailscale
  tailnet (never a public Funnel), and a remote device sees nothing until it pairs
  with a one-time code over an HttpOnly session cookie.

## Remote access

The dashboard is a read-only PWA you install from a browser and reach from your phone
over private Tailscale Serve — no public exposure. Full setup, verification, and
shutdown steps are in [`docs/tailscale-mobile-access.md`](docs/tailscale-mobile-access.md).

<div align="center">
<img src="docs/assets/phone-dashboard.png" alt="Orca dashboard on a phone" width="300" />
<img src="docs/assets/pairing.png" alt="Orca phone pairing gate" width="300" />
</div>

## Architecture

A single always-on Node daemon with a hand-rolled stdio MCP bridge and a
**single native dependency** (`@lydell/node-pty`, for the PTY). It holds the registry
(projects, orchestrators, executor lanes), the scheduler that launches and reaps
executors, the tool-lease auth, and the Tailscale/PWA remote surface. State is a
single local `.orca/state.json`; secrets never leave the box.

## Status

Validated on macOS with phone access. The register → spawn → supervise → audit loop is
verified end-to-end with a real executor (spawned in the repo, output captured,
completed) and with the two-stage break-glass stop killing a live agent.
Windows/Linux are future validation targets. This is an actively evolving project.

## License

[Apache-2.0](LICENSE).
