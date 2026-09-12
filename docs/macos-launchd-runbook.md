# Keeping Orca running: a macOS LaunchAgent (and Linux systemd --user)

`node src/orca-cli.js start` already runs Orca detached from the terminal or
agent session that started it, so ending that session does not stop Orca. A
per-user service adds two things: Orca starts when you log in, and it comes back
after a crash. It is optional, but recommended for phone-first operation when
the Mac should keep serving Orca over Tailscale.

A LaunchAgent is a per-user service. launchd starts it when you log in and
stops it when you log out. It does not run before login. The daemon still binds
to `127.0.0.1`; Tailscale Serve proxies to that port. Never use public Funnel.

## Security model

- No secret ever goes in the plist. `service install` writes none; with
  `--token-file` the plist names an owner-only file that holds the API token.
- Keep the token file owner-only (`chmod 600`). Orca refuses to start if the
  file is missing, empty, or readable by group or others, rather than running
  without a token.
- Keep the server bound to `127.0.0.1`, and Tailscale Serve tailnet-only.
- Use `npm run operator:status` after setting up remote access.

## 1. Before you install

Run `setup` first: it records the directories agents may work in, and prints
the state directory Orca uses.

```bash
cd /absolute/path/to/orca
node src/orca-cli.js setup --roots "$HOME/code" --no-start
node src/orca-cli.js status
```

For an API token (recommended; required before you pair a phone):

```bash
(umask 077; openssl rand -hex 32 > ~/.config/orca/api-token)
```

## 2. Install

```bash
node src/orca-cli.js service install --dry-run                                # print it; write nothing
node src/orca-cli.js service install --token-file ~/.config/orca/api-token    # write it and load it
```

Leave out `--token-file` to run without a token (every local process is then
Orca admin). `service install` writes `~/Library/LaunchAgents/com.orca.local.plist`
and loads it with `launchctl bootstrap gui/$(id -u) …`. The plist:

- runs Node by absolute path with `src/server.js`: no npm, and no PATH lookup
  for node. It uses the Node you run the command with; choose a stable one with
  `--node /opt/homebrew/bin/node`. A version manager's per-version path stops
  existing when you remove that version, and the service then fails to start.
- pins `ORCA_STATE_DIR` and `ORCA_CONFIG_DIR` to the directories `status`
  shows, plus `PORT` and `ORCA_HOST` (`--port` to change it).
- copies your current `PATH`, because Orca launches the agent CLIs (`codex`,
  `claude`) by name and launchd never reads your shell profile. Run it from a
  shell where `command -v codex claude` works, or point Orca at a CLI with
  `ORCA_CODEX_BINARY` / `ORCA_CLAUDE_BINARY`.
- sets `RunAtLoad`, and `KeepAlive` with `SuccessfulExit` false: launchd starts
  Orca at login and restarts it when it crashes (at most every 10 seconds,
  `ThrottleInterval`), but not after a clean stop.
- sends stdout and stderr to `<state dir>/logs/daemon.log`
  (`node src/orca-cli.js logs`).

If Orca is already running outside the service, `install` writes the plist but
does not load it: launchd's start would be refused while that daemon owns the
state. When no executors are running, run `stop`, then `start`. With the service
installed, `start` loads it instead of spawning a daemon beside it.

## 3. Day to day

```bash
node src/orca-cli.js status     # service installed and loaded? pid, URL, state, fence
node src/orca-cli.js stop       # unloads the job, so KeepAlive cannot restart it
node src/orca-cli.js start      # loads it again
node src/orca-cli.js logs
```

**Stopping Orca stops its executors.** On `SIGTERM` Orca stops its scheduler,
kills every running executor process and flushes its state before it exits.
Nothing resumes that work when Orca comes back, so `stop` refuses while any
executor is running unless you pass `--force`.

Killing the process is not a stop: launchd restarts a crashed Orca. To restart
in place, `launchctl kickstart -k "gui/$(id -u)/com.orca.local"`.

## 4. Pair a phone

```bash
cd /absolute/path/to/orca
ORCA_API_TOKEN="$(cat ~/.config/orca/api-token)" npm run operator:pair
```

Open the private Tailscale Serve URL from the phone (`tailscale serve status`)
and pair with the one-time code. Do not put pairing codes in URLs, screenshots,
logs, docs, or issue comments.

## 5. Uninstall

```bash
node src/orca-cli.js service uninstall
```

