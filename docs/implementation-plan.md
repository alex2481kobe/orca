# Orca Implementation Plan

Public-safe view of what the client package actually does today and what
remains as an external blocker. Claims here must be exercised by tests or
smoke gates before being listed.

## Latest local proof

- 143 tests pass.
- `npm run smoke` (v2) passes including five negative-path checks
  (unauthorized 401, spoofed actor 403, oversized body 413, malformed
  JSON 400, malformed query 400) and asserts evidence
  `captured: true` with a real PNG fetched back via the artifact route.
- `npm run smoke:ui` starts an isolated local server when no `--base` is
  supplied, pairs the browser with an HttpOnly-compatible session cookie,
  loads the dashboard with Chromium at desktop and iPhone viewports,
  asserts shell structure, status tags, zero horizontal overflow, no
  unknown visible actions, and saves screenshots into `artifacts/ui-smoke/`.
- `npm run smoke:ui-inventory` seeds a project/session/lane, visits the
  required UI inventory routes at desktop and 390px phone widths, checks
  wired actions, shared shell primitives, accessible icon labels, visible
  links, disabled reasons, and horizontal overflow, and saves screenshots
  plus `artifacts/ui-inventory/inventory-summary.json`.
- `npm run smoke:ui-contract` validates static action/CSS contracts,
  paired-cookie route-level desktop/phone screenshots, hidden advanced
  defaults, and overflow behavior under `artifacts/ui-contract/`.
- `npm run smoke:security-headers`, `npm run smoke:pwa-cache`,
  `npm run smoke:route-inventory`,
  `npm run smoke:route-security-matrix`, and
  `npm run smoke:state-migrations` pass.
- `npm run smoke:full-buildout-ledger` validates
  `docs/full-buildout-ledger.md` so full-buildout status cannot drift
  into undocumented prose.
- `npm run smoke:auth-sessions`,
  `npm run smoke:credential-backends`,
  `npm run smoke:credential-redaction`,
  `npm run smoke:evidence-redaction`, and
  `npm run smoke:process-lifecycle` pass as local deterministic gates.
- `npm run smoke:api-provider` proves OpenAI-compatible and native
  Gemini API provider lane execution against local dummy servers,
  including dashboard-style credential-store secret lookup, env fallback
  wiring, Authorization or `x-goog-api-key` header use, model/prompt
  request shape, terminal lane state, and secret redaction from lane
  state, logs, and audit events.
- `npm run smoke:notifications` proves durable in-app notification state,
  policy-gated settings, browser-notification configuration metadata,
  terminal lane notifications, read state, severity filtering, and secret
  redaction.
- `npm run smoke:app-backup` proves whole-app local backup export,
  import dry-run/apply approval, redacted support bundle output, and
  rejection of secret/auth/artifact fields without echoing secret values.
- `npm run smoke:full-flow` is the named full operator-flow gate. It
  starts an isolated local server with the safe memory credential
  backend when no `--base` is supplied, then proves token auth,
  browser pairing, project/session/lane flow, MCP attachment,
  OpenAI-compatible and native Gemini dummy API lanes, evidence capture,
  audit, cleanup dry-run, private-access fake states, PWA static guards,
  notifications, import/export redaction, and paired-cookie desktop/
  phone/lane screenshots under `artifacts/full-flow-smoke/`.
- `npm run smoke:acceptance` runs the deterministic local acceptance
  matrix in one command, covering `npm test`, the full-flow aliases,
  security, UI, route matrix, provider, credential, evidence, private
  access, PWA, notification, backup, stream, migration, and lifecycle
  smokes. It writes `artifacts/acceptance/acceptance-summary.json` and
  lists real phone reachability plus native packaging as external/manual
  checks.
- Live HTTP-over-Tailscale Serve was activated on a configured host, remained
  tailnet-only with no Funnel exposure, returned `/api/health` through
  MagicDNS, and passed `npm run smoke:ui` through the private Serve URL
  at desktop and 390px phone viewports.
- `npm run operator:status` and `npm run operator:phone-check` provide
  repeatable live preflight checks for local health, private Tailscale health,
  tailnet-only Serve status, public Funnel absence, and the private no-data
  pre-pairing gate for workspace routes. `operator:phone-check` writes a redacted
  `artifacts/operator-phone-check/phone-check-summary.json` that omits API
  tokens, cookies, pairing codes, and private hostnames.
