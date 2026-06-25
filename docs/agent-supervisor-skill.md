# Orca Supervisor Agent Skill

Use this document when one desktop or CLI agent is acting as the cross-project
Orca supervisor over MCP.

## Role

The supervisor coordinates project orchestrators. It does not implement code
directly and does not replace executor lanes. Its job is to keep all active
projects moving from one conversation:

- read the fleet view with `supervisor.overview`;
- inspect a session with `orchestrator.status`;
- inspect the existing orchestrator conversation with `orchestrator.thread.get`;
- inspect near-live worker output with `lane.terminal.tail` or the per-lane
  stream when a lane is actively running;
- inspect backlog, task, evidence, approval, and policy state with read-only
  tools;
- review completed orchestrator/session outcomes with `session.supervisor_audit`;
- detach cleanly with `supervisor.resign` when supervision is done.

The supervisor does not mutate session plans, backlog tasks, capacity, worktree
policy, settings, lanes, or orchestrator ownership. Use `session.supervisor_audit`
with concrete `findings` and `nextTask` when the active orchestrator should make
changes.

## First Call

Call `supervisor.overview` before making decisions. Treat that response as the
server truth for:

- active projects and sessions;
- active orchestrator owners;
- backlog progress and stalled reasons;
- capacity and worktree-mode warnings;
- each session's next required tool.
- the top-level `attention` queue and each session's `supervisorSignal`, which
  are the server-derived "what needs attention first" hints;
- active supervisor leases, including `lastSeenAt` when a supervisor MCP client
  has actually checked in.

The dashboard's Settings -> Supervisor page reads from the same overview. If you
are attached correctly, your supervisor actor appears there as a registered
supervisor agent with its scope, last-seen time, and expiry.

## Audit Flow

When an orchestrator reports that a session objective is done:

1. Call `orchestrator.status` for that session.
2. Inspect the orchestrator thread, accepted lanes, evidence, backlog status,
   live terminal output when relevant, and warnings.
3. Call `session.supervisor_audit` with one verdict:
   - `accept` when the session is ready;
   - `request_fix` with findings and `nextTask` when the orchestrator should fix;
   - `block` when the session cannot proceed safely.

The audit tool records an audit event and writes a system message into the
orchestrator thread so the session owner sees the next instruction.

## Lifecycle

When you are done supervising, call `supervisor.resign`. The server revokes only
your current supervisor tool lease, so other active supervisors remain visible
and usable. Do not ask the dashboard or an operator token to resign on your
behalf; this is a lease-owner action.

## Shared Worktrees

Default `worktreeMode` is `isolated`. In shared mode, multiple lanes can touch
the same checkout. If a session uses `shared` and capacity is above `1`, keep
lane ownership disjoint, avoid broad cleanup/refactor tasks, and prefer a
supervisor audit before accepting the session.
