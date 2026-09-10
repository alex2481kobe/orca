# Orca hardening audit — 2026-09-10

**A read-only audit and an implementation-ready scope. Nothing here is implemented and nothing
is approved.** The audit wrote no files (`changed: []`, verified by the launcher's own post-run
git scope-diff) and sent no request to the live daemon.

    scope.final.json     the schema-forced final report (41,339 B)
    brief.prompt.txt     the brief it was given, verbatim (8,283 B)

Kept here because the run landed in `runs/sol-agents/`, and `.gitignore:53` ignores `runs/` —
so the audit was one cleanup away from gone.

## HOW IT WAS PRODUCED

Codex CLI v0.153.4, model `gpt-6-astra`, reasoning effort `xhigh`, sandbox **read-only**,
40-minute wall budget. Commissioned by a Claude orchestrator after six failures observed
against a live daemon on 2026-09-10.

## IT REFUTED THREE OF THE SIX FAILURES IT WAS GIVEN

The brief was written from observed symptoms. **The source contradicted it three times, and the
source wins:**

| the brief claimed | the tree says |
| --- | --- |
| per-lane model selection is undocumented | it **is** documented |
| Orca has no macOS persistence story | a **LaunchAgent runbook exists** |
| a single-root fence stops Orca working on its own repo | **false** — `registry-workspaces.js:94` always adds `process.cwd()` to the approved roots, even when `ORCA_REPO_ROOTS` is set |

That third one also **corrects the record on failure 5**: this is a *broad default jail*, not
missing enforcement. Registration checks approved roots at `registry-agents.js:62`, and lane
workdirs get lexical plus realpath checks at `registry-workspaces.js:180`. The real defects are
**silent widening, a weak default, and poor agent-facing discovery** — not absent multi-root.

## THE THREE P1 DEFECTS IT FOUND THAT NOBODY HAD REPORTED

**1. A duplicate daemon start is DESTRUCTIVE, and it destroys before it discovers the port.**
`server.js:30` constructs the registry before `startServer` binds at `:882`; `registry.js:103`
restores state and starts scheduling; `registry-persistence.js:127` invokes interrupted-lane
recovery; and `registry-lifecycle.js:35` **can kill persisted executor process groups**, invoked
during recovery at `:90`. There is no exclusive-instance guard, so a second `start Orca` against
the same checkout **can reap the first daemon's running workers and rewrite their state before
it ever hits `EADDRINUSE`.** Fix: take exclusive ownership of the state directory and
successfully reserve the listener *before* recovery, migration or scheduling; a duplicate start
must report the existing instance and change nothing. Validate process identity beyond PID
before treating a lock as stale.

**2. The fence silently widens.** `registry-workspaces.js:94` always appends `process.cwd()`;
`:101` defaults to HOME plus the launch directory; `server.js:903` only warns when the variable
is absent. **An explicit root list is therefore broader than it reads.** Fix: missing
configuration means setup-required with no new executor launches; require explicit roots,
validate real absolute paths, drop the implicit cwd; a deliberate HOME-wide choice needs a
recorded acknowledgement and a persistent warning.

**3. Sole-writer isolation only holds within ONE orchestrator.**
`registry-lane-create.js:184` counts competing writers only where `lane.sessionId` matches the
current orchestrator, and `registry-agents.js:180` permits multiple orchestrator records per
project — so **two orchestrators on the same checkout can each be granted a "sole-writer" direct
lane.** `registry-lane-ops.js:280` has the same restriction on control updates.

## TWO DEFERRED FINDINGS, BOTH OUTSIDE THE SIX

**A route-authorization defect, tracked as its own P1.** `src/server-routes/misc.js:34` lets a
*paired operator* call the singleton emergency-stop endpoint with `all:true` at `:43`, while
`src/server-routes/orchestrators.js:196` correctly requires **admin** for fleet-wide stopping.
This contradicts `AGENTS.md`'s authority split. Needs paired-operator regression coverage.

**A user-scope MCP configuration shares one lease across client sessions.**
`registry-agents.js:134` identifies an owned orchestrator by project **plus lease**, so
concurrent sessions using that credential **share an orchestrator identity.** This is a direct
consequence of installing the MCP server at user scope (which is what makes it work from any
directory). Document it; separating credential identity from client-session identity needs its
own design.

## WHAT IT REFUSED TO BUILD, AND THIS IS HALF THE VALUE

A bundled Node distribution or any automatic toolchain install — *Orca does not own those
toolchains*. Auto-starting the daemon from each MCP bridge, blind restart on `fetch failed`, or
replaying failed mutations — *these hide lifecycle ownership, can create duplicate daemons
(see P1 #1), and can duplicate work whose HTTP response was merely lost*. Machine-wide file
surveillance, argv/environment collection, or auto-killing outside agents. Mandatory worktrees,
a new multi-root subsystem, a model catalog/router. A fifth role, an autonomous backlog, a chat
UI, public exposure, or a privileged pre-login LaunchDaemon.

## WHAT THIS DOES NOT CARRY

**No implementation, no approval, no owner decision, and no test results** — existing tests were
*inspected, not certified green*. No request was sent to the live daemon; historical process
deaths and reported live-state counts were **not independently re-created**. Read-only git and
CLI-help commands emitted sandbox warnings about denied cache/PATH-alias creation; no escalation
was attempted.
