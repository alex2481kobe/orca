# Runbook: Orca on Mac + Phone via Tailscale Serve

Goal: bring Orca up locally on the Mac and use it from a phone over
private Tailscale Serve. No public Funnel.

## 0. Prereqs (once)

- Tailscale installed and signed in on both the Mac and the phone, both on the
  same tailnet, MagicDNS on.
- Node 18.18+ installed on the Mac.
- This repo cloned locally (the directory is `orca/` after `git clone`).

## 1. Generate a strong API token

```bash
export ORCA_API_TOKEN="$(openssl rand -hex 32)"
```

Keep the token in a password manager or in `~/.orca.env` (chmod 600).
Do not paste it into chat, screenshots, or commit it.

## 2. Start the server (binds locally by default)

```bash
cd orca
ORCA_API_TOKEN=$ORCA_API_TOKEN node src/orca-cli.js start
```

`start` runs Orca in the background with that token, detached from this
terminal. To keep the token in an owner-only file instead of your shell, use
`ORCA_API_TOKEN_FILE` (see the [LaunchAgent runbook](macos-launchd-runbook.md)).

The server binds to `127.0.0.1`. The dashboard is at <http://127.0.0.1:3000/>.

**One daemon per machine.** If Orca may already be running (another terminal,
or the LaunchAgent), `start` reports it and changes nothing;
`node src/orca-cli.js status` shows it. The running daemon holds an exclusive
lock on its state directory, so a second daemon on the same state is refused: it
exits with code 1, names the running daemon's pid and URL, and changes no state
and signals no process.

For durable Mac operation after the current terminal exits, use
[`macos-launchd-runbook.md`](macos-launchd-runbook.md). It keeps the API token
in a local `chmod 600` env file and keeps the launchd plist secret-free.

Set `ORCA_REPO_ROOTS` (comma-separated absolute paths) to restrict which
directories agents may register and work in. Without it the approved root
defaults to your home directory, and the server warns about that at startup.
The server's own working directory is always approved as well, even when
`ORCA_REPO_ROOTS` is set.
Per-executor overrides follow the pattern `ORCA_<EXECUTOR>_BINARY` and
`ORCA_<EXECUTOR>_WORKDIR_ROOTS` — for example `ORCA_CODEX_BINARY` or
`ORCA_CLAUDE_BINARY`.

Other env vars worth knowing on this process:

- `ORCA_ALLOWED_HOSTS` — comma-separated extra `Host` header values accepted from
  **direct** (non-proxied) browser connections. Loopback names are always
  allowed and requests through Tailscale Serve are exempt (they authenticate
  normally), so you only need this when a browser reaches the server directly
  under some other hostname. It is the anti-DNS-rebinding gate: keep it empty
  unless you have that exact need.
- `ORCA_AGENT_TOOLS_BASE_URL` — the base URL the MCP bridge calls back on,
  default `http://127.0.0.1:3000`. If you run the server on any other port or
  host, every agent's MCP client must have this set to match, or its tool calls
  go nowhere. Orca exports it automatically into spawned lanes, and
  `orca-cli.js connect` writes the URL of the daemon your state directory
  actually owns into the client config it generates — so you set this by hand
  only to point a client, `connect` or `doctor` at a daemon this machine does
  not manage. Setting it in the environment overrides what they would resolve.
- `ORCA_LANE_CONCURRENCY` — the lane capacity (default 4, clamped to 64) an
  orchestrator gets when it registers without one. It is not the only way to set
  capacity: an orchestrator can pass `approvedCapacity` to `orchestrator.register`.
  The env var is read when the server starts and does not retro-apply to
  orchestrators already in `.orca/state.json`.
- `ORCA_LANE_IDLE_TIMEOUT_MS` — stop a running lane after this long with no
  output or tool activity (default `900000` = 15 min). `0` does **not** disable
  it today: it falls back to the 15-minute default. To exempt one lane, spawn it
  with `idleShutdown: false`.
- `ORCA_AUTO_AUDIT` — set to `false` to stop Orca from auto-queuing audits for
  finished lanes. On by default.

See [`agent-orchestrator-skill.md`](agent-orchestrator-skill.md) for how the last
three change what an orchestrating agent sees.

## 3. Smoke the API + UI from the Mac

```bash
npm run smoke
```

This starts an isolated local test server and walks the core flow: token auth,
browser pairing, orchestrator registration, executor lane spawn/monitor, audit
accept/fix, private-access states, and the dashboard. Exit code `0` means the
app-side flow is ready for live Tailscale verification.

## 4. Expose privately through Tailscale Serve

The default recommendation is HTTP over the tailnet. It keeps the URL as a
MagicDNS/private tailnet name and avoids advertising a public `*.ts.net` HTTPS
hostname, while still staying private to devices on the same tailnet.

