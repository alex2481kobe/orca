<div align="center">

<img src="public/orca-mark.png" alt="Orca" width="96" />

# Orca

### A local headquarters for your coding agents.

Orca is a **local-first daemon** that your Claude Code, Codex, or other MCP-capable
agents register with as they work. An orchestrator agent spawns **executor** agents
under hard, server-enforced contracts; Orca supervises them, captures their output
reliably, and shows the whole fleet as a live, read-only tree you can watch from
your desk or your phone over Tailscale.

You keep working in your normal CLI or desktop agent. Orca is the harness that lets
those agents rely on **other** agents without losing track of what is happening.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![local‑first](https://img.shields.io/badge/local--first-✓-success)
![PWA](https://img.shields.io/badge/PWA-installable-success)
![validated](https://img.shields.io/badge/validated-macOS%20%2B%20phone-lightgrey)

</div>

---

## What it does

You are already running coding agents. The hard part is *coordination*: which agent
is working in which project, what did it spawn, is it done, is it any good — and how
do you kill a runaway without babysitting a terminal. Orca is the control plane for
exactly that, and nothing more.

- **Agents register themselves.** An agent tells Orca "register me" with its working
  directory. Orca creates a project implicitly, keyed by that directory, and binds an
  orchestrator record to the agent's scoped lease. Any MCP-capable agent qualifies —
  Orca does not care what CLI or version it is.
- **Orchestrators spawn executors under contracts.** The orchestrator hands Orca a
  task; Orca launches the executor with the right sandbox/permission flags and a
  workspace jail the agent cannot escape. The orchestrator writes the instructions;
  the contract bounds what the executor can do.
- **The daemon supervises — you don't.** Orca owns the executor process, captures its
  output over the process's own stream (`--json` / `stream-json`), treats process exit
  as the authoritative completion signal, and reaps silent hangs. No more asking an
  agent "how's it going?".
- **You watch, you don't drive.** The dashboard is **read-only**: projects → their
  orchestrators (each with a self-authored title) → the executors they spawned, with
  live status tags (`working`, `auditing`, `waiting for approval`, `done`). Finished
  executors grey out and drop away. The only control is a two-stage **break-glass stop**
  for a runaway.
- **On your phone, privately.** The dashboard is a PWA served over your own Tailscale
  tailnet — no public exposure, HttpOnly-cookie pairing, fail-closed remote access.

## The loop

```
you, in Claude Code / Codex          Orca daemon                 dashboard (read-only)
─────────────────────────            ───────────                 ─────────────────────
"register me here"        ──MCP──▶   project = realpath(cwd)  ▶  ▸ my-project (web/...)
                                     orchestrator bound to you      · Auth refactor
"spawn an executor to X"  ──MCP──▶   launch, sandbox, capture         ├ Rewrite scope · working
                                     supervise → exit = done          └ Add tests · done
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

## Contracts

An executor is bounded by three server-side gates — not by prompt text:

- **Scoped tool leases** — a SHA-256-token allowlist checked on every MCP/HTTP call,
  so an executor can only call the tools its role grants.
- **A realpath workspace jail** — the executor runs in its orchestrator's directory
  (or a per-lane git worktree) and cannot escape it.
- **The CLI's own sandbox** — e.g. codex `--sandbox read-only` (OS-enforced, a true
  read-only scout) vs `--sandbox workspace-write` (writes jailed to the workspace).

Named contracts (a read-only *scout* vs a *builder* that can write and request
approval) that bundle these gates behind one choice are on the roadmap.

## Architecture

Zero-dependency Node HTTP server + a hand-rolled stdio MCP bridge. One always-on
daemon holds the registry (projects, orchestrators, executor lanes), the scheduler
that launches and reaps executors, the tool-lease auth, and the Tailscale/PWA remote
surface. State is a single local `.orca/state.json`; secrets never leave the box.

## Status

Validated on macOS with phone access. The register → spawn → supervise loop is
verified end-to-end with a real Claude executor (spawned, ran in the repo, output
captured, completed) and with the two-stage break-glass stop killing a live agent.
Windows/Linux are future validation targets. This is an actively evolving project.

## License

[Apache-2.0](LICENSE).
