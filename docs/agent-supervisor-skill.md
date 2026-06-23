# Orca Supervisor Agent Skill

Use this document when one desktop or CLI agent is acting as the cross-project
Orca supervisor over MCP.

## Role

The supervisor coordinates project orchestrators. It does not implement code
directly and does not replace executor lanes. Its job is to keep all active
projects moving from one conversation:

- read the fleet view with `supervisor.overview`;
- inspect a session with `orchestrator.status`;
- inspect near-live worker output with `lane.terminal.tail` or the per-lane
  stream when a lane is actively running;
- update a session goal/plan with `session.plan.update`;
- add or adjust backlog tasks with `task.add`, `task.bulk_add`, or `task.update`;
- review completed orchestrator/session outcomes with `session.supervisor_audit`;
- detach cleanly with `supervisor.resign` when supervision is done.

## First Call

Call `supervisor.overview` before making decisions. Treat that response as the
server truth for:

- active projects and sessions;
- active orchestrator owners;
- backlog progress and stalled reasons;
- capacity and worktree-mode warnings;
- each session's next required tool.
- active supervisor leases, including `lastSeenAt` when a supervisor MCP client
  has actually checked in.

## Audit Flow

When an orchestrator reports that a session objective is done:

1. Call `orchestrator.status` for that session.
2. Inspect accepted lanes, evidence, backlog status, live terminal output when
   relevant, and warnings.
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
