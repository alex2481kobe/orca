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
PORT=3000 ORCA_HOST=127.0.0.1 \
  ORCA_API_TOKEN=$ORCA_API_TOKEN \
  npm run dev
```

The server binds to `127.0.0.1`. The dashboard is at <http://127.0.0.1:3000/>.

For durable Mac operation after the current terminal exits, use
[`macos-launchd-runbook.md`](macos-launchd-runbook.md). It keeps the API token
in a local `chmod 600` env file and keeps the launchd plist secret-free.

Set `ORCA_REPO_ROOTS` (comma-separated absolute paths) to restrict which
directories agents may register and work in. Without it the approved root
defaults to your home directory, and the server warns about that at startup.
Per-executor overrides follow the pattern `ORCA_<EXECUTOR>_BINARY` and
`ORCA_<EXECUTOR>_WORKDIR_ROOTS` — for example `ORCA_CODEX_BINARY` or
`ORCA_CLAUDE_BINARY`.

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
3. Before pairing, confirm the URL leaks nothing: `<base-url>/api/projects` and
   `<base-url>/api/mobile/manifest` must both return `401` with no project,
   orchestrator, or lane data. After pairing (browser session cookie), the same
   routes return your workspace.

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

- **Home** is an interactive node canvas of your projects, orchestrators, and
  executor lanes — pan, zoom, fit, and fullscreen. Three stat cards summarize
  "Active agents", "Queued agents", and "Idle / complete"; the Live links button
  opens a project's dev-server URLs over the tailnet.
- A node's status reads as Running, Spawning, Queued, Waiting, Complete, Idle,
  Failed, or Stopped.
- A node's `⋯` menu holds the break-glass controls described above.
- **Remote devices** on a phone shows this device's connection and an Unlink
  button. Each workstation is its own Tailscale URL, so switching workstations
  just means opening a different link.
- **Settings** is appearance only.

## 7. Shutdown

- `Ctrl-C` the `npm run dev` process.
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
- Unconfirmed destructive cleanup. Artifact cleanup refuses to delete anything
  without `confirmed: true` plus the approval policy check; use `dryRun: true`
  to preview.
- Hand-edited tokens in shell history; prefer `read -s`.