- Real Claude CLI execution flows through the adapter (`claude
  --version` → PID + exit 0).
- Real Codex CLI version reporting works through the supported Homebrew path
  (`/opt/homebrew/bin/codex` → `codex-cli 0.134.0`).
- Real `git worktree add` flows through `createLane` when a session
  has a vetted `repoRoot`, and `POST /api/lanes/:id/worktree/remove`
  removes it under approval.

## Implemented

- Token-gated mutating API with reserved-actor enforcement, JSON body
  limit + 413, optional worker token for heartbeat.
- Approval-gated project/session/lane/MCP/cleanup/CLI reinstall/audit
  endpoints.
- CLI reinstall validation supports npm, pnpm, bun, Homebrew, pip, and
  pip3 manager flows with per-executor package allowlists, source-repo
  allowlists, dry-run planning, confirmation before execution, and
  safe overrides such as `brew reinstall --cask codex` or `brew
  install anthropic-ai/tap/claude`.
- Per-session worktreeRoot + per-lane git worktree under
  `<workspacesRoot>/<sessionId>/worktrees/<laneId>`. Branch defaults to
  `orca/lane/<shortid>` and is sanitized.
- Worktree boundary: relative workdirs stay inside the session
  worktreeRoot; absolute workdirs stay inside the session worktreeRoot
  or an approved repo root (`ORCA_REPO_ROOTS`,
  default `process.cwd()`).
- First-class lane fields plus `processMeta` (PID, args, cwd, env
  policy, start/end, exit code, signal, stopRequestedBy, stopResult,
  platform).
- SIGTERM to the process group on POSIX + SIGKILL escalation after
  `ORCA_STOP_ESCALATE_MS` (default 4000ms).
- Recovery flips orphaned `running` lanes to `failed` on boot.
- Codex/Claude command derivation from `taskPrompt` (+ model,
  permissions, targetUrl, mcpConfigPath).
- MCP tool CRUD with schema validation on every field; per-lane config
  emits both `tools` and `mcpServers` shapes for Codex/Claude native
  loading.
- Server-authoritative project live links with dedicated create/update/delete/
  health-check routes, MCP tool discovery, SSRF validation, dashboard controls,
  and public orchestrator/executor handoff docs.
- Evidence runner with real Playwright capture + degraded fallback,
  gallery (`/api/lanes/:id/evidence/latest`), presets
  (`/api/lanes/:id/evidence/presets`), and server-resolved preset capture from
  saved lane/project targets.
- Preview surface scope in `docs/preview-surfaces.md` covering implemented web
  links/artifacts, browser mobile emulation, future Android browser/device
  adapters, future native simulator adapters, and the Tauri host boundary.
- Tauri v2 desktop scaffold under `src-tauri/`, with local `@tauri-apps/cli`
  scripts, a dedicated Tauri dev server on `127.0.0.1:34125`, native
  start/stop/restart/health commands, OS credential-backed
  `ORCA_API_TOKEN` creation, menu/tray actions for dashboard URL and
  pairing-code creation, updater check/install commands, bundled server/static
  resources for the macOS package path, release updater artifact config, static
  frontend build verification, Cargo lockfile, Rust unit tests, and Rust
  compile check.
- Cleanup scheduler with dry-run default, confirmed destructive runs,
  active-lane protection, monotonic `nextRunAt`, audit events.
- Mobile manifest covers projects, sessions, lanes, detail/stop/retry/
  heartbeat URLs, artifacts/evidence/presets/clear, audit, cleanup,
  executor profile + CLI info + reinstall, MCP CRUD, health, policy.
- `/api/system/blockers` reports concrete external blockers with exact
  remediation commands.
- Operator console UI: sticky top bar, status strip, blocker banner,
  off-canvas sidebar with project list and maintenance routes,
  phone-first CSS, lane detail with task prompt/target/model/branch/
  workdir/processMeta/MCP tools/evidence gallery/warnings.
- UI inventory/design contract: `docs/ui-inventory.md` lists required
  screens and primitives; the UI smoke gates generate desktop and phone
  screenshots for the home, project, session, lane, settings, providers,
  MCP tools, audit queue, private access, cleanup, and creation flows.
- Strict CSP-compatible app shell: service-worker registration lives in
  external JavaScript, not inline script.
- Artifact path containment: `..` segments, encoded variants, absolute
  paths, backslash separators, and symlinked entries refused at
  listing AND serving time.
