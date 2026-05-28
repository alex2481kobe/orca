# Command Deck

Command Deck is the local-first control plane for coordinating Codex and
Claude work across projects from a Mac and a phone over private Tailscale
Serve. It ships an operator dashboard, an API surface, a worker contract
with real process metadata, governed CLI management for npm/pnpm/bun/
Homebrew/pip-style installs, MCP tool CRUD with per-lane config generation,
automatic git worktree isolation, and
Playwright-backed evidence capture.

## What is implemented and proven

Backed by `npm test` (70 tests), `npm run smoke` (full operator path with
negative-path proofs), and `npm run smoke:ui` (Chromium against desktop +
phone viewports with screenshots).

- HTTP API on `http://127.0.0.1:3000`. Static dashboard at `/`.
- Persistent registry in `.command-deck/state.json` with a tracked drain
  on shutdown.
- Real operator console: sticky top bar with status strip + blocker
  banner, off-canvas sidebar with project list and maintenance routes,
  phone-first CSS.
- `mock`, `codex`, and `claude` executors share a worker contract.
  Real-process lanes capture PID, args, cwd, env policy, start/end,
  exit code, signal, stopRequestedBy, stopResult, platform.
- Stop sends SIGTERM to the process group on POSIX and escalates to
  SIGKILL after `COMMAND_DECK_STOP_ESCALATE_MS` (default 4000ms).
- Recovery on startup marks previously-running lanes as failed.
- First-class lane fields: `taskPrompt`, `model`, `permissionsProfile`,
  `branch`, `repoRoot`, `worktreePath`, `verificationCommand`,
  `expectedArtifacts`, `targetUrl`, `mcpToolIds`, `sharedWorktree`.
- Automatic per-lane `git worktree add` when the session has a vetted
  `repoRoot` and the lane is not `sharedWorktree`. Worktrees live under
  `<workspacesRoot>/<sessionId>/worktrees/<laneId>` only. `POST
  /api/lanes/:id/worktree/remove` removes them under approval.
- `buildExecutorCommandArgs` derives safe argv for Codex/Claude from
  taskPrompt/model/permissions/targetUrl/mcpConfigPath.
- MCP tool CRUD with schema validation for name, command (allowlist),
  args, env (key/value bounds), workdir, description, owner, notes,
  scope. Per-lane `mcp-tools.json` includes both `tools` and
  `mcpServers` shapes.
- Evidence runner uses Playwright. Real screenshot/trace/video/log
  capture is exercised by `npm run smoke` when Chromium is present.
  When Playwright is absent the runner records `captured: false` plus a
  `degraded` marker and the dashboard shows the exact install command.
- Evidence gallery + presets via `/api/lanes/:id/evidence/latest` and
  `/api/lanes/:id/evidence/presets`.
- Cleanup scheduler with dry-run default, confirmed destructive runs,
  active-lane protection, monotonic `nextRunAt`.
- Mobile manifest at `/api/mobile/manifest` covers every dashboard
  action URL per project/session/lane plus cleanup/CLI/MCP/health.
- `/api/system/blockers` reports concrete external blockers (executor
  CLI missing, Playwright optional) with exact remediation commands.
- Security:
  - Token-gated mutating routes via `COMMAND_DECK_API_TOKEN`.
  - Reserved actor names (`scheduler`, `system`, `cron`, `worker`)
    refused on every mutating endpoint (returns `403`).
  - JSON body limit (`COMMAND_DECK_MAX_JSON_BYTES`, default 256KB) →
    `413`; malformed JSON → `400`.
  - Heartbeat gateable by `COMMAND_DECK_WORKER_TOKEN`.
  - Artifact path containment: `..` segments, encoded variants,
    absolute paths, backslash separators, and symlinked entries are
    refused at listing AND serving time (`fs.realpath` verified).
  - Per-lane workdir respects session worktree boundary for relative
    paths and an approved repo-root allowlist
    (`COMMAND_DECK_REPO_ROOTS`) for absolute paths.

## Verified on this host

- **Tests**: 70/70 pass.
- **Smoke v2**: green, including the five negative checks plus
  evidence `captured=true` with a fetched screenshot file.
- **UI smoke**: Chromium loads dashboard at desktop (1366x900) and
  iPhone (390x844). Both viewports report 7 status tags, 0px
  horizontal overflow, and saved screenshots to
  `artifacts/ui-smoke/{desktop,phone}.png`.
- **Real Claude lane**: `claude --version` spawns through the executor
  adapter and reports PID, stdout, exit code 0.
