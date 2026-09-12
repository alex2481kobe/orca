<div align="center">

<img src="public/orca-mark.png" alt="Orca" width="96" />

# Orca

### A local harness that lets the coding agents you already run spawn and depend on each other — and watch them from your phone.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<img src="docs/assets/hero.png" alt="The Orca dashboard: a live node graph of orchestrator agents and their executor subagents" width="820" />

</div>

---

## What Orca is

Orca is a **local daemon**. It ships **no agent, no model, no API keys and no chat
UI**. You keep working in Claude Code, Codex, or any MCP-capable agent; Orca is the
harness those agents register with so one of them can **spawn a subagent, wait on it,
and judge the result** — instead of you babysitting terminals.

- **Agent spawns agent.** An orchestrator registers with Orca for its working
  directory, then spawns **executor** subagents — same CLI or a different one, each
  with its own model. The contract is enforced by the server, not by prompt text, and
  the subagent's process exit is the authoritative "done".
- **A review gate, not self-approval.** An executor submits work; it is not accepted
  automatically. The orchestrator audits it and accepts, sends it back, or blocks it.
- **Isolation when it matters.** Lanes default to `auto`: a read-only or sole-writer
  lane runs directly in the checkout, and Orca creates a dedicated git worktree only
  when writers would collide.
- **A window from your phone.** The dashboard is served over your own Tailscale
  tailnet — a live graph of your agents and their subagents, plus break-glass stops.

**Status: in development.** Orca was built out too aggressively before it was
validated, so it was cut back on purpose to the part that earns its place. Expect
rough edges and breaking changes. Validated on macOS; Linux is untested.

## What you need before you start

| what | why | how to check |
| --- | --- | --- |
| **Node ≥ 18.18.0** | the `engines` range in `package.json` | `node --version` |
| **git** | Orca creates lane worktrees with it | `git --version` |
| **macOS or Linux** | Windows is not supported | — |
| **an agent CLI, installed and logged in** | Claude Code, Codex, Gemini — whichever you intend to drive | `claude --version`, `codex --version` |

**Orca launches your agent CLIs. It does not install them, update them, or log into
them** — you do that yourself, once, the way that CLI wants. If `claude` runs and
answers in your terminal, Orca can drive it; if it does not, fix that first.

## Setup

Three commands, in order, on a machine that has never seen Orca.

```bash
git clone https://github.com/alex2481kobe/orca.git && cd orca
npm ci
node src/orca-cli.js setup --roots "$HOME/code" --connect claude --node /opt/homebrew/bin/node
```

1. **`git clone`** — Orca is not published to npm; you run it from a checkout, and
   that directory stays put.
2. **`npm ci`** — installs the one runtime dependency (a PTY binding) from the
   lockfile. *It worked:* `added 8 packages … found 0 vulnerabilities`.
3. **`setup`** — the whole first run, in one command. It records the **fence** (the
   only directories agents may ever work in), starts the daemon in a session of its
   own, and registers Orca with your agent CLI at user scope so its tools work from
   every directory. *It worked:* `Orca is running: pid …, http://127.0.0.1:3000.`
   followed by `Registered "orca" for Claude Code at user scope …`.

Then **restart your agent CLI sessions** so they load the new MCP server, and check
the install:

```bash
node src/orca-cli.js doctor
```

