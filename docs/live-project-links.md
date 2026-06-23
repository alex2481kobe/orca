# Live project links

Live project links are saved project URLs for dev servers, previews, docs,
artifacts, or dashboard-relative pages. They are server-authoritative: agents
and the dashboard should write them through Orca instead of relying on
chat history.

Saved project links also feed lane evidence presets. Normal dashboard evidence
capture submits a preset id, and the server resolves that id back to a saved
link before running URL policy and Playwright capture.

## Why this exists

When an executor starts a project server, the user needs a stable place to click
the current link later from desktop, phone, or a future desktop app. For
example, Example App on Vite port 5173 should be saved once as a project live
link, then health-checked by the server.

## Data shape

Each link is normalized by the server:

```json
{
  "id": "generated-or-stable-id",
  "label": "Example App",
  "url": "http://localhost:5173/",
  "localUrl": "http://127.0.0.1:5173/",
  "tailnetHttpUrl": "http://device.tailnet.ts.net:5173/",
  "httpsServeUrl": "https://device.tailnet.ts.net/",
  "port": 5173,
  "kind": "vite",
  "favorite": true,
  "hidden": false,
  "healthStatus": "configured_unchecked"
}
```

Supported `kind` values are `dev-server`, `vite`, `preview`, `dashboard`,
`artifact`, `docs`, and `other`.

## Routes and tools

- Dashboard/API create: `POST /api/projects/{projectId}/quick-links`
- Dashboard/API update: `PATCH /api/projects/{projectId}/quick-links/{linkId}`
- Dashboard/API delete: `DELETE /api/projects/{projectId}/quick-links/{linkId}`
- Dashboard/API check: `POST /api/projects/{projectId}/quick-links/{linkId}/check`
- Agent tool create/update: `project.quick_link.upsert`
- Agent tool delete: `project.quick_link.delete`
- Agent tool check: `project.quick_link.health`

Writes require project-update approval. Health checks only check a saved link;
they do not accept arbitrary probe URLs.

For shell-capable agents and MCP-hosting apps, `orca-agent` exposes the common
workflow without raw route memorization:

```bash
orca-agent projects
orca-agent links <projectId>
orca-agent link-upsert <projectId> "Example App" "http://127.0.0.1:5173" \
  --tailnet "http://mac.tailnet.ts.net:5173" --port 5173 --kind vite --favorite --check
orca-agent link-tailnet <projectId> "Example App" "http://127.0.0.1:5173" \
  --port 5173 --kind vite --favorite --check --prefer local
orca-agent link-check <projectId> <linkId> --prefer tailnet
```

When the user wants to open a project from a phone or another tailnet device,
pass `--prefer tailnet` (or MCP body `{ "prefer": "tailnet" }`) for the health
check. The default `auto` preference checks the primary `url`, which is often
the local loopback URL on the workstation.

`link-tailnet` is the easiest agent path when Tailscale is already logged in: it
reads the current read-only Tailscale hostname, derives a direct private
tailnet URL from the local app URL and port, then saves both `localUrl` and
`tailnetHttpUrl` through the same server-side quick-link contract. It does not
enable Serve or bypass project-link approval/scope checks.

Use `orca-agent tailscale-status` and `orca-agent tailscale-setup` to inspect the
private-access setup from a CLI agent. Enabling or disabling Tailscale Serve is a
workstation/admin operation (`orca-agent tailscale-serve enable|disable`), not a
scoped project-link tool.

## Evidence presets

For a lane attached to a project, the server exposes
`GET /api/lanes/{laneId}/evidence/presets`. Presets are derived from:

- the lane target URL, when set
- saved project quick links with absolute HTTP(S) URLs

The dashboard posts `presetId` to `POST /api/lanes/{laneId}/evidence`. The
server chooses the URL from the saved preset list. A request that includes both
`presetId` and `url` is rejected so the client cannot silently override the
server-resolved target.

## Security model

- Saved URLs are validated with the same SSRF policy used by evidence capture.
- Loopback, localhost, configured tailnet hosts, and public HTTP(S) URLs are
  accepted where policy allows them.
- Metadata, link-local, private LAN, multicast, obfuscated numeric IPs,
  credential-bearing URLs, sensitive Orca routes, and Funnel URLs are
  blocked.
- Unpaired devices cannot list projects, read live links, check links, or mutate
  links. Pairing creates a revocable browser session; it does not reveal the API
  token.

## Desktop/Tauri direction

The future Tauri app should launch the local Orca server, wait for
health, open the dashboard, and surface saved live links in its menu or project
view. A stopped server cannot be started through its own MCP/API routes, so
startup belongs to the native Tauri host, a user-run CLI command, or an OS
supervisor.

See `docs/preview-surfaces.md` for the broader preview target model covering
desktop browser, mobile browser emulation, artifacts, and future native
simulator adapters.
