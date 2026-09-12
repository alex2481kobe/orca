# What Orca keeps on disk, and when it is safe to delete

Everything Orca persists lives in one **state directory**: `.orca/` under the directory the
daemon was started from. `resolveStateDir()` in `src/state-paths.js` decides it, and every
other path below is derived from it. The retention table in this document is the one the
code enforces — `RETENTION` in `src/state-gc.js` — and `test/state-gc.test.js` fails when
the two disagree.

## Hot state, journals, and the archive

- **Hot state** is `state.json`: what the daemon reads at boot and rewrites on every change.
  Since format v4 it holds lane records *without* their logs and agent events, and audit
  events *reference* lanes instead of embedding them, so it stays small.
- **Journals** (`lanes/<lane>/`) hold each hot lane's log lines and agent events, appended
  as they happen. `lane.get`, `lane.list`, and lane transcripts read them.
- **The archive** (`archive/`) holds what has left hot state: retired lanes (compressed, with
  every log line and agent event), the state a format migration replaced, and legacy files.
  Nothing in `archive/` is read at boot. Only the archive purge deletes from it.

A lane leaves hot state when:

- it is deleted with `lane.delete` — it is **archived**, not destroyed;
- the daemon's terminal-lane cap (`ORCA_MAX_TERMINAL_LANES_PER_SESSION`, default 200) is
  exceeded — the oldest terminal lanes are archived (before v4 they were dropped with no
  copy anywhere);
- garbage collection archives it: a terminal lane unchanged for longer than the threshold
  (default 14 days), unless its audit is still queued, in progress or escalated, or it still
  holds an un-integrated worktree.

An archived lane is still readable with `lane.get`. The response is the lane as it was, with
the same capped log and event view a hot lane shows, plus
`archived: { at, reason, file, totalLogs, totalAgentEvents }`. It no longer appears in
`lane.list`; `orchestrator.status` reports how many of an orchestrator's lanes are archived.

## The retention table

<!-- retention-table:start -->
Under the state directory:

| path | what it is | who writes it | safe to delete when | what `orca gc` does |
| --- | --- | --- | --- | --- |
| `state.json` | Hot registry state: projects, orchestrators, lane records (without their logs or agent events), the last 200 audit events (lane evidence by reference), tool leases (tokens stored hashed), the agent wake-up queue, and the index of archived lanes. | The daemon (debounced atomic write); `orca gc --apply` while it holds the instance lock. | Never. It is the registry. | Rewritten without the lanes it archives. |
| `state.json.bak` | Copy of state.json taken after a write (at most once a minute, and on shutdown). Read only when state.json is missing or unparsable. | The daemon. | While the daemon is stopped and state.json parses; the next write recreates it. | Left alone. |
| `state.json.<pid>.<time>.<uuid>.tmp` | Temp file of an atomic write. A running daemon renames it within milliseconds; one that remains is a write that crashed. | The daemon. | When no daemon is running. | Moved to archive/legacy/ once it is over an hour old. |
| `state.json.v1.bak, state.json.v2.bak` | The pre-migration state kept by the v1 -> v3 and v2 -> v3 migrations. | The daemon, once, at that migration. | Once the migrated state has been checked. | Moved to archive/legacy/. |
| `<store>.json.corrupt.<time>.<pid>.<id>` | An unparsable state file, quarantined by recovery before it fell back to the backup. | The daemon, on a failed read. | Once inspected. | Moved to archive/legacy/. |
| `daemon.lock, daemon.lock.takeover` | The instance lock (src/instance-lock.js): which process owns this state directory. | The daemon; `orca gc --apply` for its duration. | Never by hand while its owner runs. A lock whose owner has provably exited is taken over automatically. | Left alone; `--apply` refuses while another process holds it. |
| `auth-sessions.json (+ .bak)` | Paired browser and phone sessions. | The daemon (auth store). | Only to unpair every device. | Left alone. |
| `private-access.json (+ .bak)` | Tailscale Serve settings and their audit trail. | The daemon (private-access store). | Only to forget the private-access settings. | Left alone. |
| `lanes/<lane>/logs.jsonl, events.jsonl, *.NNNNNN.jsonl` | The journal of a lane that is still in state.json: every log line and agent event, one JSON object per line, rotated at 8 MiB with at most 4 segments per stream kept here. | The daemon (appends only). | Never while its lane is in state.json. A directory whose lane is not in state.json is an orphan. | Archived with its lane; an orphan directory is archived on its own. |
| `archive/lanes/<lane>/lane-<time>.json.gz` | A retired lane: its full record and EVERY log line and agent event, gzip-compressed and verified on write. lane.get still serves it. | The daemon (lane.delete, the terminal-lane cap) and `orca gc --apply`. | When you no longer need that lane's history. | Purged only by `--purge-archive --purge-older-than-days N --apply`. |
| `archive/lanes/<lane>/logs.NNNNNN.jsonl, events.NNNNNN.jsonl` | Journal segments rotated out of a lane that is still hot. | The daemon. | Never while the lane is hot: they are the oldest part of its journal. | Folded into the lane's .json.gz when the lane is archived. |
| `archive/migrations/<time>-v3-to-v4-<sha>/` | The state.json (and state.json.bak) a v4 daemon found at its first boot, kept byte for byte, plus manifest.json with sizes, sha256 and what was converted. | The daemon at its first v4 boot, or `orca gc --apply` on a v3 state. | Once the migrated state has been checked. | Purged only by `--purge-archive --purge-older-than-days N --apply`. |
| `archive/legacy/<time>/` | Legacy backups, crashed-write temp files and quarantined corrupt files moved here by gc. | `orca gc --apply`. | Once inspected. | Purged only by `--purge-archive --purge-older-than-days N --apply`. |
| `workspaces/<orchestrator>/worktrees/<lane>` | The git worktree of an isolated lane. | The daemon, when it creates an isolated lane. | After the lane is integrated, or its work is deliberately discarded. | LISTED, never removed. Remove one with lane__worktree__discard (it refuses uncommitted work unless force:true). |

