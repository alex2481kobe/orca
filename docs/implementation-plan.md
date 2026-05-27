# Command Deck Implementation Plan (Execution-Mode)

The roadmap in `../docs/roadmap.md` is the canonical source of truth.  
This document tracks concrete implementation progress against those phases.

## Current status

- Phase 0: Scaffold and Repo Hygiene — in progress (foundation files in place, local server stack now bootstrapped)
- Phase 1: Local Dashboard and Core Control Model — complete
- Phase 2: Orchestration Registry and Worker Contract — complete
- Phase 3: Claude and Codex CLI Lane Spawning — complete
  - Note: CLI adapters are now implemented behind the same lane contract and can launch per-lane shell commands for codex/claude execution paths.
- Phase 4: Playwright Evidence — complete
- Phase 5: Tailscale Serve Mobile Access — complete
- Phase 6: Audit Buttons and Lane Automation — complete
- Phase 7: Production hardening — complete

## Big-task checkpoints

1. **Foundation and route model**
   - Local server + in-memory registry
   - Dashboard shell UI with project/session/lane views
   - Policy-aware lane actions and audit events
2. **Orchestration backend contract**
   - Durable registry persistence in `.command-deck/state.json`
   - Queue scheduling + state transitions
   - Worker contract adapter (`MockWorkerAdapter`) with heartbeat and timeout handling
   - Recovery of interrupted lanes across restarts
   - Adapter resolution per executor type with mock/codex/claude registry scaffolding
3. **Worker spawn contract**
   - Lane execution adapter layer
   - Executor selection by lane type and per-lane adapter tracking
   - Mock worker implementation as contract conformance layer
   - Process-backed `codex` and `claude` adapters using lane-level command fields
4. **Playwright evidence**
  - Artifact snapshots are written for all terminal states
  - Emit structured terminal evidence payloads (`outcome.txt`, `transcript.json`) for external analyzers
  - Added lane-level capture API and optional Playwright capture path behind explicit route
  - Added lane route metadata, consistent evidence naming, mobile manifest endpoint, and audit queue acknowledge flow
5. **Mobile/private control**
  - Stable URL model and shared quick-link schema
  - Artifact surfacing and audit workflow UI for phone
  - Added lane detail route rendering and mobile manifest discoverability
6. **Secure action model**
  - Explicit approval gates and audit trail requirements on high-risk operations
7. **Production hardening**
  - Persistence, authN/Z, storage rotation, and deployment notes

## Work rules while implementing

- One file per responsibility; keep each change scoped to the active checkpoint.
- Add no speculative dependency.
- No destructive file operations (`rm`, `git reset`, etc.).
- Preserve the roadmap boundary: this repo remains public-safe.

## Upcoming order (default)

- Checkpoint 7 (complete): implemented storage rotation and maintenance controls, including policy-gated `/api/artifacts/cleanup`, optional dry-run support, and token-aware authenticated actions.
