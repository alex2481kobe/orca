# Command Deck Implementation Plan

This public-safe repo document tracks the implementation state of the client package. Private roadmap coordination and tonight's full buildout handoff live in the parent workspace docs.

## Current Status

Command Deck has a working local prototype with real server, registry, dashboard, policy, worker, evidence, cleanup, mobile-manifest, MCP, and CLI-management surfaces. The project is not yet considered production-complete until the full start-to-finish flow is verified against current code.

Implemented or partially implemented:

- Local Node HTTP server and dashboard shell.
- Persistent registry for projects, sessions, lanes, MCP tools, cleanup schedule, and audit events.
- Token support for mutating API requests through `COMMAND_DECK_API_TOKEN`.
- Policy-gated project/session/lane/MCP/cleanup/CLI-management actions.
- Mock worker contract and process-backed Codex/Claude executor adapter path.
- Lane lifecycle, logs, heartbeats, stop/retry, recovery, artifacts, and audit events.
- Playwright evidence runner with screenshot, trace, video, and degraded no-Playwright behavior.
- Mobile manifest and lane deep-link routes.
- Artifact cleanup, cleanup schedule, and cleanup run-now controls.
- MCP tool CRUD, validation, scoping, and lane attachment.
- Executor profile and CLI info/reinstall dry-run endpoints.

Needs completion or proof before tonight use:

- Full route-by-route security audit and tests for every mutating/high-risk path.
- Verified Codex CLI freshness from trusted official source policy before real Codex lane reliance.
- Verified Claude CLI availability and real lane behavior.
- Stronger real-process stop/recovery tests.
- Worktree isolation defaults for real implementation lanes.
- Generated lane-specific MCP config files for attached tools if not already proven.
- Full dashboard polish for phone control and operations use.
- Playwright dependency/browser setup or a documented degraded evidence mode that is acceptable for tonight.
- Browser/mobile smoke verification of dashboard, evidence, artifacts, and maintenance flows.
- Updated README only after current behavior is proven.

## Implementation Checkpoints

1. Foundation and route model
2. Orchestration registry and worker contract
3. Codex/Claude executor support
4. Playwright evidence
5. Mobile/private control
6. Secure action model
7. MCP tooling
8. Cleanup scheduler
9. Dashboard UI completion
10. End-to-end verification and docs

## Work Rules

- Keep this repo public-safe.
- Do not commit private roadmap, private task tracking, or personal workflow notes into this repo.
- Add no speculative dependency.
- If a dependency is added, commit the manifest and lockfile together.
- No destructive cleanup. Move obsolete whole files/folders to the parent `throwaway/` archive only when explicitly needed.
- Commit by logical task and stage explicit paths only.

## Verification Targets

Before calling this project ready for tonight use, prove:

- `npm test` passes.
- High-risk routes require token and approval.
- Mock lane lifecycle works.
- Codex and Claude executor health is visible and real execution is either verified or safely blocked with clear docs.
- MCP tool CRUD and lane attachment work.
- Evidence capture or degraded evidence behavior works.
- Cleanup dry-run and confirmed cleanup work safely.
- Mobile manifest and phone-sized dashboard route work.
- README and docs match what was actually verified.
