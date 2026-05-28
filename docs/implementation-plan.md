# Command Deck Implementation Plan

Public-safe view of what the client package actually does today and what
remains as an external blocker. Claims here must be exercised by tests or
smoke gates before being listed.

## Proven on this host

- 120 tests pass.
- `npm run smoke` (v2) passes including five negative-path checks
  (unauthorized 401, spoofed actor 403, oversized body 413, malformed
  JSON 400, malformed query 400) and asserts evidence
  `captured: true` with a real PNG fetched back via the artifact route.
- `npm run smoke:ui` loads the dashboard with Chromium at desktop and
  iPhone viewports, asserts shell structure, status tags, zero
  horizontal overflow, and saves screenshots into
  `artifacts/ui-smoke/`.
- `npm run smoke:ui-inventory` seeds a project/session/lane, visits the
  required UI inventory routes at desktop and 390px phone widths, checks
  wired actions, shared shell primitives, accessible icon labels, visible
  links, and horizontal overflow, and saves screenshots plus
  `artifacts/ui-inventory/inventory-summary.json`.
- `npm run smoke:ui-contract` validates static action/CSS contracts,
  route-level desktop/phone screenshots, hidden advanced defaults, and
  overflow behavior under `artifacts/ui-contract/`.
- `npm run smoke:security-headers`, `npm run smoke:pwa-cache`,
  `npm run smoke:route-inventory`,
  `npm run smoke:route-security-matrix`, and
  `npm run smoke:state-migrations` pass.
- `npm run smoke:auth-sessions`,
  `npm run smoke:credential-redaction`,
  `npm run smoke:evidence-redaction`, and
  `npm run smoke:process-lifecycle` pass as local deterministic gates.
- `npm run smoke:api-provider` proves OpenAI-compatible API provider
  lane execution against a local dummy server, including dashboard-style
  credential-store secret lookup, env fallback wiring, Authorization
  header use, model/prompt request shape, terminal lane state, and
  secret redaction from lane state, logs, and audit events.
- `npm run smoke:notifications` proves durable in-app notification state,
  policy-gated settings, browser-notification configuration metadata,
  terminal lane notifications, read state, severity filtering, and secret
  redaction.
- `npm run smoke:full-flow` is the named full operator-flow gate and runs
  the same server-based path as `npm run smoke`, including the local
  dummy API-provider lane proof when the server uses the safe memory
  credential backend.
- Real Claude CLI execution flows through the adapter (`claude
  --version` → PID + exit 0).
- Real Codex CLI is repaired on this host through Homebrew
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
  `command-deck/lane/<shortid>` and is sanitized.
- Worktree boundary: relative workdirs stay inside the session
  worktreeRoot; absolute workdirs stay inside the session worktreeRoot
  or an approved repo root (`COMMAND_DECK_REPO_ROOTS`,
  default `process.cwd()`).
- First-class lane fields plus `processMeta` (PID, args, cwd, env
  policy, start/end, exit code, signal, stopRequestedBy, stopResult,
  platform).
- SIGTERM to the process group on POSIX + SIGKILL escalation after
  `COMMAND_DECK_STOP_ESCALATE_MS` (default 4000ms).
- Recovery flips orphaned `running` lanes to `failed` on boot.
- Codex/Claude command derivation from `taskPrompt` (+ model,
  permissions, targetUrl, mcpConfigPath).
- MCP tool CRUD with schema validation on every field; per-lane config
  emits both `tools` and `mcpServers` shapes for Codex/Claude native
  loading.
- Evidence runner with real Playwright capture + degraded fallback,
  gallery (`/api/lanes/:id/evidence/latest`), presets
  (`/api/lanes/:id/evidence/presets`).
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
  `composer` through the OpenAI-compatible adapter. `gemini` is exposed
  as a first-class profile and currently fails closed with a clear
  unsupported-style blocker until its native request adapter is added.
- API provider lanes use the provider credential abstraction
  (`secretRef` first, `apiKeyEnv` fallback), so dashboard-stored
  secrets are usable by executors without returning or persisting raw
  secret values.
- In-app notifications are persistent, redacted, unread/read tracked,
  exposed through `/api/notifications`, and configurable for browser
  delivery without storing sensitive content.
- `docs/route-security-matrix.md` documents every route from
  `src/route-inventory.js` with auth, CSRF/origin, token/lease, risk,
  body/rate limits, validation, cache, audit, UI, mobile, and smoke
  coverage. `npm run smoke:route-security-matrix` fails if the doc
  drifts from the live inventory.

## External blockers (operator-actionable, surfaced in the dashboard)

There are no known external blockers as of this writing. Playwright +
Chromium are installed locally and exercised end-to-end, Claude is
executable, and the broken Homebrew Codex symlink was repaired with
`brew reinstall --cask codex`.

## Verification commands

```bash
npm test
COMMAND_DECK_API_TOKEN=... COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 npm run smoke
COMMAND_DECK_API_TOKEN=... COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 npm run smoke:full-flow
COMMAND_DECK_API_TOKEN=... COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 npm run smoke:ui
COMMAND_DECK_API_TOKEN=... COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 npm run smoke:ui-inventory
COMMAND_DECK_API_TOKEN=... COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 npm run smoke:ui-contract
npm run smoke:security-headers
npm run smoke:pwa-cache
npm run smoke:route-inventory
npm run smoke:route-security-matrix
npm run smoke:state-migrations
npm run smoke:auth-sessions
npm run smoke:credential-redaction
npm run smoke:evidence-redaction
npm run smoke:process-lifecycle
npm run smoke:api-provider
npm run smoke:notifications
```

## Work rules (still apply)

- Public-safe only in this repo; private roadmap stays in the parent
  workspace.
- Commit by logical task with explicit staged paths.
- No destructive cleanup; obsolete whole files/folders go to the
  parent `throwaway/` archive when needed.
