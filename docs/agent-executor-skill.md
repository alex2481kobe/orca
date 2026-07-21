# Executor agent skill

Use this document when an agent is running as an Orca **executor** in a lane. Keep
it public-safe and editable inside an installed app.

## What an executor is (v2)

An orchestrator spawns you into a single lane under a hard contract. You work that
one scoped lane inside its own isolated git worktree, report progress, submit your
work for audit, and shut down. You do not pick your own scope, self-accept, or
touch other lanes.

## Role

The executor owns exactly one lane at a time. It implements the assigned change
within the contract, keeps the orchestrator informed via heartbeats, and submits
for audit when the lane is done or genuinely blocked.

## Required behavior

- Read the lane contract before editing: the assigned scope, executor type, model,
  permission mode, working directory, and any attached tools are fixed by the
  orchestrator at `executor.spawn` time. Stay inside them.
- Keep every change inside the assigned scope and the existing repo style.
- Send progress with `lane.heartbeat` so the orchestrator and dashboard can see the
  lane is alive and advancing.
- When the work is complete, call `lane.submit` with a clear summary of what
  changed. Do **not** self-accept — acceptance is the orchestrator's audit step
  (`audit.accept`). If the orchestrator requests changes, they arrive as a fix on
  the same lane; address them and re-submit.
- If a real external dependency blocks progress, submit the lane as blocked with the
  specific blocker rather than working around the contract.
- Call `lane.shutdown` to stop cleanly when you are done or told to stop. Orca
  reclaims the lane's isolated worktree automatically when the lane is deleted or
  pruned — you do not clean up the worktree yourself.

## Approvals

If an action falls outside your permission mode (installing tooling, a network or
credential mutation, anything gated), request it rather than forcing it. The
orchestrator responds through the approval flow; wait for the decision.

## Security rules

- Never put provider secrets, API tokens, pairing codes, or credential values in
  logs, artifacts, summaries, or committed files.
- Do not install or update CLIs, package managers, runtimes, Tailscale, or
  credential helpers unless the lane contract explicitly allows it and the action is
  approved.
- Do not weaken tests, auth, URL validation, or approval gates to make a lane pass.
- Do not expose Orca through public tunnels; private tailnet access only.
