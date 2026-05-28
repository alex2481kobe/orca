# Command Deck

Command Deck is a local-first control plane for coordinating Codex and Claude
work across projects from a Mac (or any single host) and a phone over private
Tailscale Serve. It exposes a dashboard, an API surface, a worker contract,
governed CLI management, MCP tool CRUD with per-lane config generation, and
Playwright-backed evidence capture (optional dependency).

## What is actually implemented and tested

These items have backing tests and/or a runnable smoke path. Items not in this
list are aspirational and should be treated as such until proven.

- HTTP API on `http://127.0.0.1:3000` by default. Static dashboard at `/`.
- Persistent registry in `.command-deck/state.json` with atomic-ish persist
  scheduling and a drain-on-shutdown for safe teardown.
- `mock`, `codex`, and `claude` executors share a single worker contract
  (`src/worker-contract.js`, `src/executor-factory.js`).
- Real Codex/Claude lanes capture `processMeta` (PID, args, cwd, env policy,
  start/end, exit code, signal, stopRequestedBy, stopResult, platform).
- Stop sends SIGTERM to the process group when supported and escalates to
  SIGKILL after `COMMAND_DECK_STOP_ESCALATE_MS` (default 4000ms).
- Recovery on startup marks previously-running lanes as failed instead of
  silently leaving them as "running."
- Lane fields include `taskPrompt`, `model`, `permissionsProfile`, `branch`,
  `repoRoot`, `worktreePath`, `verificationCommand`, `expectedArtifacts`,
  `targetUrl`, `mcpToolIds`, and `sharedWorktree`.
- `buildExecutorCommandArgs` derives safe argv for Codex/Claude from
  taskPrompt/model/permissions/targetUrl/mcpConfigPath when no explicit
  command is provided.
- MCP tool CRUD (`/api/mcp/tools`) with schema validation, command allowlist,
  scope filtering, lane attachment, and generated per-lane config
  (`mcp-tools.json`) including an `mcpServers` map for Codex/Claude.
- Evidence runner uses Playwright when available; without it, evidence calls
  are recorded as `degraded` with a visible explanation. Browser binaries are
  never installed automatically.
- Evidence gallery + presets via `/api/lanes/:id/evidence/latest` and
  `/api/lanes/:id/evidence/presets` (lane targetUrl + project quick links).
- Cleanup scheduler with dry-run default, confirmed destructive runs,
  active-lane protection, and monotonic `nextRunAt`.
- Mobile manifest at `/api/mobile/manifest` lists every dashboard action URL
  per project/session/lane plus cleanup/CLI/MCP/health endpoints.
- Security:
  - Token-gated mutating routes via `COMMAND_DECK_API_TOKEN`.
  - Reserved actor names (`scheduler`, `system`, `cron`, `worker`) refused
    on all mutating endpoints to stop dashboard spoofing.
  - JSON body limit (`COMMAND_DECK_MAX_JSON_BYTES`, default 256KB) with 413.
  - Heartbeat can be gated by `COMMAND_DECK_WORKER_TOKEN`.
  - Artifact path containment: ".." segments, encoded variants, absolute
    paths, backslash separators, and symlinked entries are refused.
  - Per-lane workdir respects session worktree boundary for relative paths
    and an approved repo-root allowlist (`COMMAND_DECK_REPO_ROOTS`) for
    absolute paths.

## Run locally

```bash
cd command-deck-client
npm run dev
# In another shell:
COMMAND_DECK_API_TOKEN=$(openssl rand -hex 32) \
COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 \
  npm run smoke
```

The dashboard is at <http://127.0.0.1:3000/>. The smoke script walks the
full operator path (project, session, mock lane, MCP tool + Codex lane,
evidence capture, audit ack, cleanup dry-run).

For phone access over Tailscale Serve, see
[`docs/tailscale-mobile-access.md`](docs/tailscale-mobile-access.md).

## Tests

```bash
cd command-deck-client
npm test
```

63 tests cover approval/auth, executor targeting, MCP CRUD and scope,
cleanup schedule, CLI reinstall safety, mobile manifest, audit filtering,
artifact path containment, JSON body limit, actor spoofing, heartbeat
governance, MCP config generation, and executor command derivation.

## Configuration

| Variable | Purpose |
| --- | --- |
| `COMMAND_DECK_API_TOKEN` | Required token for non-GET API calls when set. |
| `COMMAND_DECK_WORKER_TOKEN` | Required `x-commanddeck-worker-token` header on `/api/lanes/:id/heartbeat` when set. |
| `COMMAND_DECK_HOST` | Bind interface (default `127.0.0.1`). Use `127.0.0.1` and front with Tailscale Serve. |
| `PORT` | Port (default `3000`). |
| `COMMAND_DECK_MAX_JSON_BYTES` | Body size limit, default 262144. |
| `COMMAND_DECK_SEED` | Set `1` to recreate the demo Realm Shaper project on first boot. Off by default. |
| `COMMAND_DECK_REPO_ROOTS` | Comma-separated absolute paths allowed as lane workdir parents (in addition to `process.cwd()`). |
| `COMMAND_DECK_STOP_ESCALATE_MS` | Grace period before SIGKILL escalation on lane stop. Default 4000. |
| `COMMAND_DECK_CODEX_BINARY`, `COMMAND_DECK_CODEX_ALLOWED_BINARIES`, `COMMAND_DECK_CODEX_DEFAULT_ARGS`, `COMMAND_DECK_CODEX_WORKDIR_ROOTS`, `COMMAND_DECK_CODEX_REINSTALL_COMMAND`, `COMMAND_DECK_CODEX_REINSTALL_PACKAGES`, `COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS`, `COMMAND_DECK_CODEX_REINSTALL_PREFER_SOURCE` | Codex executor + managed reinstall policy. |
| `COMMAND_DECK_CLAUDE_BINARY`, …, `COMMAND_DECK_CLAUDE_REINSTALL_PREFER_SOURCE` | Same shape for Claude. |
| `COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST` | Comma-separated allowed MCP executables (e.g. `node,npx,python3`). |

## CLI management

- `GET /api/executors/{executor}/cli` — host CLI binary, version, reinstall
  command, and source-repo allowlist.
- `POST /api/executors/{executor}/cli/reinstall` with `{ approved: true,
  execute: false }` returns a dry-run plan. `execute: true` requires
  `confirmed: true` and an approved command from the allowlist. The dashboard
  surfaces this as an explicit two-step flow.

## Known limitations

- Real git worktree creation is not yet automatic. Lane fields for branch/
  worktreePath/repoRoot are persisted, but the operator currently provisions
  worktrees outside Command Deck. The workdir validator accepts paths inside
  approved repo roots.
- Playwright is an optional dependency. Without it, evidence captures finish
  with `captured: false` and a `degraded` marker — the UI shows this state
  explicitly rather than silently succeeding.
- No browser smoke tests yet; UI verification relies on the API smoke script
  plus manual phone walkthrough documented in the Tailscale runbook.
