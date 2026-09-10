# macOS launchd runbook

This runbook keeps Orca available after the terminal session that
started it exits. It is optional, but recommended for phone-first operation
when the Mac is expected to keep serving Orca over Tailscale.

The daemon still binds to `127.0.0.1` by default. Tailscale Serve should proxy to
that local port. Do not use public Funnel.

A LaunchAgent is a per-user service: launchd starts it when you log in and stops
it when you log out. It does not run before login. With `KeepAlive` (section 3)
launchd also starts Orca again whenever the process exits — which is why
stopping it means unloading it (section 6), not killing it.

## Security model

- Do not commit API tokens.
- Do not put API tokens in the launchd plist.
- Store secrets in a local env file with mode `600`.
- Keep the server bound to `127.0.0.1`.
- Keep Tailscale Serve tailnet-only.
- Use `npm run operator:status` after setup.

## Assumptions

Set the repo path for your machine:

```bash
export ORCA_REPO="$HOME/orca"  # path to your cloned repo
```

If your checkout lives elsewhere, use that absolute path instead.

## 0. Before you start: one daemon per working directory

Orca keeps its state in `.orca/` under the daemon's working directory — here,
`$ORCA_REPO`. A running daemon holds an exclusive lock on that directory
(`.orca/daemon.lock`), and every start takes the lock before it binds the port or
reads any state. A second start against the directory while a daemon owns it is
refused: it exits with code 1, prints the owner's pid and URL, and changes no
state and signals no process.

Under the LaunchAgent that refusal repeats. The plist in section 3 sets
`KeepAlive` to `true`, which starts Orca again whenever it exits, for any reason,
so exit code 1 does not stop it. If you load the LaunchAgent while a daemon
started from a terminal owns `$ORCA_REPO`, launchd's start is refused and exits,
launchd starts it again, and each start is refused the same way, each refusal
written to `~/Library/Logs/orca/stderr.log`. No state is touched. It ends when
you unload the job (section 6), or when the terminal daemon stops: that daemon
gives up the lock as the last step of its shutdown, so the next start launchd
makes takes the lock and serves Orca from then on. Stopping the terminal daemon
still stops its executors (section 6).

