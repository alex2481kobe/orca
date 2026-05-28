# Command Deck Implementation Plan

Public-safe view of what the client package actually does today and what
remains as an external blocker. All claims here are exercised by either
`npm test`, `npm run smoke`, or `npm run smoke:ui` and the verification
output is recorded in the README.

## Proven on this host

- 70 tests pass.
- `npm run smoke` (v2) passes including five negative-path checks
  (unauthorized 401, spoofed actor 403, oversized body 413, malformed
  JSON 400, malformed query 400) and asserts evidence
  `captured: true` with a real PNG fetched back via the artifact route.
- `npm run smoke:ui` loads the dashboard with Chromium at desktop and
  iPhone viewports, asserts shell structure, status tags, zero
  horizontal overflow, and saves screenshots into
  `artifacts/ui-smoke/`.
- Real Claude CLI execution flows through the adapter (`claude
  --version` → PID + exit 0).
- Real `git worktree add` flows through `createLane` when a session
  has a vetted `repoRoot`, and `POST /api/lanes/:id/worktree/remove`
  removes it under approval.

## Implemented

- Token-gated mutating API with reserved-actor enforcement, JSON body
  limit + 413, optional worker token for heartbeat.
- Approval-gated project/session/lane/MCP/cleanup/CLI reinstall/audit
  endpoints.
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
- Artifact path containment: `..` segments, encoded variants, absolute
  paths, backslash separators, and symlinked entries refused at
  listing AND serving time.

## External blockers (operator-actionable, surfaced in the dashboard)

- **Codex CLI not executable on this host.** Symlink
  `/opt/homebrew/bin/codex` points to a missing cask binary. Approved
  remediation: `brew reinstall --cask codex` OR `npm install -g
  @openai/codex`. Real Codex lane execution is blocked until that
  command runs.

There are no other external blockers as of this writing. Playwright +
Chromium are installed locally and exercised end-to-end.

## Verification commands

```bash
npm test
COMMAND_DECK_API_TOKEN=... COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 npm run smoke
COMMAND_DECK_API_TOKEN=... COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 npm run smoke:ui
```

## Work rules (still apply)

- Public-safe only in this repo; private roadmap stays in the parent
  workspace.
- Commit by logical task with explicit staged paths.
- No destructive cleanup; obsolete whole files/folders go to the
  parent `throwaway/` archive when needed.
