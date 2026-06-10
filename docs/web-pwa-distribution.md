# Web/PWA distribution

Orca can run without the Tauri desktop wrapper. The validated host path today is
macOS: the user runs the Node server locally and opens the dashboard in a
browser. Windows and Linux are intended portable host targets, but they have not
been release-validated yet.

## What users get today

- Same local HTTP API and dashboard as the desktop app.
- Same pairing, auth, provider, live-link, MCP, evidence, backup, and security
  routes.
- PWA install support from browsers that expose an install action.
- Tailscale Serve private phone access when Tailscale is installed and
  configured by the user.

## What users do not get without Tauri

- No native app bundle or installer.
- No native menu/tray controls.
- No automatic server lifecycle on app launch.
- No OS credential storage for `ORCA_API_TOKEN`; use a local env var or
  a user-managed service wrapper.
- No Tauri updater.

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
npm install
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

## Native installer roadmap

The macOS Tauri app is the first production installer path. Windows and Linux
native installers should be added after the macOS release path is proven:

- Windows: Tauri build target, Windows credential backend validation, code
  signing certificate, installer format, and updater validation.
- Linux: Tauri build target, Secret Service/libsecret validation, AppImage/deb/
  rpm packaging decision, desktop integration, and updater validation.
