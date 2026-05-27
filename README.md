# Command Deck

Command Deck is the local control plane for coordinating AI coding workers.

This implementation is a checkpointed buildout covering Phases 0/1, plus durable Phase 2 plus initial Phase 3 scaffolding:
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

## Notes

- The execution model is still mock-driven for now, but now through a worker adapter contract (`src/worker-contract.js`).
- Lane restart behavior is recovery-aware: active lanes are failed during startup recovery and recoverable state is persisted.
- Mobile manifest is available at `GET /api/mobile/manifest`, returning a mobile-friendly route map and lane artifact/evidence endpoints, including latest-evidence URLs and audit queue links.
- Artifact cleanup operations are exposed via `POST /api/artifacts/cleanup` (requires approval by policy).
- API token status is surfaced in the mobile manifest as `apiTokenRequired`, and mobile clients can call through the dashboard JS helper by setting a session token.
- Lane deep links now include `/projects/:slug/sessions/:sessionId/lanes/:laneId` for quick mobile navigation.
