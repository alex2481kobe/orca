# UI inventory and design contract

This document is the public-safe UI acceptance inventory for Command Deck.
It pairs with `npm run smoke:ui-inventory` and `npm run smoke:ui-contract`.

The UI target is a clean Codex-app-style operator surface:

- Full-height project rail for project/session navigation.
- Quiet top bar that aligns with the main work surface.
- Main chat/workflow surface for the active project, session, or lane.
- Optional right-panel/bottom-sheet pattern for advanced tools and evidence.
- Settings as the home for advanced system, provider, private-access, cleanup,
  and diagnostic controls.
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
| `providers` | `/#providers` | Provider catalog and health. | Check or configure provider. | CLI install/update dry-run details and raw profile data. | cards, disclosures, forms |
| `secrets` | `/#providers` | Provider secret setup surface. | Set/delete provider secret reference. | Backend-specific details and env fallback notes. | form, danger action, redaction state |
| `mcp-tools` | `/#mcp` | MCP tool management. | Create or edit tool. | Raw tool config and scope internals. | form, rows, disclosures |
| `audit-queue` | `/#audit` | Audit queue and review actions. | Open or acknowledge audit. | Raw audit metadata/export. | rows, badges, disclosures |
| `private-access` | `/#private-access` | Tailscale/private mobile access setup. | Copy/check dry-run setup command. | Fake provider state, Serve internals, setup diagnostics. | panels, command blocks, disclosures |
| `cleanup` | `/#cleanup` | Artifact cleanup and schedule controls. | Run cleanup dry-run. | Destructive cleanup confirmation and schedule internals. | danger action, forms, disclosures |
| `notifications` | `/#notifications` | In-app and browser notification settings plus unread status. | Mark notification read. | Browser permission state and delivery threshold controls. | rows, forms, badges, disclosures |
| `project-detail` | `/projects/:slug` | Project details, quick links, and sessions. | Open/create session. | Quick-link maintenance and operations panel. | project shell, rows, right panel |
| `session-workflow` | `/projects/:slug/sessions/:id` | Active session workflow and lanes. | Create/open lane. | Capacity policy, critique/audit internals, raw lane metadata. | work surface, lane rows, forms |
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
