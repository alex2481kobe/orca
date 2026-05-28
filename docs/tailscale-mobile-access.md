# Tonight Runbook: Command Deck on Mac + Phone via Tailscale Serve

Goal: bring Command Deck up locally on the Mac and use it from a phone over
private Tailscale Serve. No public Funnel.

## 0. Prereqs (once)

- Tailscale installed and signed in on both the Mac and the phone, both on the
  same tailnet, MagicDNS on.
- Node 18.18+ installed on the Mac.
- This repo cloned to `command-deck-client/`.

## 1. Generate a strong API token

```bash
export COMMAND_DECK_API_TOKEN="$(openssl rand -hex 32)"
# Optional: a separate worker token for heartbeat callers.
export COMMAND_DECK_WORKER_TOKEN="$(openssl rand -hex 32)"
```

Keep the token in a password manager or in `~/.command-deck.env` (chmod 600).
Do not paste it into chat, screenshots, or commit it.

## 2. Start the server (binds locally by default)

```bash
cd command-deck-client
PORT=3000 COMMAND_DECK_HOST=127.0.0.1 \
  COMMAND_DECK_API_TOKEN=$COMMAND_DECK_API_TOKEN \
  npm run dev
```

The server binds to `127.0.0.1`. The dashboard is at <http://127.0.0.1:3000/>.

If you want stricter per-binary, per-workdir, or per-env settings, set
`COMMAND_DECK_CODEX_BINARY`, `COMMAND_DECK_CODEX_WORKDIR_ROOTS`,
`COMMAND_DECK_REPO_ROOTS` (comma-separated absolute paths used to validate
lane workdirs), etc. before `npm run dev`.

## 3. Smoke the API + UI from the Mac

```bash
COMMAND_DECK_API_TOKEN=$COMMAND_DECK_API_TOKEN \
  COMMAND_DECK_BASE_URL=http://127.0.0.1:3000 \
  npm run smoke
```

This walks the full operator flow: health, policy, mobile manifest, project /
session / lane creation, mock lane completion, MCP tool CRUD + Codex lane
attachment, evidence capture (degraded if Playwright is missing), audit queue
and acknowledgement, cleanup dry-run. Exit code `0` means tonight is good.

## 4. Expose privately through Tailscale Serve

```bash
# Serve the local Command Deck origin to the tailnet. HTTPS only.
tailscale serve --bg --tls-terminated-tcp=443 http://127.0.0.1:3000

# Verify what's published.
tailscale serve status
```

Expected output: one entry mapping `https://<your-mac>.<tailnet>.ts.net/` to
`http://127.0.0.1:3000`. Funnel must be OFF (`tailscale funnel status` should
print "no Funnel"). If it shows a Funnel entry, run
`tailscale funnel off` immediately.

## 5. Verify from the phone (on the same tailnet)

Open the following in mobile Safari/Chrome:

1. `https://<your-mac>.<tailnet>.ts.net/` — dashboard loads. Set the API token
   in the dashboard token field (or use `?apiToken=...` once to bootstrap).
2. `https://<your-mac>.<tailnet>.ts.net/api/health` — JSON `{ "status": "ok" }`.
3. `https://<your-mac>.<tailnet>.ts.net/api/mobile/manifest` — JSON containing
   `apiTokenRequired: true`, all your projects, lanes, and the full set of
   action URLs the dashboard uses.

If any of these fail, walk the steps above before mutating anything from the
phone.

## 6. Operating from the phone

- Use the project list to navigate sessions and lanes.
- Lane detail shows live logs, PID/exit metadata (for real lanes), and the
  attached MCP tools.
- Use the evidence panel to capture screenshots/traces/videos. Without
  Playwright installed the capture is recorded as degraded — see
  "Playwright" below.
- Approve high-risk actions explicitly. Stops, cleanups, reinstalls, and MCP
  changes all require an explicit `approved: true` (or the in-UI button).

## 7. Playwright (optional)

Command Deck never installs Playwright automatically — browser binaries are a
large privileged install. If you want true screenshot/trace/video capture:

```bash
cd command-deck-client
npm install --no-save playwright
npx playwright install --with-deps chromium
```

You must approve these commands yourself. After installing, restart the
server and the next evidence capture will run a real browser. Without
Playwright, evidence captures return `captured: false` and the dashboard
shows a clearly degraded state — actions never silently succeed.

## 8. Shutdown

- `Ctrl-C` the `npm run dev` process.
- `tailscale serve --bg http://127.0.0.1:3000 off` (or
  `tailscale serve reset`) to take the URL down when you are done.

## 9. Things that must stay off

- Public Tailscale Funnel.
- Auto-seed of demo data (set `COMMAND_DECK_SEED=1` only if you want a
  starter Realm Shaper project).
- Sweep destructive commands. Cleanup defaults to dry-run; live deletion
  requires `confirmed: true` plus approval.
- Hand-edited tokens in shell history; prefer `read -s`.
