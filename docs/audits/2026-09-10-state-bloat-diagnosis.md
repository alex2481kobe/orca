# Orca state-file bloat — a measured diagnosis, 2026-09-10

**A diagnosis, not a fix and not a retention policy.** It exists so the data-lifecycle work
starts from measured bytes rather than a guess, and so the finding survives the session that
produced it.

## WHAT WAS MEASURED, AND HOW

The daemon was **stopped** (port 3000 free, process gone, health unreachable), so the file was
quiescent. `.orca/state.json` was parsed with Node's `JSON.parse`; each value's size is
`Buffer.byteLength(JSON.stringify(value))`. One snapshot, one machine.

| file | bytes |
| --- | --- |
| `.orca/state.json` | **525,090,065** (501 MB), **one line** |
| `.orca/state.json.bak` | 501 MB — a full second copy |
| `.orca/` total | **1.0 GB** |

## WHERE THE BYTES ARE

| top-level key | size | items |
| --- | --- | --- |
| `auditEvents` | **300.6 MB** | 200 |
| `lanes` | **200.1 MB** | 82 |
| `agentQueue`, `toolLeases`, `orchestrators`, `policies`, `projects` | < 0.2 MB together | 90 / 94 / 10 / 10 / 3 |

**Inside `auditEvents`, `evidence` is 300.5 of the 300.6 MB.** 84 of the 200 events carry more
than 100 KB of evidence. The largest evidence object holds a field `lane` of **10,668 KB — an
object with 55 keys: a full snapshot of the audited lane, logs included.**

**Inside `lanes`:** `logs` **143.9 MB**, `agentEvents` **55.1 MB**; `resultText` 0.3 MB,
`taskPrompt` 0.2 MB, `processMeta` 0.2 MB, the rest negligible.

**Age:** `auditEvents` span 2026-08-30 → 2026-09-10; `lanes` span **2026-07-26** → 2026-09-01.
**All 82 lanes are terminal** — done 58, accepted 7, stopped 5, failed 12. None is live.

## THE CAUSES — INFERRED FROM THE BYTES ABOVE, NOT FROM A CODE TRACE

1. **Lane logs and agent event streams live inline in the hot state file** (~199 MB).
2. **Every audit event embeds a full copy of the lane it audited, logs and all**, so the same
   bytes are stored twice. **The 200-event cap limits the COUNT of audit events, not their
   BYTES** — which is why a capped list still weighs 300 MB.
3. **`state.json.bak` doubles all of it on disk.**
4. **Nothing is retired by age or state.** Terminal lanes from 2026-07-26 are still in the hot
   file six weeks later.

Because the state is one JSON document, any persist plausibly rewrites all of it and any
restart re-reads all of it. That cost was **not measured** here.

**This file was also written to by accident.** On 2026-09-10 two restarts whose stop step
matched no process each started a second `node src/server.js` against this same `.orca/`
state. Per the hardening audit's P1 #1, that runs registry construction and interrupted-lane
recovery **before** failing with `EADDRINUSE` — and the restart log shows exactly
`Error: listen EADDRINUSE: address already in use 127.0.0.1:3000`. No lane was live, so no
worker was killed; the state may have been rewritten.

## A DIRECTION FOR THE DATA-LIFECYCLE SCOPE — A PROPOSAL, NOT A DECISION

The owner's requirement: data organized so it is clear **what is safe to delete, and when**, and
cleanup easy enough that agents can run it, so Orca does not accumulate legacy data.

- **References, not copies.** Audit evidence should point at a lane by id and revision, not
  embed it.
- **Logs and event streams out of the hot file**, into append-only per-lane files with rotation.
- **Every data kind gets an explicit retention rule** — keep-until, safe-to-delete-when, and who
  may delete it — so cleanup is a lookup rather than a judgement call.
- **A `.bak` policy** that does not silently double the store.
- **Cleanup as a first-class, audited, agent-callable operation** with a dry-run mode that says
  what it would remove and why, before it removes anything.

## WHAT THIS DOES NOT CARRY

No fix, and no approved policy. **Evidence CONTENT was not inspected** — only types and sizes —
because transcripts can contain credentials. Persist and restart latency were not measured.
One snapshot of one machine's state; the numbers will differ elsewhere.
