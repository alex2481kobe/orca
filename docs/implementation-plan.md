# Command Deck Implementation Plan

Public-safe view of what the client package actually does today and what is
explicitly deferred. Private coordination lives in the parent workspace.

## What is implemented and proven

Backed by `npm test` (63 tests) and `npm run smoke` (full operator path).

- Token-gated mutating API with reserved-actor enforcement, JSON body
  limit + 413, optional worker token for heartbeat.
- Approval-gated project, session, lane, MCP tool, cleanup, CLI reinstall,
  and audit ack endpoints.
- Per-session worktreeRoot creation on `createSession` and a workdir
  validator that allows relative paths only inside the session boundary and
  absolute paths inside `process.cwd()` or `COMMAND_DECK_REPO_ROOTS`.
- First-class lane fields: `taskPrompt`, `model`, `permissionsProfile`,
  `branch`, `repoRoot`, `worktreePath`, `verificationCommand`,
  `expectedArtifacts`, `targetUrl`, `mcpToolIds`, `sharedWorktree`.
- Codex/Claude command derivation from `taskPrompt` (+ model, permissions,
  targetUrl, mcpConfigPath) so dashboard users don't write shell strings.
- Process metadata recorded per-lane: PID, args, cwd, env policy, start/end
  timestamps, exit code, signal, stopRequestedBy, stopResult, platform.
- Stop sends SIGTERM to the process group on POSIX and escalates to
  SIGKILL after a configurable grace.
- Recovery flips orphaned `running`/`starting` lanes to `failed` on boot.
- MCP tool CRUD + scope filter; lane attachment emits a per-lane
  `mcp-tools.json` with both `tools` and `mcpServers` shapes.
- Evidence runner with screenshot/trace/video/log paths, capture presets
  (`/api/lanes/:id/evidence/presets`), latest gallery
  (`/api/lanes/:id/evidence/latest`), explicit `degraded` state when
  Playwright is not installed.
- Cleanup scheduler with dry-run default, confirmed destructive runs,
  active-lane protection, monotonic `nextRunAt`, audit events.
- Mobile manifest covers projects, sessions, lanes, detail/stop/retry/
  heartbeat URLs, artifacts/evidence/presets/clear, audit, cleanup,
  executor profile + CLI info + reinstall, MCP CRUD, health, policy.
- Artifact path containment: `..` segments, encoded variants, absolute
  paths, backslash separators, and symlinked entries are refused at
  listing and serving time.
- Dashboard:
  - Phone-friendly CSS (touch targets, full-width buttons, single-column
    grids, larger inputs under 720px).
  - Lane detail surfaces taskPrompt, targetUrl, model, permissions,
    branch, workdir, process metadata, and live status tag.
  - MCP picker is a multi-select fed by executor-scoped tools (replaces
    the comma-separated input on mobile).
  - Evidence gallery tile with preset capture buttons and inline preview.

## Explicitly deferred

- Automatic `git worktree add` per implementation lane. Lane fields for
  branch/worktreePath are persisted, but the operator currently provisions
  the worktree outside Command Deck.
- Auto-install of Playwright browsers. Evidence calls run real captures
  when Playwright is present and otherwise return `captured: false`.
- Browser-driven UI smoke tests. UI changes are exercised by the API
  smoke script plus the manual phone walkthrough documented in the
  Tailscale runbook.

## Verification commands

```bash
npm test
COMMAND_DECK_API_TOKEN=... COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 npm run smoke
```

## Work rules (still apply)

- Public-safe only in this repo; private roadmap stays in the parent
  workspace.
- Add no speculative dependencies; commit manifest + lockfile together
  when added.
- No destructive cleanup; obsolete whole files/folders go to the parent
  `throwaway/` archive when needed.
- Commit by logical task with explicit staged paths.
