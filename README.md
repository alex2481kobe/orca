# Command Deck

Command Deck is a local-first, phone-first control plane for coordinating
Codex, Claude, custom CLI, and API-backed agent lanes across projects. It
ships a private operator dashboard, governed backend routes, provider
profiles, credential references, MCP tooling, audit/critique gates,
Playwright evidence capture, PWA support, and a Tailscale Serve runbook for
private phone access.

## Current proof

The latest recorded full local acceptance run passed:

- `npm test`: 135/135 tests passing.
- `npm run smoke:acceptance`: 23 deterministic smoke steps passing.
- `npm run smoke:full-flow`: isolated end-to-end operator flow passing.
- `npm run smoke:ui-inventory`: 30 desktop/phone route screenshots with
  zero horizontal overflow.
- `npm run smoke:ui-contract`: shared UI/action contract passing.
- `npm run smoke:full-buildout-ledger`: 25 ledger areas checked with
  23 `implemented_and_proven` and 2 true external blockers.

The current completion ledger is
[`docs/full-buildout-ledger.md`](docs/full-buildout-ledger.md). Do not rely on
prose claims alone; use the ledger and smoke gates as the authority.

The consolidated full-buildout evidence report is
[`docs/final-readiness-report.md`](docs/final-readiness-report.md).

## Implemented and proven

- Local HTTP API and static dashboard at `/`, binding to `127.0.0.1` by
  default.
- Persistent, atomic state stores with backup recovery for registry,
  provider profiles, private access, and auth sessions.
- Paired browser sessions and API-token auth for mutating routes, with
  same-origin protection for browser-session mutations.
- Route inventory and security matrix covering 97 routes with auth,
  validation, body limits, rate limits, audit metadata, UI coverage, mobile
  behavior, and smoke coverage.
- Provider profiles for Codex, Claude, Custom CLI, OpenAI-compatible API,
  Gemini API, Kimi, DeepSeek, OpenRouter, and Composer.
- API-provider execution through local dummy OpenAI-compatible and native
  Gemini adapters, including credential lookup and redaction.
- Credential abstraction with memory/test backend, env fallback, injectable
  macOS Keychain command path, safe delete/fallback behavior, redacted status,
  and fail-closed Windows/Linux unavailable states.
- Real-process executor lanes with PID, args, cwd, env policy, start/end,
  exit code, signal, stop metadata, platform metadata, stdout/stderr logs,
  process-group stop behavior, and restart recovery.
- Governed CLI install/reinstall planning for supported package managers.
  Installs and updates are dry-run/approval-gated by default.
- Automatic per-lane git worktree creation when a session has a vetted
  `repoRoot`, plus approval-gated worktree removal.
- Orchestration state for projects, sessions, lanes, capacity requests,
  critique, audit-one, audit-all, accept, fix, block, and retry transitions.
- MCP tool CRUD, validation, scopes, leases, per-lane generated configs, and
  public-safe agent tool discovery.
- Playwright-backed evidence capture for screenshots, traces, videos, logs,
  latest evidence views, redacted artifact serving, and cleanup controls.
- PWA manifest and static-only service worker cache. Sensitive API, auth,
  provider, artifact, log, screenshot, video, trace, import/export, and state
  routes are not cached.
- In-app notifications plus browser-notification configuration metadata, with
  secret-free notification bodies.
- Backup/import/support-bundle routes that exclude secrets, auth sessions,
  pairing codes, raw artifacts, logs, screenshots, videos, and traces.
- Codex-app-style dashboard shell with project rail, session/work surface,
  settings, providers, MCP tools, private access, cleanup, notifications,
  backup/support, project/session/lane routes, and desktop plus 390px mobile
  screenshot coverage.
- Private-access/Tailscale wiring with target validation, dry-run setup
  commands, fake provider states, Funnel rejection, setup checklist UI,
  copy/open/check actions, mocked tests, and runbook.

## External/manual checks

These are not missing local app code:

- Real phone reachability requires the user's phone on the same tailnet. See
  [`docs/tailscale-mobile-access.md`](docs/tailscale-mobile-access.md).
- Native Tauri/iOS/Android packaging is a later product phase. The v1 app path
  is PWA phone-first.

## Run locally

```bash
cd command-deck-client
npm install
COMMAND_DECK_API_TOKEN="$(openssl rand -hex 32)" npm run dev
```

The dashboard starts at <http://127.0.0.1:3000/>.

For private phone access, keep the server bound locally and front it with
Tailscale Serve. Funnel is forbidden for v1.

## Verification commands

```bash
npm test
npm run smoke:acceptance
npm run smoke:full-flow
npm run smoke:ui
npm run smoke:ui-inventory
npm run smoke:ui-contract
npm run smoke:route-inventory
npm run smoke:route-security-matrix
npm run smoke:full-buildout-ledger
npm run smoke:private-access
npm run smoke:pwa-cache
npm run smoke:providers
npm run smoke:api-provider
npm run smoke:credential-backends
npm run smoke:credential-redaction
npm run smoke:evidence-redaction
```

`npm run smoke:acceptance` is the preferred full local gate. It starts isolated
local servers where needed and does not require public network access, real OS
credential writes, global installs, live Tailscale mutation, or destructive
cleanup.

For the live operator setup, run:

```bash
npm run operator:status
```

This read-only check verifies local health, the private Tailscale health URL,
tailnet-only Serve config, and absence of public Funnel exposure.

To create a fresh one-time phone/browser pairing code without putting a token
in a URL:

```bash
COMMAND_DECK_API_TOKEN=... npm run operator:pair
```

The helper prints only the one-time code and expiry. It never prints the API
token. Pairing codes are one-time secrets and should not be stored in docs,
logs, screenshots, or issue comments.

## Configuration

| Variable | Purpose |
| --- | --- |
| `COMMAND_DECK_API_TOKEN` | Required token for non-GET API calls when set. |
| `COMMAND_DECK_WORKER_TOKEN` | Optional heartbeat token for worker callers. |
| `COMMAND_DECK_HOST` | Bind interface. Defaults to `127.0.0.1`. |
| `PORT` | HTTP port. Defaults to `3000`. |
| `COMMAND_DECK_MAX_JSON_BYTES` | JSON body limit. Defaults to `262144`. |
| `COMMAND_DECK_REPO_ROOTS` | Comma-separated approved repo/workdir roots. |
| `COMMAND_DECK_STOP_ESCALATE_MS` | Stop grace period before escalation. |
| `COMMAND_DECK_CODEX_*` | Codex binary, allowlist, args, workdir, and install policy. |
| `COMMAND_DECK_CLAUDE_*` | Claude binary, allowlist, args, workdir, and install policy. |
| `COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST` | Allowed MCP executable names. |

Provider API keys should use OS credential references where available or
server-side env vars as fallback. Secret values must not be stored in browser
storage, app state, logs, screenshots, artifacts, exports, service-worker
cache, route inventory, or MCP config.

## CLI management

- `GET /api/executors/{executor}/cli` reports host CLI binary, version,
  reinstall command, and source-repo allowlist.
- `POST /api/executors/{executor}/cli/reinstall` with `{ "approved": true,
  "execute": false }` returns a dry-run plan.
- Actual install/update execution requires an approved command, explicit
  confirmation, audit logging, and user opt-in policy. Never auto-install or
  auto-update by default.

## Phone access

Use [`docs/tailscale-mobile-access.md`](docs/tailscale-mobile-access.md) for
the current HTTP-over-Tailscale and HTTPS Serve setup. The app supports both;
HTTP over Tailscale is the default recommendation for less public hostname
metadata, while HTTPS Serve is available when secure-context browser features
matter.
