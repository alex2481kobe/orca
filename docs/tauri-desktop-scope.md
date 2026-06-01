# Tauri desktop app scope

Command Deck v1 remains PWA-first for phone use. The Tauri desktop app is the
packaged workstation shell for the same local server and security model, not a
second product.

## Web-only and desktop editions

- The web/PWA edition remains the portable operator UI. It works when a local
  Command Deck server already exists and can open saved project live links,
  pair phones, capture browser evidence, and run responsive/mobile-browser
  previews.
- The Tauri edition wraps the same web UI and local API. It owns workstation
  responsibilities that a browser page cannot own: server startup, restart,
  shutdown, OS credential storage, native menus, launch-at-login, host status,
  and optional native preview bridges.
- Do not fork product behavior between web and desktop. Share the same routes,
  registry, auth, audit, evidence, and quick-link contracts.

## Repo layout

- Keep the desktop wrapper in this repo under `src-tauri/`.
- Keep shared JavaScript server/frontend code in `src/`, `public/`, `scripts/`,
  and `test/`.
- Keep JavaScript-only operation available through `npm start` and
  browser/PWA access. Users who do not want a desktop wrapper should not need
  Rust, Cargo, or Tauri to run the web app.
- Keep desktop operation available through `npm run tauri:dev` and
  `npm run tauri:build`. The default build target is the unsigned macOS app
  bundle; signed DMG/notarized installer output belongs to the release
  packaging phase. Tauri-specific files, Rust commands, icons, capabilities,
  and packaging metadata stay under `src-tauri/`.
- Keep release packaging documented in `docs/tauri-release.md`. The updater
  private key and Apple signing/notarization credentials are never committed.
- Split into a second repo only if release channels, licensing, update
  infrastructure, or platform-specific packaging begins forcing separate
  version lifecycles. Until then, one repo keeps security policy and route
  contracts coherent.

## Product goals

- Start and stop the local Command Deck server from a native desktop app.
- Show the private phone URL, QR code, pairing code, and Tailscale status on
  first launch.
- Store the generated server API token in the OS credential store instead of
  asking the user to manage it manually.
- Keep phone login based on one-time pairing and revocable browser sessions.
- Keep provider API keys in OS credentials or env fallback, never in browser
  storage or project state.
- Keep Tailscale Serve private to the tailnet. Do not enable Funnel by default.

## Phase 1: macOS desktop shell

- Scaffold Tauri with the existing web app as the frontend. Implemented under
  `src-tauri/`.
- Run the local Node server as a native-managed process. Implemented for dev
  and macOS package-path smoke: dev mode uses the Tauri before-dev server, and
  direct/package runtime resolves bundled `src/`, `public/`, and `package.json`
  resources before starting `src/server.js`.
- Generate a random `COMMAND_DECK_API_TOKEN` on first launch. Implemented with
  a 32-byte random hex token.
- Store that token in macOS Keychain through the Tauri backend. Implemented
  through the cross-platform `keyring` crate, which maps to Keychain,
  Credential Manager, or Secret Service depending on OS support.
- Reuse the stored token for server startup on later launches. Implemented.
- Provide menu/tray actions for Open Dashboard, Copy Dashboard URL, Create
  Pairing Code, Restart Server, Stop Server, Check for Updates, Install Update,
  and Quit. Implemented.
- Surface server health, local URL, tailnet HTTP URL, HTTPS Serve URL, and
  active paired sessions. Server health and local URL are exposed through
  Tauri commands now; tailnet URL and paired-session display remain web UI/API
  surfaces.

## Cross-platform infrastructure

- Keep the Tauri command surface platform-neutral from the start.
- Use a credential backend interface with macOS Keychain, Windows Credential
  Manager, and Linux Secret Service implementations behind the same calls.
- Keep server process management behind one abstraction with platform adapters
  for macOS, Windows, and Linux.
- Build CI/package scripts so macOS, Windows, and Linux targets can be added
  without changing the web app.
- Initial manual packaging validation can happen on Windows first if that is the
  available test machine, but the source layout must not hardcode Windows-only
  paths or shell behavior.
- Treat the Node server as a managed app sidecar with explicit lifecycle states:
  token-ready, process-starting, health-ready, dashboard-opened, degraded,
  restarting, and stopped.
- Use `127.0.0.1:34125` by default, configurable with
  `COMMAND_DECK_DESKTOP_HOST` and `COMMAND_DECK_DESKTOP_PORT`. The host waits
  for authenticated `/api/auth/status` readiness so an unrelated process or
  wrong-token server does not count as ready.
- Keep startup logs local and redacted; never print the generated API token,
  provider secrets, pairing codes, or credential payloads.