```bash
# HTTP over Tailscale, private to the tailnet.
tailscale serve --bg --http=80 localhost:3000

# Verify what's published.
tailscale serve status
```

Expected HTTP URL shape: `http://<your-mac>/` through MagicDNS from devices on
the same tailnet.

Use HTTPS Serve only when you need secure-context browser features such as PWA
install behavior, stricter browser notification behavior, or APIs that require
HTTPS:

```bash
# HTTPS over Tailscale Serve, still private to the tailnet.
tailscale serve --bg --https=443 localhost:3000

# Verify what's published.
tailscale serve status
```

Expected HTTPS URL shape: `https://<your-mac>.<tailnet>.ts.net/`.

Funnel must be OFF. Check with:

```bash
tailscale funnel status
```

If it shows any Funnel entry, run:

```bash
tailscale funnel off
```

## 5. Verify from the phone (on the same tailnet)

Open the following in mobile Safari/Chrome:

1. `http://<your-mac>/` or `https://<your-mac>.<tailnet>.ts.net/` — the
   dashboard loads but shows only the **pairing gate**: no projects, orchestrators,
   executor lanes, or settings until you pair. Generate a one-time pairing code on the
   workstation — the **Remote devices** screen in the sidebar, or `npm run operator:pair`
   — and enter it on the phone. Do not put tokens or codes in URLs.
2. `<base-url>/api/health` — JSON `{ "status": "ok" }` (no counts; this is the
   only data-free public route besides `/api/auth/status`).
3. Before pairing, confirm the URL leaks nothing: `<base-url>/api/overview` and
   `<base-url>/api/mobile/manifest` must both return `401` with no project,
   orchestrator, or lane data. After pairing (browser session cookie), the same
   two routes return your workspace. (`/api/overview` is the read-only dashboard
   poll — projects, orchestrators, lanes. There is no `GET /api/projects`; that
   path is POST-only and a GET returns `404`, so it is not a useful check.)

### What a paired phone can and cannot do

A paired device is an **operator**, not a workstation admin. Be clear about this
before you pair a phone:

- **It can** read the whole workspace — projects, orchestrators, executor lanes,
  their status and live preview links.
- **It can** use the dashboard's break-glass controls: stop an executor, stop the
  agents under an orchestrator, and close (resign) an agent. These are real
  writes. A paired phone can kill a running agent.
- **It cannot** perform workstation admin: minting pairing codes, changing
  private-access/Tailscale Serve settings, revoking another device's session,
  minting host-level MCP credentials, running a fleet-wide stop, or granting a
  lane unsandboxed permissions. Those stay on the workstation.

There is no chat or prompt box on the phone. Orchestration itself is driven by
agents over MCP, not from the UI.

If you do not want a device to be able to stop your agents, do not pair it.

## 6. Using the dashboard from the phone

- **Home** is a welcome: that Orca is running, which state directory it is
  serving, how many projects, agents and lanes exist, and how many are running
  right now. It draws no agent graph — the work is in the projects.
- **A project** (tap it in the panel on the left) is an interactive node canvas
  of that project's orchestrators and executor lanes — pan, zoom, fit, and
  fullscreen. Three stat cards summarize "Active agents", "Queued agents", and
  "Idle / complete"; the Live links button opens that project's dev-server URLs
  over the tailnet. Every agent of the project is drawn, and every running lane;
  older finished lanes past the newest few per agent are counted on the agent's
  own node rather than drawn. The page is a real URL, so it can be bookmarked.
- A node's status reads as Running, Spawning, Queued, Waiting, Complete, Idle,
  Failed, or Stopped.
- A node's `⋯` menu holds the break-glass controls described above.
- **Remote devices** on a phone shows this device's connection and an Unlink
  button. Each workstation is its own Tailscale URL, so switching workstations
  just means opening a different link.
- **Settings** is appearance only.

## 7. Shutdown

- `node src/orca-cli.js stop`. Orca stops its running executor lanes as it
  exits, so `stop` refuses while any are running unless you pass `--force`. If
  Orca runs under launchd, the same `stop` unloads the job, so launchd does not
  start it again; killing the process only makes launchd start it again.
- If you used HTTP Serve:

```bash
tailscale serve --http=80 localhost:3000 off
```

- If you used HTTPS Serve:

```bash
tailscale serve --https=443 localhost:3000 off
```

- Or reset all Serve config on this device:

```bash
tailscale serve reset
```

## 8. Things that must stay off

- Public Tailscale Funnel.
- Auto-seed of demo data (set `ORCA_SEED=1` only if you want a
  starter example project).
- Hand-edited tokens in shell history; prefer `read -s`.
