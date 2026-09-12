# A hostname change stranded the daemon — the instance lock could not be stopped, forced or replaced

**Found:** 2026-09-12, by the Claude orchestrator, against the owner's live daemon on this
machine. **Fixed on** `hardening/lock-machine-identity`.

## What happened

The daemon was started at 05:36. `os.hostname()` returned `Alexs-Mac-mini.local`, and
`src/instance-lock.js` wrote that string into `.orca/daemon.lock` as the identity of the machine
that took the lock.

Later the same day, on the same machine, `os.hostname()` returned **`Mac.lan`**. macOS changes
the hostname with the network. Nothing had moved and nothing had rebooted:

    $ scutil --get LocalHostName
    Alexs-Mac-mini
    $ scutil --get ComputerName
    Alex’s Mac mini
    $ node -e 'console.log(require("os").hostname())'
    Mac.lan

The daemon (pid 28411) was alive the whole time and still listening on 127.0.0.1:3000.

Because the recorded hostname no longer matched, `assessHolder` returned `other-host` — "its pid
cannot be checked from here" — for every command:

    [orca] Refusing to open this state directory: the lock was taken on another host
           (Alexs-Mac-mini.local); its pid cannot be checked from here.
    [orca] State directory: …/.orca
    [orca] No state was restored, migrated or recovered, and no process was signaled.
    [orca] If you are certain no Orca daemon uses this state directory, delete …/.orca/daemon.lock
           and start again.

## Confirmed by hand

- `orca-cli.js stop` refused with that message.
- **`orca-cli.js stop --force` refused with the identical message.** `--force` reached only the
  running-executor check (`refuseIfExecutorsRunning`); the lock refusal above it returned first,
  so the flag did nothing its name promises.
- `orca-cli.js start` refused too, so the daemon could be neither stopped nor replaced through
  its own CLI.
- `orca-cli.js status` printed the same refusal as its headline and, in `--json`, reported
  `"state": "unknown", "pid": null` — which reads as *nothing is running* while a daemon with 3
  projects, 11 orchestrators and 88 lanes was serving requests.
- The only way out was to signal the pid directly and move the lock file aside by hand: exactly
  the "delete the lock" advice the message gives, which is precisely the wrong advice when a
  daemon really is alive holding it.

### Reproduced in a temp state directory

Not re-created against the live daemon. A temp state directory, a live local process standing in
for the daemon, and a lock recording `hostname: "Alexs-Mac-mini.local"` while `os.hostname()`
says `Mac.lan` reproduces all four refusals verbatim, exit 1 each, plus the `status --json`
`state: "unknown", pid: null` above. That reproduction is now
`test/orca-cli-lock-force.test.js`, "THE INCIDENT, through the CLI".

## The guard was right; the identity was wrong

The lock exists because two daemons over one state directory destroy each other: startup runs
interrupted-lane recovery, and recovery SIGKILLs the process group a persisted lane points at
(the Stage 1 P1, `docs/audits/2026-09-10-hardening-scope/README.md`). A state directory can sit on
shared or network storage, where another machine's pid number is meaningless and
`process.kill(pid, 0)` is a false positive. Refusing to probe a pid the lock did not take **here**
is correct and stays.

`os.hostname()` is simply not "here". It is a label that follows the network.

## What the fix changes

**1. A stable machine identity — `src/machine-identity.js`.** The lock now records `machine`
(and `machineSource`) beside `hostname`, and compares only `machine`. Sources, first hit wins:

| source | what | why |
| --- | --- | --- |
| `ORCA_MACHINE_ID` | explicit override | tests, and an operator who knows better |
| `platform-uuid` | macOS `IOPlatformUUID` via `ioreg -rd1 -c IOPlatformExpertDevice` | hardware-derived; survives a network change, a rename and a reboot, and **cannot be shared by two machines** |
| `machine-id-file` | `/etc/machine-id`, then `/var/lib/dbus/machine-id` | per-installation on Linux |
| `orca-file` | a random UUID in `<config dir>/machine-id`, 0600, created once | portable last resort |
| `unavailable` | `null` | every source failed |

