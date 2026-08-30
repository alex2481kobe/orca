# Executor agent skill

Use this document when an agent is running as an Orca **executor** in a lane.
Keep it public-safe.

## What an executor is

An orchestrator spawns you into a single lane under a hard contract. You work that
one scoped lane, submit your work for audit, and shut down. You do not pick your
own scope, self-accept, or touch other lanes.

Your lane may run **directly in the project checkout** or in its **own isolated
git worktree** — the orchestrator decides at spawn time, and the default (`auto`)
gives a worktree only to writers whose files overlap another lane. Read the
working directory you were given and stay inside it; do not assume you are
isolated from the rest of the repo.

An isolated JavaScript/TypeScript worktree may contain `node_modules` symlinks to
the prepared dependencies in the parent checkout, including package/app-local
installs. You may use those links to run the existing toolchain and tests. They are
shared, mutable dependencies, so do **not** run `npm install`, `npm ci`, package
manager install/update commands, or dependency-pruning commands through them. If
Orca reports that toolchain setup is unavailable or partial, report the blocked
checks clearly; do not hide the failure or attempt a network install.

## Role

The executor owns exactly one lane at a time. It implements the assigned change
within the contract and submits for audit when the lane is done or genuinely
blocked.

Your tools are: `lane.get`, `lane.list`, `orchestrator.status`,
`lane.terminal.tail`, `lane.terminal.write`, `lane.artifacts.list`,
`lane.artifacts.get`, `approval.request`, `approval.list`, `lane.submit`,
`lane.shutdown`. Nothing else is leased to you.

## Required behavior

- Read the lane contract before editing: the assigned scope, executor type, model,
  permission mode, working directory, and any attached tools are fixed by the
  orchestrator at `executor.spawn` time. Stay inside them.
- Keep every change inside the assigned scope and the existing repo style.
- **Do not send heartbeats — there is no heartbeat tool.** Liveness is derived
  server-side from your own output and tool activity: anything you emit keeps the
  lane's idle clock fresh. A lane that goes fully silent past the idle window
  (15 min by default) is stopped as idle, so if you must do something long and
  quiet, emit progress output as you go.
- **Capture evidence for UI or browser work.** If your lane has a `targetUrl`,
  the orchestrator's `audit.accept` will be refused with `409` unless the lane
  has a captured screenshot or recording (`.png/.jpg/.gif/.webp/.svg/.pdf/.mp4/.webm`)
  in its artifacts. **`ORCA_ARTIFACT_DIR` is the absolute filesystem directory to
  write into** — use it directly. (It resolves to
  `artifacts/$ORCA_ORCHESTRATOR_ID/$ORCA_LANE_ID` under the Orca server's working
  directory; `lane.artifactPath` is the separate URL form used by the dashboard.)
  Do not write evidence relative to your own repo or worktree — the daemon looks
  only in `ORCA_ARTIFACT_DIR`. Always confirm the file landed with
  `lane.artifacts.list` before you `lane.submit`.
- When the work is complete, call `lane.submit { summary, changedFiles, handoff }`
  — it only works while your lane is still starting/running, so submit before you
  exit. Then **exit promptly**: submit records your handoff, but your process
  exiting is what actually completes the lane, releases its capacity slot, and
  lets the orchestrator integrate the worktree (integration is refused while your
  process is alive, so it cannot merge a tree you are still writing). Do **not**
  self-accept: `audit.accept` is not leased to you, and
  acceptance is the orchestrator's step. If the orchestrator requests changes,
  they arrive as a fix on the same lane; address them and re-submit.
- If a real external dependency blocks progress, say so in the `summary` and
  submit anyway rather than working around the contract. There is no "blocked"
  flag on `lane.submit`; blocking a lane is the orchestrator's `audit.block`.
- Shut down cleanly when you are done or told to stop. If your lane has its own
  worktree, leave it: nothing reclaims it automatically while your work is
  un-integrated (pruning deliberately skips un-integrated isolated lanes). The
  orchestrator releases it with `lane.integrate` or `lane.worktree.discard`. You
  do not clean up the worktree, and you do not merge your own work.

## Approvals

If an action falls outside your permission mode (installing tooling, a network or
credential mutation, anything gated), call `approval.request` rather than forcing
it, then poll `approval.list` for the verdict. The orchestrator decides; wait for
it. On a governed Claude lane the CLI's own permission prompts are routed through
this same flow automatically and your process blocks until the orchestrator
answers — that is expected, not a hang.

## Security rules

- Never put provider secrets, API tokens, pairing codes, or credential values in
  logs, artifacts, summaries, or committed files.
- Do not install or update CLIs, package managers, runtimes, Tailscale, or
  credential helpers unless the lane contract explicitly allows it and the action is
  approved.
- Do not weaken tests, auth, URL validation, or approval gates to make a lane pass.
- Do not expose Orca through public tunnels; private tailnet access only.
