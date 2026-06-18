<div align="center">

<img src="public/orca-mark.png" alt="Orca" width="96" />

# Orca

### Orchestrate fleets of Codex, Claude, and API-backed coding agents from MCP, CLI, desktop, web, or phone.

Orca is a **local-first MCP control plane** for multi-agent coding workflows. One
agent can coordinate a fleet of executor lanes across your projects: Codex can
manage Claude lanes, Claude can manage Codex lanes, and either can fan work out
to API-backed or custom CLI lanes while Orca enforces the workflow, captures
evidence, and keeps secrets on your workstation.

Use the surface that fits the moment: the web/PWA dashboard, the Tauri desktop
app, your phone over private Tailscale, an MCP client inside Codex or Claude, or
the `orca-agent` CLI from any shell-capable agent. The current validated setup is
a macOS workstation plus phone access; Windows and Linux are intended future
validation targets.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![local‑first](https://img.shields.io/badge/local--first-✓-success)
![PWA](https://img.shields.io/badge/PWA-installable-success)
![tested](https://img.shields.io/badge/tested-macOS%20%2B%20phone-lightgrey)

<img src="docs/assets/hero.png" alt="Orca dashboard" width="900" />

</div>

---

## Why Orca

You're already running coding agents. The problem is *coordination*: which agent is
on which task, in which project, is it done, is it any good, and who is allowed to
spawn the next lane? Orca is the local control plane for that.

- 🧭 **One command center, many entry points.** Use the dashboard, desktop app,
  phone, MCP, or `orca-agent` CLI. Every surface talks to the same server-side
  workflow and audit state.
- 🔁 **Cross-agent orchestration.** Let Codex manage a backlog and spawn Claude
  executor lanes, let Claude coordinate Codex lanes, or mix in API-backed agents
  when a task fits a model provider better than a terminal agent.
- 🤖 **Bring your own agents, with clear support boundaries.** Codex and Claude are
  the primary tested CLI/in-app orchestration paths. Orca also has wired profiles
  for Gemini CLI, Composer, custom CLIs, and OpenAI-compatible / Gemini / Kimi /
  DeepSeek / OpenRouter APIs; see the run-mode docs for what is tested versus
  experimental.
- 🧩 **Real orchestration, not a wrapper.** Orchestrator → executor → auditor roles,
  capacity limits, self‑critique gates, and "audit this lane" / "audit all done
  lanes" — with every state transition enforced server‑side.
- 📸 **Evidence built in.** Playwright‑backed screenshots, traces, videos, and logs
  captured per lane, viewable from anywhere.
- 📱 **Phone-ready without public exposure.** Scan a QR, enter a one-time code, and
  drive your agents from your phone over a private Tailscale link. The validated
  phone path is private web/PWA access; a native iOS shell is present for local
  builds.
- 🔒 **Private by design.** Nothing is exposed publicly. The session token lives in
  an HttpOnly cookie, secrets are referenced never echoed, and the tailnet URL alone
  leaks nothing until a device pairs.

<div align="center">
<img src="docs/assets/lane-detail.png" alt="Lane detail with live terminal and evidence" width="440" />
<img src="docs/assets/dashboard-light.png" alt="Light theme" width="440" />
</div>

## Quickstart

```bash
git clone https://github.com/alex2481kobe/orca.git
cd orca
npm install
npm start
```

Open **http://127.0.0.1:3000/**. Because you're on **localhost, this machine is your
workstation** — Orca trusts it with full control, no pairing or token needed. Keep
that terminal running; Orca lives as long as the `npm start` process does.

**Point it at your code.** Create a project and give it a **folder on this Mac** (an
existing directory — a git repo or any folder). That's how Orca "sees your files":
agents you launch run inside that folder (each lane in its own git worktree), so they
can read and edit that project's code. You pick the folder once per project; Orca only
touches folders you add. It starts empty — you bring the projects.

> Orca binds to **`127.0.0.1` (localhost)** by default — it's not on any network.
> To use it from your phone, see [Drive it from your phone](#drive-it-from-your-phone)
> below. Remote devices see nothing until they pair. For extra hardening you can also
> require auth on the workstation itself (no implicit local admin):
> ```bash
> ORCA_API_TOKEN="$(openssl rand -hex 32)" npm start
> ```

## Drive it from your phone

Keep Orca running on your Mac, front it with **Tailscale Serve**, and pair your phone
once. From then on you can open any project, kick off or stop an agent, watch logs,
and review screenshots — from the couch.

<div align="center">
<img src="docs/assets/pairing.png" alt="Pair a remote device with a QR code and one‑time code" width="620" />
&nbsp;
<img src="docs/assets/phone-dashboard.png" alt="Orca on a phone" width="240" />
</div>

Setup is in [`docs/tailscale-mobile-access.md`](docs/tailscale-mobile-access.md).
Tailscale Funnel (public exposure) is intentionally not supported.

## Drive it from your AI chat (MCP)

Don't want a terminal open per project? Point one chat — **Codex CLI / Codex app /
Claude Code CLI / Claude Desktop** — at Orca over MCP and let that agent
orchestrate everything. This is the core Orca loop: one trusted orchestrator agent
owns the plan, then Orca fans work out to executor lanes and routes results back
through critique and audit.

The primary tested MCP client paths are Codex and Claude. Other MCP-capable
desktop apps or CLI clients can use the same stdio server if they can launch a
local command with environment variables.

1. On the workstation, generate a scoped orchestrator config (dashboard →
   **Pair → Generate config**, or `POST /api/mcp/orchestrator-bootstrap`). It mints a
   short-lived orchestrator **tool lease** (never your API token) and prints a
   ready-to-run command. For Claude Code:

   ```bash
   claude mcp add orca \
     -e ORCA_AGENT_TOOLS_BASE_URL=http://127.0.0.1:3000 \
     -e ORCA_TOOL_LEASE_TOKEN=<scoped-lease-token> \
     -e ORCA_ROLE=orchestrator \
     -- node /abs/path/to/src/mcp-server.js
   ```

   (Codex CLI: `codex mcp add orca --env … -- node …`. Claude Desktop / Codex app:
   paste the generated JSON / TOML. Orca isn't on npm — the config uses an absolute
   `node` + `mcp-server.js` path, so no source checkout is needed.)

2. In the chat, tell it to act as the orchestrator. It will `session__next_action`,
   `orchestrator__enroll` to claim the session, load a backlog with `task__bulk_add`,
   and — with `spawnPolicy:"auto"` — Orca fans those tasks out across executor lanes
   up to capacity. Codex can supervise Claude lanes, Claude can supervise Codex
   lanes, and either can mix in API-backed or approved custom-CLI lanes. Each lane
   runs through executor → critique → audit → accepted. Ask it to *"show me the
   lanes"* and `orchestrator__status` returns a live tree. `orchestrator__resign`
   hands off.

The server enforces the workflow with `nextAction` envelopes, so the chat can't skip
steps. See [`docs/desktop-app-control.md`](docs/desktop-app-control.md).

Prefer the shell? **Companion mode** (`orca-agent`) lets *any* agent drive Orca from
the command line over the same hardened tool surface — zero setup on the local
workstation (`orca-agent start "My run"` provisions a lease, opens an auto-fan-out
session, and enrolls you). See [`docs/agent-companion-mode.md`](docs/agent-companion-mode.md).

## How it works

```text
  Control surfaces  —  choose one or combine them
  ──────────────────────────────────────────────────────────
    Codex app/CLI · Claude app/CLI  ── scoped MCP lease ┐
    orca-agent from any shell       ── scoped tool lease ├─►
    Dashboard / PWA / phone         ── browser session ──┘

  Your macOS workstation  —  local-first, never exposed publicly
  ──────────────────────────────────────────────────────────
    Orca server
       ├─ enforces leases, auth tiers, capacity, and nextAction workflow
       ├─ captures evidence, logs, screenshots, traces, and audit state
       └─► Orchestrator agent   (Codex / Claude / orca-agent)
              ├─► Executor lane   (Codex CLI)
              ├─► Executor lane   (Claude CLI)
              ├─► Executor lane   (API provider)
              └─► Auditor lane
```

- **Three trust tiers.** *Public* (liveness only) → *operator* (paired devices:
  control + read) → *admin* (the workstation itself: host config, credentials,
  pairing). A paired phone is always an operator, never an admin — a lost phone
  can't read secrets or change host settings.
- **Tiered data, not a firehose.** A lightweight poll + a revision‑signal SSE keep
  the UI live; full lane detail and the live terminal load only for what you're
  looking at.
- **Provider‑agnostic lanes.** Each lane runs through a validated provider profile
  with its own binary/model/permissions, isolated git worktree, and audit trail.

## Security you can trust

Orca treats agent‑spawning, file mutation, and remote access as privileged — and
backs it up:

- Session token in an **HttpOnly + SameSite + Secure** cookie (never in
  localStorage); the one‑time pairing code is never stored client‑side, and the
  admin API token is held **in memory only** — never written to web storage.
- An **anti‑DNS‑rebinding** Host‑header allowlist gates direct connections, so a
  malicious page that resolves its domain to `127.0.0.1` can't inherit local
  admin.
- Constant‑time token comparison, **SSRF‑hardened** URL policy (metadata/private/
  obfuscated hosts blocked), approval gates that can't be bypassed, and MCP/exec
  env hardening (no `PATH`/`LD_PRELOAD`/`NODE_OPTIONS` injection).
- Every server‑derived URL is escape‑ and scheme‑checked before render (no
  `javascript:` / quote‑breakout XSS); secrets are redacted from logs, errors,
  exports, and support bundles.
- A documented [route security matrix](docs/route-security-matrix.md) covers auth,
  validation, body/rate limits, and audit metadata across ~129 routes.

See [`SECURITY.md`](SECURITY.md) to report issues.

## Platforms

- **macOS workstation.** The validated host path today: run the local Node server,
  use the web/PWA dashboard, or build the native Tauri shell.
- **Phone over Tailscale.** The validated remote-operator path: pair once, then
  use the private web/PWA dashboard from a phone on the same tailnet.
- **iOS shell.** A native Tauri mobile shell exists for local builds, but the
  production-ready phone path is still the private web/PWA flow.
- **Windows / Linux.** The web server path is intended to be portable, but it has
  not been release-validated on Windows or Linux yet.
- **MCP / CLI control.** `orca-mcp` connects Codex and Claude desktop/CLI clients;
  `orca-agent` lets any shell-capable agent start sessions, add backlog items, and
  supervise lanes without being an MCP client.

## Docs

- [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`SUPPORT.md`](SUPPORT.md) · [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- [Tailscale mobile access](docs/tailscale-mobile-access.md)
- [Agent orchestrator / executor skills](docs/agent-orchestrator-skill.md)
- [Control Orca from a chat (MCP)](docs/desktop-app-control.md) · [Companion mode (drive Orca from any agent)](docs/agent-companion-mode.md)
- [Agent run modes and support matrix](docs/agent-run-modes.md)
- [Live project links](docs/live-project-links.md)

## License

[Apache-2.0](LICENSE) - use, study, modify, and share it under Apache 2.0 terms.

---

<details>
<summary><strong>Engineering proof</strong> (for the curious — Orca is heavily tested)</summary>

Don't rely on prose alone; the authority is the
[completion ledger](docs/full-buildout-ledger.md) and the smoke gates.

- `npm test` — **298 passing** unit/integration tests.
- `npm run smoke:acceptance` — one‑command end‑to‑end acceptance gate.
- `npm run smoke:ui-inventory` / `smoke:ui-contract` — desktop + 390px phone
  screenshots of every route with zero horizontal overflow and a shared design
  contract.
- `npm run smoke:no-hardcoded-colors`, `smoke:row-menu`, `smoke:remote-workstation`,
  `smoke:pwa-cache`, `smoke:security`, … — focused regression guards.
- The ledger tracks **26 areas — 25 implemented & proven, 1 externally blocked**
  (signed native packaging, which needs an Apple Developer ID).

</details>
