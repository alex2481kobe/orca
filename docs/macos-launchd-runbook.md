# macOS launchd runbook

This runbook keeps Orca available after the terminal session that
started it exits. It is optional, but recommended for phone-first operation
when the Mac is expected to keep serving Orca over Tailscale.

The app still binds to `127.0.0.1` by default. Tailscale Serve should proxy to
that local port. Do not use public Funnel for v1.

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

## 1. Create a local env file

```bash
cat > ~/.orca.env <<'EOF_ENV'
export ORCA_API_TOKEN="replace-with-a-long-random-token"
export ORCA_HOST="127.0.0.1"
export PORT="3000"
EOF_ENV

chmod 600 ~/.orca.env
```

Generate a token with:

```bash
openssl rand -hex 32
```

## 2. Create a local wrapper script

```bash
mkdir -p ~/.local/bin

cat > ~/.local/bin/orca-start <<'EOF_WRAPPER'
#!/bin/zsh
set -euo pipefail

source "$HOME/.orca.env"
cd "${ORCA_REPO:?set ORCA_REPO in the LaunchAgent environment}"
exec npm run start
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

## 4. Load and start

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.orca.local.plist
launchctl kickstart -k "gui/$(id -u)/com.orca.local"
```

Verify:

```bash
cd "$ORCA_REPO"
npm run operator:status
```

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

## 6. Stop or unload

Stop the current service process:

```bash
launchctl kill TERM "gui/$(id -u)/com.orca.local"
```

Unload the LaunchAgent:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.orca.local.plist
```

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
