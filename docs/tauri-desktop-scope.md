# Tauri desktop app scope

Command Deck v1 remains PWA-first for phone use. The Tauri desktop app is the
packaged workstation shell for the same local server and security model, not a
second product.

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

- Scaffold Tauri with the existing web app as the frontend.
- Run the local Node server as a managed sidecar or embedded process.
- Generate a random `COMMAND_DECK_API_TOKEN` on first launch.
- Store that token in macOS Keychain through the Tauri backend.
- Reuse the stored token for server startup on later launches.
- Provide menu actions for Open Dashboard, Open Phone Setup, Copy Phone URL,
  Create Pairing Code, Restart Server, and Quit.
- Surface server health, local URL, tailnet HTTP URL, HTTPS Serve URL, and
  active paired sessions.

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

## Phase 2: first-run desktop wizard

- Step 1: confirm local server health.
- Step 2: detect Tailscale binary/login/Serve status.
- Step 3: show current private URL and QR code.
- Step 4: create a one-time phone pairing code.
- Step 5: confirm phone browser pairing.
- Step 6: show Add to Home Screen instructions.

## Phase 3: credential and security hardening

- Use OS credential storage for the Command Deck API token.
- Keep the token out of logs, screenshots, exports, support bundles, URLs, and
  renderer localStorage/sessionStorage.
- Renderer requests privileged native actions through narrow Tauri commands.
- Tauri commands require app-local authorization and audit events.
- Destructive or broad actions remain confirmation-gated.
- HTTPS Serve setup remains user-approved and never enables Funnel.

## Phase 4: platform expansion

- Validate macOS first.
- Add Windows Credential Manager support for Windows.
- Add Secret Service/libsecret support for Linux.
- Keep iOS/Android native packaging as a later decision; phone-first PWA remains
  the default unless browser limitations justify native mobile work.

## Acceptance

- Fresh install launches local server and opens dashboard.
- Restart preserves the server API token through OS credentials.
- Phone pairing works without exposing the API token to the phone.
- Paired device revocation works from the desktop UI and web UI.
- Private URL/QR reflects the current Tailscale Serve mode.
- App never enables public Funnel by default.
- Existing web acceptance smoke remains green.
