# Mobile Access via Tailscale Serve

Goal: expose Command Deck privately so phone control stays inside your tailnet.

1. Install and authenticate Tailscale on the Command Deck host.
2. Start Command Deck locally with `npm run dev` (default `localhost:3000`).
3. Configure private Tailscale Serve access for this host and port (keep Funnel off for v1).
4. Optional: set `COMMAND_DECK_API_TOKEN` for mutating endpoints and configure it in the dashboard home “API token” control (or pass `?apiToken=...` one-time in a URL for mobile bootstrapping).
5. Verify dashboard and API routes from a phone on the same tailnet:
   - `https://<mac-tailnet-host>.<tailnet>.ts.net/`
   - `https://<mac-tailnet-host>.<tailnet>.ts.net/projects/realm-shaper`
   - `https://<mac-tailnet-host>.<tailnet>.ts.net/api/mobile/manifest`
6. Use lane URLs from the manifest for focused operations:
   - `.../projects/:slug/sessions/:sessionId/lanes/:laneId`
   - lane artifact and evidence APIs:
     - `/api/lanes/:laneId/artifacts`
     - `/api/lanes/:laneId/evidence`
     - `/api/lanes/:laneId/evidence/latest`
     - `/api/lanes/:laneId/evidence/clear`
   - maintenance:
     - `/api/artifacts/cleanup`
7. Keep high-risk actions approval-gated and logged before remote execution.
