# Orca Loop Daemon Architecture

Research snapshot: June 30, 2026.

## Direction

Current coding-agent systems are moving from one-shot prompt orchestration toward durable loops with explicit runtime contracts:

- Claude Code exposes lifecycle hooks around sessions, turns, tool calls, stop failures, subagents, tasks, worktrees, notifications, and auth/rate-limit style failures: https://code.claude.com/docs/en/hooks
- Claude Code subagents are scoped workers with independent context, permissions, tools, and optional memory: https://code.claude.com/docs/en/sub-agents
- LangGraph frames the durable-agent runtime around persistence, streaming, human-in-the-loop inspection, and long-running stateful workflows: https://docs.langchain.com/oss/python/langgraph/overview
- SWE-agent and OpenHands show the open-source coding-agent pattern: a model gets a goal, uses tools autonomously, records trajectories/state, and is bounded by environment/runtime contracts: https://github.com/SWE-agent/SWE-agent and https://github.com/OpenHands/OpenHands
- OpenAI Codex remains a terminal-native coding agent surface that Orca should drive through scoped MCP/tool leases rather than duplicating a second orchestration UI: https://github.com/openai/codex

The product implication for Orca: the user should be able to define a durable loop in plain language, then let Orca keep the loop alive by scheduling bounded iterations, observing live output, pausing safely, and surfacing what needs the user. Orca should be the local control plane for agents the user already likes using, not a replacement chat client.

## Loop Contract

An Orca loop is not a chat transcript. It is a persisted control record:

- `goal`: what the loop is trying to keep improving or checking.
- `state`: `running`, `paused`, `completed`, or `archived`.
- `cadenceMs`: how often Orca may consider another iteration.
- `executorTypes`: the lane mix to queue per iteration, such as `codex` and `claude`.
- `maxIterations`: optional hard stop.
- `pauseReason`: why the daemon stopped itself, such as `auth_required` or `rate_limited`.
- `resumeAt`: optional retry window for self-paused loops, used today for rate limits.
- `lastTaskIds` and `iteration`: progress anchors for supervision and recovery.

Loop iterations create ordinary backlog tasks. Backlog tasks create ordinary lanes. That keeps all existing Orca protections in force: scoped tool leases, active-orchestrator ownership, capacity, worktree isolation, audits, terminal tails, streams, and supervisor overview.

## Control Plane Contract

The long-running process is Orca, not an expensive coding-agent chat. Orca owns durable state, timers, streams, and notifications. Codex, Claude, Fable, desktop apps, and CLI chats attach only when there is work they can act on:

- `supervisor`: reads projects, sessions, loops, lanes, backlog, blockers, and notifications; records audits; never mutates work by default.
- `orchestrator`: claims a session, creates or updates tasks and loops, chooses executor lanes, and reviews completed batches.
- `executor`: works a bounded lane with scoped tools and a clear terminal state.
- `loop daemon`: schedules iterations, detects blockers, pauses/resumes, and nudges the active orchestrator thread when review is needed.

This means a 24/7 loop should mostly be a cheap scheduler plus persisted state. Real agents should be summoned by events: task ready, backlog complete, auth required, rate-limit retry elapsed, failed verification, stale orchestrator, or human message.

## Agent Event Queue

The first event-queue slice is a durable, session-scoped queue for agent wakeups:

- Producers enqueue loop iteration, loop pause/resume, backlog completion, and orchestrator reconnect events.
- Consumers use `event.drain` for unacknowledged work, `event.ack` after handling it, and `event.replay` after reconnecting or resuming a chat.
- Ack state is per role+actor consumer, so one supervisor/orchestrator cannot hide work from another.
- Event payload metadata is sanitized and does not reuse user notification settings.
- The queue is persisted with registry state and covered by the long-soak harness.

## Safety Rules

- A running loop requires the same approval policy as lane creation.
- A loop does not queue another iteration while any loop-owned task is still pending, assigned, or in-lane.
- Loop-created tasks and lanes are tagged with `loopId` / `metadataLoopId`.
- If a loop-owned lane reports auth or rate-limit failure text, the loop pauses and notifies the user instead of retrying blindly.
- If a rate-limit failure includes a retry window, the loop waits until `resumeAt`, emits a resume notification, and continues without reprocessing the old failed lane as a fresh pause signal.
- If a session explicitly disables audit pass requirements, completed lanes sync their linked backlog tasks to accepted so low-token mock/daemon loops can keep moving.
- When an external/dashboard orchestrator is already active, backlog-completion nudges are appended to the existing orchestrator thread instead of spawning a fresh CLI orchestrator lane.
- When an external orchestrator marker exists but the MCP lease is stale or expired, backlog completion records a reconnect-required message and notification instead of silently falling back to a real CLI orchestrator lane.
- Supervisors can list and inspect loops, but cannot create or update them.
- Orchestrator MCP callers must be the active orchestrator before mutating loop state.

## Local Learning Pipeline

Loop templates should come from local user-owned context, with review before reuse:

- Import local Codex/Claude/desktop transcripts as optional sources; never require cloud sync.
- Redact secrets, tokens, absolute paths, and private content before summarization.
- Summarize prompt patterns into editable loop templates: goals, acceptance criteria, preferred skills, default executor mix, verification style, and escalation rules.
- Store derived templates separately from raw chats so users can delete sources without losing approved operating rules.
- Let users attach templates to projects or sessions, then let supervisors inspect which template is active before any orchestrator acts on it.

## First Slice Implemented

The first backend slice adds:

- `src/registry-loops.js`: persisted loop lifecycle, scheduler advancement, duplicate-work suppression, auth/rate-limit pause detection.
- Scheduler integration: loops advance before backlog dispatch.
- Task/lane metadata propagation: `loopId` and `metadataLoopId`.
- Session-scoped API and MCP tools: `loop.list`, `loop.describe`, `loop.create`, `loop.update`.
- Session-scoped agent event API and MCP tools: `event.drain`, `event.ack`, `event.replay`.
- Route inventory and security-matrix rows for the loop API.
- Tests for Codex+Claude task fan-out, duplicate suppression, max-iteration completion, auth/rate-limit pauses, MCP exposure, supervisor read-only boundaries, and agent event drain/ack/replay.

## Next Slices

- UI: add a session Loop panel with create/pause/resume/status controls.
- Supervisor overview: surface active/paused loops directly in project/session summaries.
- Learning pipeline: local prompt-history importer for Codex/Claude chats that produces loop templates, not raw prompt dumps.
- Backoff: structured retry-after timestamps instead of text-pattern pause detection only.
- Reconnect UX: show stale/expired orchestrator owners with one-click MCP/CLI re-enroll instructions.
- Memory: loop notes and user preference extraction with redaction and explicit review before reuse.