A daemon that could not clean up (`kill -9`, a power loss) leaves its lock
behind. The next start takes it over when the owner's pid no longer exists, or
now belongs to a process that started at a different time. When Orca cannot
prove the owner is gone — the lock cannot be read, it was written under a
different hostname (for example, the Mac's hostname has changed since), or the
owner's start time cannot be checked — the start is refused and names the file
to delete. Under `KeepAlive` that refusal also repeats, until you confirm that no
Orca daemon uses `$ORCA_REPO` and delete the file it names.

So check before you load the LaunchAgent, and before any manual start:

```bash
curl -s http://127.0.0.1:3000/api/health     # answers if a daemon is up
lsof -nP -iTCP:3000 -sTCP:LISTEN              # which process holds the port
launchctl print "gui/$(id -u)/com.orca.local" 2>/dev/null | grep -E '^[[:space:]]*(state|pid) ='
```

If a daemon started from a terminal answers, stop it with `Ctrl-C` in that
terminal first. Once the LaunchAgent is loaded, do not also run `npm start` or
`npm run dev` from `$ORCA_REPO`: it is refused and exits 1.

## 1. Create a local env file

```bash
cat > ~/.orca.env <<'EOF_ENV'
export ORCA_API_TOKEN="replace-with-a-long-random-token"
export ORCA_HOST="127.0.0.1"
export PORT="3000"
# Where agents may register and work: comma-separated absolute paths. Orca always
# adds its own working directory as well. Unset, your whole home directory is
# allowed (and the server warns at startup).
export ORCA_REPO_ROOTS="$HOME/code"
# launchd starts jobs with a minimal PATH and never reads your shell profile.
# Orca launches the executor CLIs (codex, claude, gemini, cursor-agent) by name,
# so the directories holding them must be on this PATH. Run `command -v codex claude`
# in your normal shell to see where yours are.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
EOF_ENV

chmod 600 ~/.orca.env
```

Generate a token with:

```bash
openssl rand -hex 32
```

Instead of relying on `PATH`, you can point Orca at a CLI directly, for example
`export ORCA_CODEX_BINARY="/absolute/path/to/codex"` or `ORCA_CLAUDE_BINARY`.

## 2. Create a local wrapper script

launchd cannot find `node` or `npm` on your interactive `PATH`, so the wrapper
runs Node by absolute path — the same `node src/server.js` that `npm start` runs,
without npm. Record the path now. Prefer a stable one, such as Homebrew's
`/opt/homebrew/bin/node`: a version manager's per-version path stops existing
when you switch to or remove that version, and the service will then fail to
start.

```bash
mkdir -p ~/.local/bin

ORCA_NODE="$(command -v node)"
echo "$ORCA_NODE"   # check this is the Node you want the service to use (18.18+)

cat > ~/.local/bin/orca-start <<EOF_WRAPPER
#!/bin/zsh
set -euo pipefail

source "\$HOME/.orca.env"
cd "\${ORCA_REPO:?set ORCA_REPO in the LaunchAgent environment}"
exec "$ORCA_NODE" src/server.js
EOF_WRAPPER

chmod 700 ~/.local/bin/orca-start
```

The wrapper is intentionally outside the repo so local secrets do not enter
git.

## 3. Create the launchd plist

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/orca

cat > ~/Library/LaunchAgents/com.orca.local.plist <<EOF_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.orca.local</string>

  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.local/bin/orca-start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>ORCA_REPO</key>
    <string>$ORCA_REPO</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/orca/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/orca/stderr.log</string>

  <key>WorkingDirectory</key>
  <string>$ORCA_REPO</string>
</dict>
</plist>
EOF_PLIST
```

The generated plist contains local absolute paths because launchd requires
them. The plist remains secret-free because the API token stays in
`~/.orca.env`.

`RunAtLoad` starts Orca as soon as the job is loaded. `KeepAlive` starts it again
whenever it exits, for any reason — including when you kill it.

## 4. Load and start

Run the section 0 checks first. Then:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.orca.local.plist
```

Verify:

```bash
curl -s http://127.0.0.1:3000/api/health
launchctl print "gui/$(id -u)/com.orca.local" | grep -E '^[[:space:]]*(state|pid) ='
tail -n 20 ~/Library/Logs/orca/stderr.log
```

Once Tailscale Serve is set up (section 7), also run:

```bash
cd "$ORCA_REPO"
npm run operator:status
```

`operator:status` checks Tailscale Serve as well as Orca, so it reports failures
until Serve is configured, even when Orca itself is healthy.

## 5. Pair a phone

```bash
source ~/.orca.env
cd "$ORCA_REPO"
npm run operator:pair
```

Open the private Tailscale Serve URL from the phone. Use the URL reported by:

```bash
tailscale serve status
```

Pair with the one-time code. Do not put pairing codes in URLs, screenshots,
logs, docs, or issue comments.

## 6. Stop, restart, or unload

**Stopping Orca stops its executors.** On `SIGTERM` Orca stops its scheduler,
kills every running executor process, and flushes its state before it exits.
Nothing resumes that work when Orca comes back, so check the dashboard for
running lanes before you stop or restart.

**Stop, and stay stopped** — unload the job. Because of `KeepAlive`, this is the
only way to stop it; killing the process just makes launchd start a new one.

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.orca.local.plist
```

**Start again** later with `launchctl bootstrap …` (section 4).

**Restart in place:**

```bash
launchctl kickstart -k "gui/$(id -u)/com.orca.local"
```

`launchctl kill TERM "gui/$(id -u)/com.orca.local"` is also a restart, not a
stop: Orca exits and launchd relaunches it.

Remove local launch files only after unloading:

```bash
rm ~/Library/LaunchAgents/com.orca.local.plist
rm ~/.local/bin/orca-start
```

Do not remove `~/.orca.env` unless you intend to rotate or delete the
local API token.

## 7. Tailscale Serve reminder

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
