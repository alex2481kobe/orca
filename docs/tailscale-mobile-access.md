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
# Optional: a separate worker token for heartbeat callers.
export ORCA_WORKER_TOKEN="$(openssl rand -hex 32)"
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

If you want stricter per-binary, per-workdir, or per-env settings, set
`ORCA_CODEX_BINARY`, `ORCA_CODEX_WORKDIR_ROOTS`,
`ORCA_REPO_ROOTS` (comma-separated absolute paths used to validate
lane workdirs), etc. before `npm run dev`.

## 3. Smoke the API + UI from the Mac

```bash
npm run smoke
```

This starts an isolated local test server and walks the full operator flow:
token auth, browser pairing, project/session/lane creation, mock lane
completion, MCP tool CRUD + Codex lane attachment, OpenAI-compatible and
Gemini dummy API provider lanes, evidence capture, audit, cleanup dry-run,
private-access fake states, PWA guards, notifications, import/export redaction,
and desktop/phone/lane screenshots. Exit code `0` means the app-side flow is
ready for live Tailscale verification.

## 4. Expose privately through Tailscale Serve

Default recommendation for v1 is HTTP over the tailnet. It keeps the URL as a
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
   dashboard loads but shows only the **pairing gate**: no projects, sessions,
   lanes, or settings until you pair. Generate a one-time pairing code on the
   workstation (Settings → pairing, or `npm run operator:pair`) and enter it on
   the phone. Do not put tokens or codes in URLs.
2. `<base-url>/api/health` — JSON `{ "status": "ok" }` (no counts; this is the
   only data-free public route besides `/api/auth/status`).
3. Before pairing, confirm the URL leaks nothing: `<base-url>/api/projects` and
   `<base-url>/api/mobile/manifest` must both return `401` with no project,
   session, or lane data. After pairing (browser session cookie), the same
   routes return your workspace.

The connected phone is an **operator**: it can run and customize the workflow
(projects, sessions, lanes, MCP tools, evidence, cleanup) but cannot perform
host administration (CLI reinstalls, provider secrets, private-access settings,
minting pairing codes, or app export). Those stay on the workstation. If any
step above fails, walk the steps before mutating anything from the phone.

## 6. Operating from the phone

- Use the project list to navigate sessions and lanes.
- Lane detail shows live logs, PID/exit metadata (for real lanes), and the
  attached MCP tools.
- Use the evidence panel to capture screenshots/traces/videos. Without
  Playwright installed the capture is recorded as degraded — see
  "Playwright" below.
- Approve high-risk actions explicitly. Stops, cleanups, reinstalls, and MCP
  changes all require an explicit `approved: true` (or the in-UI button).

## 7. Playwright (proven)

Playwright 1.60.0 is now in `devDependencies` and locked in
`package-lock.json`. `npm ci --ignore-scripts` installs the package; the first
`npx playwright install chromium` downloads the browser into
`~/Library/Caches/ms-playwright/`. After that,
evidence captures produce real PNG/zip/webm files served back via
`/artifacts/<session>/<lane>/<file>`.

If Playwright ever becomes unavailable (deleted node_modules, etc.) the
evidence runner falls back to `captured: false` with a `degraded`
marker. `/api/system/blockers` surfaces the exact `npm ci --ignore-scripts` command
and the dashboard banner shows it at the top — captures never silently
succeed.

## 7a. Browser UI smoke

```bash
ORCA_API_TOKEN=$ORCA_API_TOKEN \
ORCA_BASE_URL=http://127.0.0.1:3000 \
  npm run smoke:ui
```

This launches Chromium headless, loads the dashboard at 1366x900 and
390x844, asserts the operator shell renders, status tags exist, no text
overflows the viewport, and saves screenshots into
`artifacts/ui-smoke/{desktop,phone}.png`.

## 8. Shutdown

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

## 9. Things that must stay off

- Public Tailscale Funnel.
- Auto-seed of demo data (set `ORCA_SEED=1` only if you want a
  starter example project).
- Sweep destructive commands. Cleanup defaults to dry-run; live deletion
  requires `confirmed: true` plus approval.
- Hand-edited tokens in shell history; prefer `read -s`.