- **Real Codex CLI**: Homebrew cask repaired on this host; `codex-cli
  0.134.0` is available at `/opt/homebrew/bin/codex`.
- **Real git worktree**: `npm test` exercises `git worktree add`,
  `changedFilesIn`, and approval-gated removal against a fresh repo.

## Run locally

```bash
cd command-deck-client
npm install
npm run dev
# In another shell:
COMMAND_DECK_API_TOKEN=$(openssl rand -hex 32) \
COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 \
  npm run smoke
COMMAND_DECK_API_TOKEN=$COMMAND_DECK_API_TOKEN \
  npm run smoke:ui
```

For phone access over Tailscale Serve, see
[`docs/tailscale-mobile-access.md`](docs/tailscale-mobile-access.md).

## Tests

```bash
cd command-deck-client
npm test
```

70 tests cover approval/auth, executor targeting, MCP CRUD + schema
bounds (env/workdir/description/owner/notes), cleanup schedule, CLI
reinstall safety, mobile manifest, audit filtering, artifact path
containment, JSON body limit, actor spoofing, heartbeat governance,
MCP config generation, executor command derivation, shared-worktree
audit, terminal artifact metadata, git worktree creation + removal,
session repoRoot validation, system blockers shape, and real Claude
CLI execution.

## Configuration

| Variable | Purpose |
| --- | --- |
| `COMMAND_DECK_API_TOKEN` | Required token for non-GET API calls when set. |
| `COMMAND_DECK_WORKER_TOKEN` | Required `x-commanddeck-worker-token` header on `/api/lanes/:id/heartbeat` when set. |
| `COMMAND_DECK_HOST` | Bind interface (default `127.0.0.1`). Front with Tailscale Serve. |
| `PORT` | Port (default `3000`). |
| `COMMAND_DECK_MAX_JSON_BYTES` | Body size limit, default 262144. |
| `COMMAND_DECK_SEED` | Set `1` to recreate the demo Realm Shaper project on first boot. Off by default. |
| `COMMAND_DECK_REPO_ROOTS` | Comma-separated absolute paths allowed as lane workdir parents and session repoRoots (in addition to `process.cwd()`). |
| `COMMAND_DECK_STOP_ESCALATE_MS` | Grace period before SIGKILL escalation on lane stop. Default 4000. |
| `COMMAND_DECK_CODEX_BINARY`, `COMMAND_DECK_CODEX_ALLOWED_BINARIES`, `COMMAND_DECK_CODEX_DEFAULT_ARGS`, `COMMAND_DECK_CODEX_WORKDIR_ROOTS`, `COMMAND_DECK_CODEX_REINSTALL_COMMAND`, `COMMAND_DECK_CODEX_REINSTALL_PACKAGES`, `COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS`, `COMMAND_DECK_CODEX_REINSTALL_PREFER_SOURCE` | Codex executor + managed reinstall policy. |
| `COMMAND_DECK_CLAUDE_BINARY`, …, `COMMAND_DECK_CLAUDE_REINSTALL_PREFER_SOURCE` | Same shape for Claude. |
| `COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST` | Comma-separated allowed MCP executables (e.g. `node,npx,python3`). |

## CLI management

- `GET /api/executors/{executor}/cli` — host CLI binary, version,
  reinstall command, source-repo allowlist.
- `POST /api/executors/{executor}/cli/reinstall` with `{ approved:
  true, execute: false }` returns a dry-run plan. `execute: true`
  requires `confirmed: true` and an approved command from the
  allowlist. The dashboard surfaces this as an explicit two-step flow.
- Supported reinstall managers are `npm`, `pnpm`, `bun`, `brew`,
  `pip`, and `pip3`. Defaults use the npm packages
  `@openai/codex` and `@anthropic/claude-code`, but operators can set
  a package-manager-specific command without weakening validation.
- Homebrew examples:

```bash
COMMAND_DECK_CODEX_REINSTALL_COMMAND='["brew","reinstall","--cask","codex"]'
COMMAND_DECK_CLAUDE_REINSTALL_COMMAND='["brew","install","anthropic-ai/tap/claude"]'
```

## Open blockers (operator-actionable)

Surfaced at `GET /api/system/blockers` and at the top of the dashboard:

There are no known external blockers on this host. Playwright is
installed locally with matching Chromium 1223, Claude is executable,
and the broken Homebrew Codex symlink was repaired with
`brew reinstall --cask codex`.
