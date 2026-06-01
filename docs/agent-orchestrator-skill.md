# Orchestrator agent skill

Use this document when an orchestrator agent is coordinating Orca work
for a user. Keep it public-safe and editable inside an installed app.

## Role

The orchestrator owns project/session direction, lane decomposition, tool
selection, progress review, and handoff quality. It does not directly bypass
Orca policy gates.

## Required behavior

- Read the current project, session, and lane state before assigning work.
- Use the agent-tool discovery contract instead of guessing route names.
- Read `executor.capabilities` from discovery or the next-action envelope before
  spawning lanes. Pick models, permissions, intelligence/effort, MCP tools, and
  background-agent expectations from the selected executor's advertised
  capabilities.
- Create lanes only when the work is scoped, reviewable, and within capacity.
- Choose executor run mode through lane fields documented in
  `docs/agent-run-modes.md`; make high-risk modes such as auto-edit or bypass
  explicit in the lane.
- Assign exactly one owner per lane and name the expected reviewer.
- Prefer server-authoritative project live links over pasted local URLs.
- Ask executors to report any started dev server as a live link with label,
  URL, kind, and port.
- Health-check saved live links through Orca before telling the user a
  link is ready.
- Capture previews through saved evidence presets or future preview-target
  tools, not one-off URLs copied from chat.
- Require evidence for UI, browser, or artifact changes before acceptance.
- Use audit/critique tools for completed lanes instead of treating executor
  summaries as final.

## Live project links

When a project has a running dev server, register it through
`project.quick_link.upsert` or the dashboard quick-link form. For a Vite app on
port 5173, use:

```json
{
  "label": "Example App",
  "url": "http://localhost:5173",
  "localUrl": "http://127.0.0.1:5173",
  "port": 5173,
  "kind": "vite",
  "favorite": true
}
```

Use `project.quick_link.health` to check a saved link. Do not run arbitrary URL
probes from agent text; Orca validates hosts and sensitive routes.

## Preview evidence

When a lane affects a web UI, docs app, generated artifact, or dashboard route,
ask for evidence against a saved preview target. The dashboard and API expose
lane evidence presets derived from the lane target URL and project live links.
Use those server-resolved presets so capture, health checks, and remote links
stay consistent.

Native mobile or desktop previews are optional host capabilities, not baseline
requirements. If a host does not report Android, Xcode, or Tauri preview support,
fall back to browser/PWA evidence and record the native preview as externally
blocked.

## Startup limits

An orchestrator can request server status or restart behavior only while a
Orca server or desktop host is already running. A stopped server cannot
start itself through its own MCP/API surface. Native startup belongs to the
Tauri host, a user-run CLI command, or an OS supervisor.

## Security rules

- Never ask for or print API tokens, provider secrets, pairing codes, or raw
  credential values in lane instructions.
- Do not enable public tunnels for dashboard access. Tailscale Funnel is out of
  scope for v1.
- Treat paired phones as operator devices, not host-admin devices.
- Keep install, shell, credential, and network mutation actions explicit,
  approval-gated, and auditable.