Outside the state directory (not managed by `orca gc`):

| path | what it is | who writes it | safe to delete when | what `orca gc` does |
| --- | --- | --- | --- | --- |
| `<daemon cwd>/artifacts/<orchestrator>/<lane>/` | Per-lane artifacts: outcome.txt, transcript.json, terminal.log, stdout.log, stderr.log, mcp-tools.json, and captured screenshots. lane.terminal.tail, the live lane stream, lane.artifacts.list and lane.artifacts.get read them. | The daemon and the executors it runs. | When the lane's raw output and evidence are no longer needed. The lane record and its logs do not depend on them. | Size reported only. |
<!-- retention-table:end -->

## Backups

`state.json.bak` is a copy of `state.json`, refreshed at most once a minute and on shutdown,
and read only when `state.json` is missing or unparsable. With lane streams and embedded
lanes out of `state.json`, the backup is a copy of a small file and no longer doubles the
store.

## Worktrees are listed, never removed

A worktree can hold work nobody has integrated, so garbage collection only *lists* stale
worktrees — those of terminal or merged lanes, and folders no lane points at — with the tool
that removes each one safely: `lane__worktree__discard` (it refuses uncommitted work unless
`force: true`), or `lane__integrate` to keep the work first.

## Artifacts are outside the state directory

`artifacts/<orchestrator>/<lane>/` sits under the daemon's working directory, not the state
directory. It holds each lane's raw terminal output and captured evidence, which
`lane.terminal.tail`, the live lane stream, `lane.artifacts.list` and `lane.artifacts.get` read. The lane record and
its logs do not depend on it. Garbage collection reports its size and never touches it.

## Cleaning up: `orca gc`

```sh
node src/orca-cli.js gc                                                     # dry run: what would move, and why
node src/orca-cli.js gc --apply                                             # move it into archive/
node src/orca-cli.js gc --older-than-days 30                                # another lane threshold (default 14)
node src/orca-cli.js gc --purge-archive --purge-older-than-days 30          # what a purge would delete
node src/orca-cli.js gc --purge-archive --purge-older-than-days 30 --apply  # delete it
```

`--state-dir DIR` points it at another state directory; `--json` prints the plan and the
results as JSON, for an agent to read.

- **Without `--apply`, gc changes nothing.** It is safe beside a running daemon, and then
  reads the last state that daemon persisted. Every line names what would move and the rule
  that moves it, so an agent can run it at any time and act on it.
- **`--apply` refuses while any process owns the state directory** (its instance lock,
  `src/instance-lock.js`): stop the daemon first. While it works it holds that lock itself,
  so no daemon can start halfway through. It exits 1 when it refuses, 2 on a usage error.
- **`--apply` only moves**: lanes into `archive/lanes/`, legacy files into
  `archive/legacy/`. It rewrites `state.json` without the lanes it archived, and removes a
  lane's journal only after that lane's archive has been written, read back and verified.
- **Purging is the only deletion.** It needs both `--purge-archive` and
  `--purge-older-than-days N`, deletes only inside `archive/`, and never touches a hot lane
  or a worktree.

## Upgrading an old state directory

The first v4 daemon to open a v3 state directory converts it before it serves anything: lane
logs and agent events move to journals, audit evidence becomes references, and a lane that
survived only inside an audit event's evidence (an older daemon had dropped its record) gets
its own lane archive, readable with `lane.get`. The `state.json` it replaced, and
`state.json.bak`, are kept byte for byte in
`archive/migrations/<time>-v3-to-v4-<sha256 prefix>/` with a `manifest.json` of sizes,
sha256 and counts. If the conversion fails, the daemon does not open state and writes
nothing. `orca gc --apply` performs the same conversion on a stopped state directory.

Do not downgrade: an Orca from before v4 treats a v4 file as a legacy format and starts
empty, keeping the file only as `state.json.v1.bak`.

`node scripts/state-lifecycle-proof.mjs` reproduces the upgrade, a gc run and a purge on a
synthetic state shaped like the 525 MB one measured on 2026-09-10, in a fresh temp
directory, and checks that no log line or agent event is lost.
