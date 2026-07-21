# Web/PWA distribution

Orca v2 ships as a Node daemon plus a read-only web dashboard — there is no native
desktop wrapper. The user runs the daemon locally and opens the dashboard in a
browser. The validated host path today is macOS; Windows and Linux are intended
portable host targets but have not been release-validated yet.

## What users get today

- Local HTTP API and the read-only dashboard (projects → orchestrators →
  executors).
- Pairing, auth, MCP, and security routes.
- PWA install support from browsers that expose an install action.
- Tailscale Serve private phone access when Tailscale is installed and
  configured by the user.

## Host lifecycle notes

- There is no native app bundle, menu/tray control, or auto-start on launch; the
  daemon is a plain Node process.
- Keep `ORCA_API_TOKEN` in a local env var or a user-managed service wrapper (see
  the durable-operation section below); there is no OS credential-store integration.

## Local web quick start

Prerequisites:

- Node.js `18.18.0` or newer.
- Git.
- Optional: Tailscale for private phone access.
- Optional: Playwright browser install if users want evidence screenshot
  capture.

Run:

```sh
git clone https://github.com/alex2481kobe/orca.git
cd orca
npm ci --ignore-scripts
ORCA_API_TOKEN="$(openssl rand -hex 32)" npm run dev
```

Open <http://127.0.0.1:3000/>.

Windows PowerShell token setup, for future Windows host validation:

```powershell
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$env:ORCA_API_TOKEN = -join ($bytes | ForEach-Object { $_.ToString('x2') })
npm run dev
```

The server binds to `127.0.0.1` by default. Keep it that way unless you are
intentionally fronting it with private Tailscale Serve.

## PWA install

Open the local dashboard in a Chromium-based browser and use the browser's
install action. The PWA still depends on the local Node server running; closing
the terminal or service that started `npm run dev` stops the backend.

## Durable background operation

macOS has a maintained LaunchAgent runbook:

- `docs/macos-launchd-runbook.md`

Windows and Linux should use their native service managers once those hosts are
validated. Those service wrappers are not yet packaged:

- Windows: Task Scheduler, NSSM, or a user-managed service wrapper.
- Linux: systemd user service.

Keep tokens in local user-owned env files or secret stores. Do not commit env
files or generated service configs containing tokens.