*It worked:* every line reads `ok` and the last line is `Nothing is failing.` The one
`warn` you should expect is `api-token` — that is [a security default](#security-defaults),
not a broken install. Every failing check prints the exact command that fixes it.

The same path with the **real output of every command** is
**[docs/adopter-acceptance.md](docs/adopter-acceptance.md)**;
`npm run smoke:adopter-acceptance` runs it hermetically and fails the build when any
of it stops being true.

### The three arguments to `setup`

- **`--roots`** is the fence. Absolute paths to existing directories, comma-separated
  or repeated. Agents may register, and executors may run, **only** under these — and
  no default lets them roam: with no roots Orca still runs and answers, but registers
  no agent and launches no executor. `$HOME` as a root is refused unless you add
  `--allow-home-root`. To let agents work on Orca itself, include this checkout. To
  change the fence later, run `setup --roots …` again; a running daemon keeps the
  fence it started with until you `stop` and `start` it.
- **`--connect claude`** registers Orca with that CLI at user scope (`--connect codex`
  for Codex; pass both to do both). Any MCP-capable client works —
  [docs/connecting-clients.md](docs/connecting-clients.md).
- **`--node`** is the Node path Orca writes into your client's config. Read the next
  section before you drop it.

`setup` also takes `--state-dir DIR` and `--port N` (the port also comes from `PORT`;
the default is 3000).

### The Node path Orca writes down

`connect` writes an **absolute Node path** into your client's MCP config, and
`service install` writes it into the LaunchAgent that starts Orca at login. If that
Node lives inside another tool's private directory (`~/.codex`, `~/.claude`) or inside
one installed version (`…/node-versions/v24.14.1/…`, `…/Cellar/node/26.8.2/…`), it can
be upgraded or deleted out from under you — and what breaks is a file Orca wrote, at
login, with nothing watching.

Orca does not install or manage Node. Pass a path **you** maintain. On macOS with
Homebrew that is `/opt/homebrew/bin/node`, which keeps pointing at the current Node
across upgrades; on Linux it is usually `/usr/bin/node`. To ask about a path before
you commit to it:

```bash
node src/orca-cli.js doctor --node /opt/homebrew/bin/node
```

`doctor`'s `node` check asks the same question on every run, about the path `connect`
and `service install` would write next.

## Running Orca

```bash
node src/orca-cli.js status   # running? pid, URL, state dir, fence  (exit 3 = not running)
node src/orca-cli.js stop     # refuses while executors run; --force stops them too
node src/orca-cli.js logs     # the daemon's log
node src/orca-cli.js gc       # what state retention would archive (dry run; --apply to do it)
node src/orca-cli.js service install   # macOS: also start at login, restart after a crash
```

**One daemon per machine, owned by no session.** `start`, `stop` and `status` find it
by the instance lock on its state directory and by its port — never by process name —
so they work from any directory. A second `start` reports the running daemon and
changes nothing. Closing the terminal, or ending the agent session that ran `setup`,
does not stop it.

**Where the state lives.** One per-user directory, never the directory Orca was
started from: `~/.local/state/orca` by default, `--state-dir` (on `setup`) or
`ORCA_STATE_DIR` to move it, and an install from before this keeps its
`<checkout>/.orca` in place. `status` prints which one is in use and where that came
from. It holds `state.json`, per-lane journals, paired-device sessions, per-lane
worktrees, lane artifacts and the daemon log. Clean it with `gc`: it changes nothing
without `--apply`, only ever *moves* into an archive, and refuses to `--apply` while a
daemon owns the directory. The full retention table is
[docs/state-retention.md](docs/state-retention.md).

Watch it at `http://127.0.0.1:3000`, or from your phone once Tailscale is set up
([docs/tailscale-mobile-access.md](docs/tailscale-mobile-access.md)). To start Orca at
login and restart it after a crash, see the
[LaunchAgent runbook](docs/macos-launchd-runbook.md).

## Driving it

Restart your client, then, from a directory inside the fence:

```
register me in Orca for my current directory, titled "Auth refactor"
spawn a read-only codex scout on model <a model your codex CLI accepts> to summarize src/, then report back
```

Each lane picks its own CLI and model (`executorType` and `model` on
`executor.spawn`), so an orchestrator never has to launch an agent outside Orca to get
a different model. How to drive the loop: the
[orchestrator skill](docs/agent-orchestrator-skill.md) and the
[executor skill](docs/agent-executor-skill.md).

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

## Security defaults

Read these as they are, not as you would like them to be:

- **Loopback only.** Orca binds `127.0.0.1`. Nothing is exposed to your network, and
  Tailscale Funnel is not part of the security model.
- **No `ORCA_API_TOKEN` means every process on this machine is Orca admin**, and role
  scoping is advisory. That is what `doctor`'s `api-token` warning is about. To fix
  it:
  ```bash
  (umask 077; openssl rand -hex 32 > ~/.config/orca/api-token)
  node src/orca-cli.js stop
  ORCA_API_TOKEN_FILE=~/.config/orca/api-token node src/orca-cli.js start
  ```
  Agents never receive that token: `connect` gives each client its own scoped
  credential, revocable on its own.
- **A token is required before you pair a phone.** Without one the pairing flow is
  refused, on purpose.
- **The fence is exact.** Only the roots you listed; the daemon's own working
  directory is never added, and no roots means setup-required rather than "anywhere".
- **A paired phone is an operator, not an admin.** It can read the workflow and use
  the break-glass stops — so pair only devices you trust. Admin (the workstation, or
  the API token) is what mints pairing codes, changes network access and revokes
  devices.
- **Every `/api/*` route refuses unauthenticated callers** except two deliberately
  public, data-free ones (`GET /api/health`, `GET /api/auth/status`). A sweep test
  enforces it.

An executor is bounded by server-side gates, not prompt text: a SHA-256 tool-lease
allowlist checked on every call, a realpath workspace jail, and the CLI's own sandbox
(`codex --sandbox read-only` is an OS-enforced read-only scout). More in
[SECURITY.md](SECURITY.md).

## Troubleshooting

| what you see | what it means | what fixes it |
| --- | --- | --- |
| `Orca is not running at http://…: the connection was refused` | the daemon is not up | `node src/orca-cli.js start` |
| `Orca is not set up: it has no approved roots` | no fence, so nothing can register | `node src/orca-cli.js setup --roots <dir>` |
| a tool call is refused, or `doctor`'s `credential` check fails | the client's credential was replaced or revoked — leases renew themselves, credentials do not | `node src/orca-cli.js connect claude` |
| `Port 3000 … is in use by something that is not Orca` | something else owns the port | `node src/orca-cli.js setup --roots <dir> --port 8730` (or `PORT=8730 …`; `start` takes `--port` too) |
| `An Orca daemon already answers at … but it does not own <state dir>` | a second Orca is on that port | `node src/orca-cli.js status` to see which, then move this one to another port as above |
| `claude is not on PATH. Run this yourself` | the agent CLI is not installed, or not on this shell's PATH | install and log into the CLI, then `node src/orca-cli.js connect claude` |
| `gc --apply` refuses because a process owns the state directory | a daemon holds the instance lock | `node src/orca-cli.js stop`, then re-run `gc --apply` |
| `Orca is unreachable-by-lock … It is NOT known to be stopped` | the lock names a machine this one cannot check | `node src/orca-cli.js stop --force` — only when that state directory is not shared with another machine |
| the agent has Orca tools in one directory but not others | `claude mcp add` was run without `-s user`, so it registered for one directory | `node src/orca-cli.js connect claude` |

`doctor` is the first thing to run for anything not in this table: every failing check
prints its own fix, and the `target` check is the one that says whether it is
describing the daemon you actually manage.

## Architecture

A single always-on Node daemon with a hand-rolled stdio MCP bridge and **one runtime
dependency** (`@lydell/node-pty`, for the PTY). It holds the registry (projects,
orchestrator agents, executor lanes), the scheduler that launches and reaps executors,
the tool-lease auth, and the Tailscale/PWA remote surface. Nothing leaves the box.

## Roadmap

Each of these lands only once it is validated end to end — the lesson that produced
the current, smaller Orca.

- **Always-on agents.** The daemon keeps an agent running and re-prompts it, so long
  work continues without you re-launching it.
- **"What's next" orchestration.** An orchestrator that takes the next task off its
  own backlog instead of waiting to be told.
- **A supervisor tier.** One agent overseeing your orchestrators, so several projects
  progress in parallel.

## Remote access

Install the dashboard as a PWA and reach it from your phone over private Tailscale
Serve — no public exposure. Setup and teardown:
[docs/tailscale-mobile-access.md](docs/tailscale-mobile-access.md).

<div align="center">
<img src="docs/assets/phone-dashboard.png" alt="Orca on a phone: the live agent graph" width="250" />
<img src="docs/assets/pairing.png" alt="Pairing a device with a one-time code over Tailscale" width="540" />
</div>

## License

[Apache-2.0](LICENSE).
