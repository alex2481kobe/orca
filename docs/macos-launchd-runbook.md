# macOS launchd runbook

This runbook keeps Command Deck available after the terminal session that
started it exits. It is optional, but recommended for phone-first operation
when the Mac is expected to keep serving Command Deck over Tailscale.

The app still binds to `127.0.0.1` by default. Tailscale Serve should proxy to
that local port. Do not use public Funnel for v1.

## Security model

- Do not commit API tokens.
- Do not put API tokens in the launchd plist.
- Store secrets in a local env file with mode `600`.
- Keep the server bound to `127.0.0.1`.
- Keep Tailscale Serve tailnet-only.
- Use `npm run operator:status` after setup.

## 1. Create a local env file

```bash
cat > ~/.command-deck.env <<'EOF'
export COMMAND_DECK_API_TOKEN="replace-with-a-long-random-token"
export COMMAND_DECK_HOST="127.0.0.1"
export PORT="3000"
EOF

chmod 600 ~/.command-deck.env
```

Generate a token with:

```bash
openssl rand -hex 32
```

## 2. Create a local wrapper script

```bash
mkdir -p ~/.local/bin

cat > ~/.local/bin/command-deck-start <<'EOF'
#!/bin/zsh
set -euo pipefail

source "$HOME/.command-deck.env"
cd "$HOME/Documents/Projects/web/command-deck/command-deck-client"
exec npm run start
EOF

chmod 700 ~/.local/bin/command-deck-start
```

The wrapper is intentionally outside the repo so local paths and tokens do not
enter git.

## 3. Create the launchd plist

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/command-deck

cat > ~/Library/LaunchAgents/com.command-deck.local.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.command-deck.local</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/alexrodriguez/.local/bin/command-deck-start</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/alexrodriguez/Library/Logs/command-deck/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/alexrodriguez/Library/Logs/command-deck/stderr.log</string>

  <key>WorkingDirectory</key>
  <string>/Users/alexrodriguez/Documents/Projects/web/command-deck/command-deck-client</string>
</dict>
</plist>
EOF
```

If your home directory is different, update all `/Users/alexrodriguez/...`
paths before loading the plist.

## 4. Load and start

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.command-deck.local.plist
launchctl kickstart -k "gui/$(id -u)/com.command-deck.local"
```

Verify:

```bash
npm run operator:status
```

## 5. Pair a phone

```bash
source ~/.command-deck.env
cd ~/Documents/Projects/web/command-deck/command-deck-client
npm run operator:pair
```

Open the private URL from the phone:

```text
http://alexs-mac-mini.tailf87358.ts.net/
```

Pair with the one-time code. Do not put pairing codes in URLs, screenshots,
logs, docs, or issue comments.

## 6. Stop or unload

Stop the current service process:

```bash
launchctl kill TERM "gui/$(id -u)/com.command-deck.local"
```

Unload the LaunchAgent:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.command-deck.local.plist
```

Remove local launch files only after unloading:

```bash
rm ~/Library/LaunchAgents/com.command-deck.local.plist
rm ~/.local/bin/command-deck-start
```

Do not remove `~/.command-deck.env` unless you intend to rotate or delete the
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
