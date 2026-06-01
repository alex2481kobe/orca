# Executor agent skill

Use this document when an executor agent is assigned a Command Deck lane. Keep
it public-safe and editable inside an installed app.

## Role

The executor owns one lane at a time. It implements the assigned change, records
progress, attaches evidence, and stops for review when the lane is done or
blocked.

## Required behavior

- Read the assigned lane, project, and session context before editing files.
- Confirm the lane's executor type, model, permissions profile, workdir, and MCP
  tools before starting; these are the run-mode contract from
  `docs/agent-run-modes.md`.
- Use the lane's capability snapshot to understand which modes, intelligence
  levels, structured output, MCP config, and background-agent behavior were
  available when the lane was started.
- Keep changes inside the assigned scope and existing repo style.
- Report meaningful progress with lane heartbeat/progress tools.
- If you start a dev server, record the exact local URL, port, and framework
  kind in the lane summary so the orchestrator can save a project live link.
- Prefer existing package scripts and documented smoke gates.
- Attach screenshots, logs, traces, or artifacts when the lane affects UI,
  browser behavior, generated files, or integration flows.
- Prefer saved preview targets for evidence. Do not ask the dashboard to capture
  arbitrary URLs when a project live link or lane target can be saved instead.
- Mark the lane blocked only when a real external dependency prevents progress.
- Do not self-accept your lane. Submit it for critique/audit.

## Dev server handoff

When a server is running, include a compact handoff like:

```text
live link: label=Realm Shaper url=http://localhost:5173 port=5173 kind=vite
```

If a remote/tailnet URL is known, include it separately:

```text
tailnet: http://device.tailnet.ts.net:5173
https serve: https://device.tailnet.ts.net
```

The orchestrator or dashboard should save those values through Command Deck so
future agents use the server-authoritative link instead of stale chat text.

## Preview evidence handoff

For browser projects, include the local dev-server URL and the intended preview
profile, such as desktop, phone, tablet, trace, or artifact. For native mobile
or desktop app work, report the actual host prerequisite you used, such as
Android ADB, Xcode Simulator, or Tauri desktop host. If that prerequisite is not
available, keep the lane evidence to browser/PWA previews and mark native
preview as blocked by host setup.

## Security rules

- Never put provider secrets, API tokens, pairing codes, or credential values in
  logs, artifacts, screenshots, exports, MCP config, or committed files.
- Do not install or update CLIs, package managers, browsers, Tailscale, native
  runtimes, or credential helpers unless the lane explicitly requests it and the
  dashboard policy approves it.
- Do not expose Command Deck through public tunnels. Use private tailnet access
  only.
- Do not weaken tests, route inventory, auth, URL validation, or approval gates
  to make a lane pass.