- Atomic durable state writes and backup recovery for registry,
  provider profiles, private access, and auth sessions, with recovery
  audit events and `smoke:state-migrations`.
- First-class API provider lanes can be created with executor types
  `api`, `openai-compatible`, `kimi`, `deepseek`, `openrouter`, and
  `composer` through the OpenAI-compatible adapter. `gemini` uses a
  native Gemini `generateContent` adapter with `x-goog-api-key` headers
  so secrets are not placed in URLs.
- API provider lanes use the provider credential abstraction
  (`secretRef` first, `apiKeyEnv` fallback), so dashboard-stored
  secrets are usable by executors without returning or persisting raw
  secret values.
- Credential backends are explicit and redacted: memory/test backend,
  env fallback, injectable macOS Keychain command path, delete/fallback
  behavior, dashboard-safe backend status metadata, and fail-closed
  Windows Credential Manager/Linux Secret Service blocked states are
  proven by `npm run smoke:credential-backends` without writing real OS
  credentials.
- In-app notifications are persistent, redacted, unread/read tracked,
  exposed through `/api/notifications`, and configurable for browser
  delivery without storing sensitive content.
- `docs/route-security-matrix.md` documents every route from
  `src/route-inventory.js` with auth, CSRF/origin, token/lease, risk,
  body/rate limits, validation, cache, audit, UI, mobile, and smoke
  coverage. `npm run smoke:route-security-matrix` fails if the doc
  drifts from the live inventory.
- App-level backup/support routes cover `/api/app/export`,
  `/api/app/import/dry-run`, `/api/app/import/apply`, and
  `/api/app/support-bundle`. Exports include projects, sessions, lane
  metadata, provider non-secret config, private-access targets, MCP
  tools, cleanup schedule, and notification settings while excluding
  secrets, auth sessions, pairing codes, artifacts, logs, screenshots,
  videos, and traces.
- `docs/full-buildout-ledger.md` is the active completion ledger. It
  tracks each major full-buildout area with one of
  `implemented_and_proven`, `implemented_not_proven`, `missing`, or
  `externally_blocked`, plus code surfaces, UI surfaces, proof,
  evidence, and blockers.

## External blockers (operator-actionable, surfaced in the dashboard)

The app-side implementation is locally proven. Remaining blockers are external
operator/device setup, not missing local code:

- Real phone reachability requires the user's phone on the same tailnet.
  HTTP-over-Tailscale Serve has been activated on a configured host and verified
  locally through MagicDNS. Use `docs/tailscale-mobile-access.md` for exact
  HTTP and HTTPS Serve commands, status checks, Funnel-off verification,
  shutdown commands, and phone reachability checks.
- Tauri v2 desktop scaffolding is in place and compiles locally. Native server
  lifecycle, OS credential storage, menu/tray actions, and macOS package-path
  resources are implemented. Release updater scaffolding is configured with a
  committed public key and ignored private-key/CI-secret path. Signed/notarized
  DMG validation and native iOS/Android preview adapters remain later product
  phases requiring platform packaging credentials or SDK/device setup.

Local CLI and browser prerequisites should be validated on each release host
before shipping. Use the smoke gates above plus
`docs/tauri-manual-release-checklist.md` for the macOS production package path.

## Verification commands

```bash
npm test
npm run smoke:acceptance
npm run smoke
npm run smoke:full-flow
npm run smoke:private-access
npm run smoke:ui
npm run smoke:ui-inventory
npm run smoke:ui-contract
npm run smoke:security-headers
npm run smoke:pwa-cache
npm run smoke:route-inventory
npm run smoke:route-security-matrix
npm run smoke:full-buildout-ledger
npm run smoke:state-migrations
npm run smoke:auth-sessions
npm run smoke:credential-backends
npm run smoke:credential-redaction
npm run smoke:evidence-redaction
npm run smoke:process-lifecycle
npm run smoke:api-provider
npm run smoke:notifications
npm run smoke:app-backup
npm run operator:status
ORCA_PRIVATE_URL=<tailnet-url> npm run operator:phone-check
```

## Work rules (still apply)

- Public-safe only in this repo; private roadmap stays in the parent
  workspace.
- Commit by logical task with explicit staged paths.
- No destructive cleanup; obsolete whole files/folders go to the
  parent `throwaway/` archive when needed.
