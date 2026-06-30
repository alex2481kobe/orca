# Orca Loop Daemon Architecture

Research snapshot: June 30, 2026.

## Direction

Current coding-agent systems are moving from one-shot prompt orchestration toward durable loops with explicit runtime contracts:

- Claude Code exposes lifecycle hooks around sessions, turns, tool calls, stop failures, subagents, tasks, worktrees, notifications, and auth/rate-limit style failures: https://code.claude.com/docs/en/hooks
- Claude Code subagents are scoped workers with independent context, permissions, tools, and optional memory: https://code.claude.com/docs/en/sub-agents
- LangGraph frames the durable-agent runtime around persistence, streaming, human-in-the-loop inspection, and long-running stateful workflows: https://docs.langchain.com/oss/python/langgraph/overview
- SWE-agent and OpenHands show the open-source coding-agent pattern: a model gets a goal, uses tools autonomously, records trajectories/state, and is bounded by environment/runtime contracts: https://github.com/SWE-agent/SWE-agent and https://github.com/OpenHands/OpenHands
- OpenAI Codex remains a terminal-native coding agent surface that Orca should drive through scoped MCP/tool leases rather than duplicating a second orchestration UI: https://github.com/openai/codex

The product implication for Orca: the user should be able to define a durable loop in plain language, then let Orca keep the loop alive by scheduling bounded iterations, observing live output, pausing safely, and surfacing what needs the user.

## Loop Contract

An Orca loop is not a chat transcript. It is a persisted control record:

- `goal`: what the loop is trying to keep improving or checking.
- `state`: `running`, `paused`, `completed`, or `archived`.
- `cadenceMs`: how often Orca may consider another iteration.
- `executorTypes`: the lane mix to queue per iteration, such as `codex` and `claude`.
- `maxIterations`: optional hard stop.
- `pauseReason`: why the daemon stopped itself, such as `auth_required` or `rate_limited`.
- `lastTaskIds` and `iteration`: progress anchors for supervision and recovery.

Loop iterations create ordinary backlog tasks. Backlog tasks create ordinary lanes. That keeps all existing Orca protections in force: scoped tool leases, active-orchestrator ownership, capacity, worktree isolation, audits, terminal tails, streams, and supervisor overview.

## Safety Rules

- A running loop requires the same approval policy as lane creation.
- A loop does not queue another iteration while any loop-owned task is still pending, assigned, or in-lane.
- Loop-created tasks and lanes are tagged with `loopId` / `metadataLoopId`.
- If a loop-owned lane reports auth or rate-limit failure text, the loop pauses and notifies the user instead of retrying blindly.
- Supervisors can list and inspect loops, but cannot create or update them.
- Orchestrator MCP callers must be the active orchestrator before mutating loop state.

## First Slice Implemented

The first backend slice adds:

- `src/registry-loops.js`: persisted loop lifecycle, scheduler advancement, duplicate-work suppression, auth/rate-limit pause detection.
- Scheduler integration: loops advance before backlog dispatch.
- Task/lane metadata propagation: `loopId` and `metadataLoopId`.
- Session-scoped API and MCP tools: `loop.list`, `loop.describe`, `loop.create`, `loop.update`.
- Route inventory and security-matrix rows for the loop API.
- Tests for Codex+Claude task fan-out, duplicate suppression, max-iteration completion, auth/rate-limit pauses, MCP exposure, and supervisor read-only boundaries.

## Next Slices

- UI: add a session Loop panel with create/pause/resume/status controls.
- Supervisor overview: surface active/paused loops directly in project/session summaries.
- Learning pipeline: local prompt-history importer for Codex/Claude chats that produces loop templates, not raw prompt dumps.
- Backoff: structured retry-after timestamps instead of text-pattern pause detection only.
- Memory: loop notes and user preference extraction with redaction and explicit review before reuse.