- Add launch-at-login as an explicit user setting after first-run setup, not as
  a default installer side effect.
- Keep path, process, and shell behavior platform-specific behind Rust/Tauri
  adapters. The renderer should request narrow commands such as
  `server_status`, `server_start`, `server_restart`, `open_dashboard`,
  `copy_phone_url`, and `create_pairing_code`.

## Server startup and MCP boundary

- A stopped Command Deck server cannot start itself through its own API or MCP
  tool surface. Something already running must own startup.
- In the packaged app, the Tauri host owns startup, restart, shutdown, health
  wait, and dashboard opening.
- The Tauri updater plugin owns in-app update checks and install/restart. It
  verifies update artifacts with the compiled public updater key before
  installing them.
- In direct/package runtime, Tauri stores mutable Command Deck state under the
  OS app data directory while loading server/static resources from the bundled
  app resources. This avoids writing registry or artifact state into the signed
  app bundle.
- In CLI/PWA development, a user-run command or OS supervisor owns startup.
  Useful supervisors are launchd on macOS, systemd user services on Linux, and
  Task Scheduler or a service wrapper on Windows.
- Agent/MCP tools may expose status, saved project live links, and health checks
  while the server is running. They may request a restart only when the native
  host or supervisor bridge is available and the action is approval-gated.
- Do not design the orchestrator as the only boot path. It should consume the
  running server contract, not be required to make the app exist.

## Host capability bridge

- The desktop host should report redacted capabilities such as server running,
  Playwright browsers installed, Android ADB available, Xcode simulator
  available, Tailscale status known, and launch-at-login enabled.
- The renderer and agents should consume those capabilities through narrow
  commands or API state. They should not infer host access from local paths,
  shell commands, or environment variables.
- Future preview tools should call server/host adapters with saved target ids
  and named profiles. The adapter resolves URLs, simulator ids, process ids, and
  filesystem paths server-side.

## Live links in the desktop app

- Reuse the server-authoritative project quick-link routes and agent tools from
  `docs/live-project-links.md`.
- Reuse the preview target model from `docs/preview-surfaces.md`.
- Surface favorite links in the app menu or project toolbar so a user can open
  `localhost:5173`, a tailnet HTTP URL, or an HTTPS Serve URL without searching
  chat history.
- Let the native host detect obvious local ports only as suggestions. The saved
  quick-link API remains the source of truth.
- When Tailscale Serve mode changes, refresh the private URL/QR and prefer
  saved `tailnetHttpUrl` or `httpsServeUrl` variants where available.

## Phase 2: first-run desktop wizard

- Step 1: create or load the desktop API token from OS credentials. Implemented.
- Step 2: start the local server and confirm authenticated health. Implemented.
- Step 3: show the dashboard in the Tauri window. Implemented.
- Step 4: create a one-time phone/browser pairing code from a native menu/tray
  action. Implemented.
- Step 5: detect Tailscale binary/login/Serve status and show current private
  URL/QR code. Covered by existing web settings/API surfaces; native first-run
  presentation remains a UI follow-up.
- Step 6: confirm phone browser pairing and show Add to Home Screen
  instructions. Covered by web/PWA flow; native first-run presentation remains
  a UI follow-up.

## Phase 3: credential and security hardening

- Use OS credential storage for the Command Deck API token. Implemented in the
  Tauri host with `keyring`.
- Keep the token out of logs, screenshots, exports, support bundles, URLs, and
  renderer localStorage/sessionStorage.
- Renderer requests privileged native actions through narrow Tauri commands:
  `server_status`, `server_start`, `server_stop`, `server_restart`,
  `copy_phone_url`, `create_pairing_code`, `check_for_updates`, and
  `install_update`.
- Tauri commands stay app-local and narrow. Audit events for destructive native
  host actions are a follow-up when the renderer starts exposing those controls.
- Destructive or broad actions remain confirmation-gated.
- HTTPS Serve setup remains user-approved and never enables Funnel.

## Phase 4: platform expansion

- Validate macOS app bundle first.
- Validate Developer ID signing, notarization, DMG output, and updater artifacts
  with Apple credentials in CI.
- Add Windows Credential Manager validation for Windows.
- Add Secret Service/libsecret validation for Linux.
- Keep iOS/Android native packaging as a later decision; phone-first PWA and
  browser/device previews remain the default unless native runtime limitations
  justify platform SDK work.

## Acceptance

- Fresh install launches local server and opens dashboard.
- Restart preserves the server API token through OS credentials.
- Phone pairing works without exposing the API token to the phone.
- Paired device revocation works from the desktop UI and web UI.
- Private URL/QR reflects the current Tailscale Serve mode.
- App never enables public Funnel by default.
- Existing web acceptance smoke remains green.
