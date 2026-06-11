# UI inventory and design contract

This document is the public-safe UI acceptance inventory for Orca.
It pairs with `npm run smoke:ui-inventory` and `npm run smoke:ui-contract`.

The UI target is a clean Codex-app-style operator surface:

- Full-height project rail for project/session navigation.
- Quiet top bar that aligns with the main work surface.
- Main chat/workflow surface for the active project, session, or lane.
- Optional right-panel/bottom-sheet pattern for advanced tools and evidence.
- Settings as the home for consolidated system, agent, supervisor, MCP, provider,
  access, and operations controls.
- No visible placeholder actions, no orphan buttons, no horizontal overflow,
  and no raw debug sections in default views.

## Required shared primitives

Every screen must be built from the shared shell/design primitives:

- `shell`: app top bar, project rail, main content surface.
- `navigation`: project rows, session rows, settings row, mobile rail toggle.
- `actions`: primary button, secondary button, danger button, icon button,
  action menu, disabled-with-reason state.
- `content`: route header, row list, card, panel, disclosure, empty state,
  loading state, error/forbidden state, success state.
- `forms`: field, select, textarea, checkbox/toggle, validation text,
  submit/loading/success/error states.
- `mobile`: 390px-safe layout, safe-area padding, bottom-sheet behavior,
  44px practical touch targets.

## Inventory fields required per screen

The smoke summary for each screen must include:

- Route or hash path.
- Purpose.
- Shared primitives used.
- Primary action.
- Secondary actions.
- Hidden or collapsed advanced actions.
- Loading state.
- Empty state.
- Error/forbidden state.
- Disabled states.
- Mobile behavior.
- Desktop screenshot path.
- 390px screenshot path.
- Horizontal overflow result.
- Dead-action scan result.
- Keyboard/focus and accessible-label scan result.

## Screen matrix

| Screen | Route | Purpose | Primary action | Hidden/collapsed advanced actions | Required primitives |
| --- | --- | --- | --- | --- | --- |
| `home` | `/` | Default operator overview and project navigation entry. | Open a project/session. | System details and advanced health state. | shell, rail, rows, disclosures |
| `projects` | `/#projects` | Project list management view. | Open project. | Reorder/archive actions through row controls or sheets. | shell, rail, rows, panels |
| `new-project` | `/#create` | Create a new project. | Create project. | Policy/approval details. | form, panel, validation |
| `settings` | `/#system` | Global settings and system health entry. | Review effective system state. | Raw diagnostics, token/session details, CLI internals. | settings panel, disclosures, forms |
| `agents` | `/#agents` | Agent CLI, executor profile, and evidence capture setup. | Review agent readiness. | Managed install/reinstall plans and capture backend details. | rows, disclosures, forms |
| `providers` | `/#providers` | Provider catalog and health. | Check or configure provider. | CLI install/update dry-run details and raw profile data. | cards, disclosures, forms |
| `secrets` | `/#providers` | Provider secret setup surface. | Set/delete provider secret reference. | Backend-specific details and env fallback notes. | form, danger action, redaction state |
| `supervisor` | `/#supervisor` | Cross-project supervisor control and MCP bootstrap. | Generate supervisor MCP config. | Per-session backlog/review details and bootstrap snippets. | rows, badges, disclosures |
| `mcp-tools` | `/#mcp` | Desktop MCP bridge and custom tool management. | Generate config or create tool. | Raw tool config and scope internals. | form, rows, disclosures |
| `access` | `/#access` | Tailscale, pairing, and token access setup. | Create pairing code or configure private access. | Serve commands, token fallback, and paired-device details. | panels, command blocks, disclosures |
| `operations` | `/#operations` | Notifications, cleanup, backup, archive, and effective policy. | Review operational settings. | Destructive cleanup/import confirmations and raw resolved policy. | forms, disclosures, danger action, code block |
| `project-detail` | `/projects/:slug` | Project details, quick links, and sessions. | Open/create session. | Quick-link maintenance and operations panel. | project shell, rows, right panel |
| `session-workflow` | `/projects/:slug/sessions/:id` | Active session workflow, orchestrator chat, and lanes. | Send orchestrator message or create/open lane. | Capacity policy, critique/audit internals, raw lane metadata. | orchestrator console, work surface, lane rows, forms |
| `lane-detail` | `/projects/:slug/sessions/:id/lanes/:id` | Lane status, logs, evidence, and audit handoff. | Run next safe lane action. | Process metadata, MCP config path, logs, artifacts. | lane panel, evidence panel, disclosures |

## Smoke gates

Run these before accepting UI work:

```sh
npm run smoke:ui
npm run smoke:ui-inventory
npm run smoke:ui-contract
```

`smoke:ui-inventory` must produce desktop and 390px screenshots under
`artifacts/ui-inventory/` and a structured `inventory-summary.json`.

`smoke:ui-contract` must produce route screenshots under
`artifacts/ui-contract/` and fail on shared-shell violations, dead visible
actions, horizontal overflow, default-open advanced sections, and missing
accessible labels for icon-only controls.