Chosen this way because the error directions are not symmetric: a **false match** is dangerous
(it lets a local pid probe answer a question about a remote daemon, and a wrong "the owner is
gone" puts two daemons on live state), while a false mismatch only refuses a command. So the two
sources that cannot be shared come first, and the file is last. The file lives in the **config**
directory, never in the state directory — the state directory is the thing that may be shared,
so an identity stored inside it would be shared by construction and would defeat the guard
entirely. (A config dir on a shared network home has the same hazard; that is why it is last.)

Failure never throws: `ioreg` missing, a timeout, an unwritable config dir or a relative
`ORCA_CONFIG_DIR` all degrade to `{ id: null, source: 'unavailable', error }`, and the lock then
falls back to comparing hostnames exactly as it did before — no worse than today, and it says so.

`hostname` is still recorded, and is now used only as a human-readable label in messages.

**2. Locks written by the old code.** They carry no `machine` field. Deleting or ignoring them
would strand anyone who upgrades while their daemon runs, so:

- **hostname still matches** → unchanged from before: the pid is checkable, and an exited owner
  is still taken over.
- **hostname no longer matches** (the incident) → the pid AND that pid's start time, to the
  second, are compared against the lock. Both matching is decisive enough to call it the owner,
  so the daemon is reported **running** and `stop` works normally. This can only ever produce a
  *refusal*, never a takeover, so a coincidence costs one `--force`, not a second daemon.
- **hostname no longer matches and the pid does not match** → refused as `legacy-other-host` and
  never taken over: a pid absent *here* is not proof it is absent *there*. `--force` resolves it.

Locks a different machine took (`machine` present and different) are refused as `other-machine`
and are **never** taken over, even when their pid happens to be absent locally. That is the Stage
1 guarantee, and it has its own tests.

The lock schema stays `orca.instance-lock.v1`. Bumping it would make a *new* lock unreadable to
an *older* Orca, which would strand a downgrade the same way this bug stranded an upgrade; an
older Orca reading a new lock compares hostnames, which is correct behaviour for that code.

**3. `--force` means force** (`forceResolveLock` in `src/cli-lifecycle.js`). On a lock the
inspector will not judge, `stop --force` now probes the pid on this machine and takes one of four
branches, naming the branch each time:

| what this machine can see | what `--force` does |
| --- | --- |
| pid alive, start time matches the lock (or the lock records no start and the pid is an Orca daemon) | SIGTERM it (or `launchctl bootout` under the service), wait for the release, report the pid |
| pid alive, start time does not match | **never signals it** — says what that pid is actually running, and clears the lock |
| pid absent here | clears the lock, says nothing was signaled |
| pid cannot be checked at all (no usable `ps`) | still refuses, names the machine the lock came from, and says why guessing would put two daemons on one state |

"Clears the lock" means **renames** it to `daemon.lock.cleared-<timestamp>`, never deletes it: if
the operator's `--force` was wrong, the evidence is still there.

**4. The advice fits the evidence.** `describeRefusal` no longer ends every refusal with "delete
the lock and start again". It appends one of three variants, chosen by what the recorded pid
looks like from here:

- *alive here and it is the owner* — "pid N IS running on this machine and started exactly when
  the lock records (…): it is this state directory's daemon, still alive. Do not delete the lock.
  Stop it with: `… stop --force`"
- *absent here* — "pid N is not running on this machine, so there is nothing here to signal. If
  `<state dir>` is on this machine's own disk, the lock is stale and safe to clear: `… stop
  --force`"
- *uncheckable, or the lock names another machine* — "pid N cannot be checked from here… If
  `<state dir>` is shared with `<host>`, stop the daemon there: `… stop`. If nothing runs there,
  clear the lock here: `… stop --force`"

(There is a fourth for an unreadable lock file, which has no pid to talk about: look at the file,
and note that a daemon starting right now finishes writing it in a moment.)

**5. `status` stops implying nothing runs.** The `unknown` state is now
**`unreachable-by-lock`**:

    Orca is unreachable-by-lock: pid 28411 owns <state dir> and this command cannot verify it.
    It is NOT known to be stopped.
      lock     the lock predates machine identity — …
               pid 28411 IS running on this machine and started exactly when the lock records …
               Stop it with: node …/orca-cli.js stop --force
      machine  this one is Mac.lan (C20DC899…C944, platform-uuid)

`status --json` gains a `lock` object — `reason`, `ownerPid`, `ownerHostname`, `ownerMachine`,
`ownerProcessStart`, `ownerListen`, `ownerPidOnThisMachine` (`alive` | `gone` | `unknown`),
`detail`, `remedy` — and a top-level `machine`. Exit code is still 1 (not 3, which means
stopped). `doctor` had the same lie in its state check ("no daemon owns it right now") and now
warns with the pid and the reason instead.

## Not fixed, noticed on the way

`probeProcess` reads a **zombie** as `alive`: `ps -p <pid> -o lstart=` still prints a start time
for an exited-but-unreaped child. Orca's daemon is detached and reparented to `init`, which reaps
it, so this does not affect the product — but it does affect test stand-ins, and it would matter
for any pid whose parent is a live process that never waits.