It unloads the job (stopping Orca, and refusing while executors run unless
`--force`) and removes the plist. Orca's state and config are left alone.
`install` and `uninstall` leave a `com.orca.local` plist they did not generate
(one written by hand from an older version of this runbook) untouched unless you
pass `--replace` or `--force`.

## One daemon, and the instance lock

One daemon serves the machine. It holds an exclusive lock on its state directory
(`<state dir>/daemon.lock`), taken before it binds the port or reads any state.
A second start against that state (a terminal `npm start`, or launchd while a
terminal daemon runs) exits 1, names the owner's pid and URL, and changes no
state and signals no process. Under launchd that refusal repeats every 10
seconds until the other daemon stops, and each refusal is written to the log.
`orca-cli.js start` checks first, and reports a running daemon instead.

A daemon that could not clean up (`kill -9`, a power loss) leaves its lock
behind. The next start takes it over when the owner's pid no longer exists, or
now belongs to a process that started at a different time.

A pid can only be checked in the kernel that issued it, and a state directory can
sit on shared storage, so the lock also records **which machine took it** — the
macOS platform UUID (`ioreg -rd1 -c IOPlatformExpertDevice`, `IOPlatformUUID`),
`/etc/machine-id` on Linux, else a UUID file in the Orca config dir. It records
the hostname too, but only as a label. `os.hostname()` follows the network on
macOS: the same Mac answers `Alexs-Mac-mini.local` on one network and `Mac.lan`
on the next, and a lock keyed on it stranded a live daemon
(`docs/audits/2026-09-12-hostname-strands-the-daemon.md`).

When Orca cannot prove the owner is gone — the lock cannot be read, it was taken
on another machine, this machine's own identity cannot be determined, or the
owner's start time cannot be checked — the start is refused, and the refusal says
what **this** machine can see about the recorded pid:

- **the pid is alive here and matches the lock** — that is the daemon, still
  running. Stop it: `node src/orca-cli.js stop --force`.
- **the pid is absent here** — nothing to signal; `stop --force` clears the lock
  (it renames it to `daemon.lock.cleared-<timestamp>` rather than deleting it).
- **the pid cannot be checked at all** — Orca says so and names the machine the
  lock came from; run `stop` there. `--force` refuses in this case, because
  clearing a live remote daemon's lock is how two daemons end up on one state.

`stop --force` also covers the pid-was-reused case: it never signals a process
whose start time does not match the lock, it says what that pid is actually
running, and it clears the lock instead.

`orca-cli.js status` reports a lock it cannot verify as **unreachable-by-lock**,
with the owner's pid and whether that pid is alive on this machine — it never
reports such a state directory as stopped.

## An install from before the per-user state directory

Orca used to keep its state in `<checkout>/.orca`. It keeps using that directory
in place (`status` shows "the checkout's existing .orca, kept in place"), and
`setup` records it in the config, so the service pins the same directory.
Nothing is moved or copied. To move it later: stop Orca, move the directory, and
run `setup --roots … --state-dir <new absolute path>`.

## Tailscale Serve reminder

HTTP over Tailscale:

```bash
tailscale serve --bg --http=80 localhost:3000
```

Verify tailnet-only Serve and no public Funnel:

```bash
tailscale serve status
tailscale funnel status
npm run operator:status
```

Disable Serve if needed:

```bash
tailscale serve --http=80 off
```

## Linux: systemd --user

`service install` manages macOS only. On Linux the equivalent is a user unit.
This is documented, not yet validated in this repo's CI.

```ini
# ~/.config/systemd/user/orca.service
[Unit]
Description=Orca daemon

[Service]
ExecStart=/usr/bin/node /absolute/path/to/orca/src/server.js
WorkingDirectory=/absolute/path/to/orca
Environment=ORCA_STATE_DIR=%h/.local/state/orca
Environment=ORCA_CONFIG_DIR=%h/.config/orca
Environment=ORCA_API_TOKEN_FILE=%h/.config/orca/api-token
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=10
StandardOutput=append:%h/.local/state/orca/logs/daemon.log
StandardError=append:%h/.local/state/orca/logs/daemon.log

[Install]
WantedBy=default.target
```

```bash
mkdir -p ~/.local/state/orca/logs
systemctl --user daemon-reload
systemctl --user enable --now orca     # start now, and at every login
loginctl enable-linger "$USER"         # optional: keep it running after logout
systemctl --user stop orca             # stop it
```

Drop the `ORCA_API_TOKEN_FILE` line to run without a token. `orca-cli.js
status`, `stop` and `logs` work the same way: `stop` signals the daemon the lock
names, it exits cleanly, and `Restart=on-failure` leaves it stopped.
