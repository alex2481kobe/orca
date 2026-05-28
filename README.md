# Command Deck

Command Deck is the local control plane for coordinating AI coding workers.

This implementation is a checkpointed local prototype with multiple production-shaped surfaces already in place. It is not considered fully ready until the current security, executor, UI, mobile, evidence, MCP, cleanup, and end-to-end verification pass is complete:
- Shared dashboard routes (`/`, `/projects/:slug`, `/projects/:slug/sessions/:id`)
- Persistent registry backing for projects, sessions, lanes, and audit events (`.command-deck/state.json`)
- Policy-gated lane actions and queue-like lifecycle transitions
- Mobile-first dashboard shell and mobile-friendly URL structure
- Per-lane artifact folder bookkeeping
- Executor adapter registry with per-executor instances (`mock`, `codex`, `claude`) and per-lane adapter resolution
- `codex` and `claude` executors now support command-backed lane launches through the shared contract
- Lane launch fields support `command`, `commandArgs`, `executorBinary`, and `workdir` for executable adapters
- Executor profile config is read from:
  - `COMMAND_DECK_CODEX_BINARY`
  - `COMMAND_DECK_CODEX_ALLOWED_BINARIES`
  - `COMMAND_DECK_CODEX_DEFAULT_ARGS`
  - `COMMAND_DECK_CODEX_WORKDIR_ROOTS`
  - `COMMAND_DECK_CLAUDE_BINARY`
  - `COMMAND_DECK_CLAUDE_ALLOWED_BINARIES`
  - `COMMAND_DECK_CLAUDE_DEFAULT_ARGS`
  - `COMMAND_DECK_CLAUDE_WORKDIR_ROOTS`
- Playwright evidence capture scaffolding is now available via `POST /api/lanes/:laneId/evidence` with optional modes (`screenshot`, `trace`, `video`) and artifact files written under the lane artifact directory.
- Latest evidence lookup is now exposed via `GET /api/lanes/:laneId/evidence/latest` with optional `mode` filter query.
- Audit queue actions de-duplicate pending entries so repeated requests return existing pending queue IDs.
- Evidence cleanup is now approval-gated and can be run with `POST /api/artifacts/cleanup` and `dryRun` mode.
- Artifact cleanup also supports optional targeting (`sessionId`) and retention override (`olderThanDays`) in the request body.
- MCP tools are configurable via `POST /api/mcp/tools` and can be attached to Codex/Claude lanes.
- MCP tool hardening options:
  - `COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST`

  Optional comma-separated list of allowed MCP executables (for example `node` or `npx`).
  - `COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST=node,npx,python3`
- Cleanup scheduling controls are now in UI and policy-gated:
  - `GET /api/artifacts/cleanup/schedule`
  - `POST /api/artifacts/cleanup/schedule`
- Executor profiles are exposed via `GET /api/executors/profiles` for easier hardening verification.
- If `COMMAND_DECK_API_TOKEN` is set and the browser UI is used remotely, save the token once with the new Home-page token controls (or pass `apiToken`/`token` in the query string) so mutating actions authenticate.

## Run locally

```bash
cd /Users/alexrodriguez/Documents/Projects/web/command-deck/command-deck-client
npm run dev
```

Then open:

- `http://localhost:3000/`
- `http://localhost:3000/projects/realm-shaper`

### Optional API auth

Set `COMMAND_DECK_API_TOKEN` to require a token for all non-GET API requests.

- Header: `x-commanddeck-token: <token>`
- Or: `Authorization: Bearer <token>`

For private mobile control guidance, see:

- `command-deck-client/docs/tailscale-mobile-access.md`

## Current readiness

- The dashboard and API are usable for local development and hardening.
- Real Codex/Claude lane execution must be verified against the current host CLI state before relying on it for unattended work.
- Playwright evidence capture requires local Playwright availability; when unavailable, the evidence runner records degraded evidence instead of silently succeeding.
- Private mobile use should stay behind Tailscale Serve with `COMMAND_DECK_API_TOKEN` set.

## Notes

- Mock execution remains the safest baseline lane path. Codex/Claude execution goes through the same worker adapter contract (`src/worker-contract.js`) and must be configured with narrow executor profiles.
- Lane restart behavior is recovery-aware: active lanes are failed during startup recovery and recoverable state is persisted.
- Mobile manifest is available at `GET /api/mobile/manifest`, returning a mobile-friendly route map and lane artifact/evidence endpoints, including latest-evidence URLs and audit queue links.
- Artifact cleanup operations are exposed via `POST /api/artifacts/cleanup` (requires approval by policy).
- API token status is surfaced in the mobile manifest as `apiTokenRequired`, and mobile clients can call through the dashboard JS helper by setting a session token.
- Lane deep links now include `/projects/:slug/sessions/:sessionId/lanes/:laneId` for quick mobile navigation.

## CLI management

- Configure managed reinstall commands with (optional; defaults target official npm packages):
  - `COMMAND_DECK_CODEX_REINSTALL_COMMAND`
  - `COMMAND_DECK_CLAUDE_REINSTALL_COMMAND`

  These values should be JSON arrays of command arguments, for example:

  - `"[\"npm\",\"install\",\"--yes\",\"-g\",\"@openai/codex\"]"`

  If unset, Command Deck uses:

  - `npm install --yes -g @openai/codex` for Codex
  - `npm install --yes -g @anthropic/claude-code` for Claude

  Optionally constrain allowed reinstall packages per executor with:
  - `COMMAND_DECK_CODEX_REINSTALL_PACKAGES`
  - `COMMAND_DECK_CLAUDE_REINSTALL_PACKAGES`

  Provide a comma-separated allowlist. Example:

  - `COMMAND_DECK_CODEX_REINSTALL_PACKAGES=@openai/codex,codex-cli`

  Optionally constrain allowed source repos per executor with:
  - `COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS`
  - `COMMAND_DECK_CLAUDE_REINSTALL_SOURCE_REPOS`

  These are comma-separated `owner/repo` entries checked only on validated source URLs.
  Defaults are:

  - `COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS=openai/codex`
  - `COMMAND_DECK_CLAUDE_REINSTALL_SOURCE_REPOS=anthropic/claude-code`

  Example:

  - `COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS=openai/codex,my-org/codex-fork`

  Control whether source-based reinstall is preferred when no override is provided with:
  - `COMMAND_DECK_CODEX_REINSTALL_PREFER_SOURCE`
  - `COMMAND_DECK_CLAUDE_REINSTALL_PREFER_SOURCE`

  Set to `true` to prefer reinstalling from `git+https://github.com/...` and set to `false` to keep package-based defaults.

- Reinstall endpoints:
  - `GET /api/executors/{executor}/cli`
  - `POST /api/executors/{executor}/cli/reinstall` with `{ "approved": true, "execute": false }`
- `POST /api/executors/{executor}/cli/reinstall` also accepts `command` overrides for validated managed source updates.
  - Example body:
    - `{ "approved": true, "execute": false, "command": "pnpm add -g @openai/codex" }`
  - Override commands are validated with the same allowlist and install intent checks as configured defaults before execution.
