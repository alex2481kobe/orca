# Route-by-route audit

The canonical route inventory is now code-backed:

- Source: `src/route-inventory.js`
- Read-only API: `GET /api/route-inventory`
- Smoke gate: `npm run smoke:route-inventory`

The inventory is public-safe and intentionally does not include local paths,
usernames, token values, secret values, internal prompts, or private planning
notes.

Every route entry must declare:

- `method`
- `route`
- `group`
- `owner`
- `auth`
- `mutationRisk`
- `approval`
- `validation`
- `auditEvent`
- `bodyLimit`
- `rateLimit`
- `uiSurface`
- `smokeCoverage`
- `mobileBehavior`
- `serverHints`

## Enforcement rules

- Every mutating route must declare non-`none` auth.
- Every mutating route must declare request body limits and validation.
- High-risk, critical, and high-frequency routes must declare approval or an
  equivalent policy gate.
- High-risk and critical routes must declare an audit event. The heartbeat
  route is the only high-frequency exception and must declare that exception
  explicitly.
- Every route must reference at least one test or smoke gate.
- Every route must include server/source hints that `smoke:route-inventory`
  can verify against the current source tree.
- The inventory must not leak local machine paths, API tokens, worker tokens,
  provider secrets, or credential values.

## Current route groups

Run:

```sh
npm run smoke:route-inventory
```

The smoke prints the current group counts. As of this audit, the inventory
covers these route groups:

- `agent-tools`
- `audit`
- `auth`
- `capacity`
- `cleanup`
- `critique`
- `evidence`
- `executors`
- `lanes`
- `mcp`
- `mobile`
- `private-access`
- `projects`
- `providers`
- `pwa`
- `sessions`
- `static-app`
- `static-artifacts`
- `system`

## Global route behavior

- `COMMAND_DECK_MAX_JSON_BYTES` controls JSON body size. Oversize requests
  return `413`; malformed JSON returns `400`.
- Non-GET dashboard/API mutations are protected by the API token or a paired
  browser session when `COMMAND_DECK_API_TOKEN` is configured.
- Browser-session mutations require same-origin protection.
- Dashboard requests may not spoof reserved actors: `scheduler`, `system`,
  `cron`, or `worker`.
- Secrets must never be returned from provider, export, route-inventory,
  mobile-manifest, audit, log, artifact, or smoke endpoints.
- Static PWA caching is limited to static assets. API, artifact, evidence, log,
  and token-bearing URLs must not be cached.

## Adding or changing routes

When adding or changing a route:

- Update `src/route-inventory.js` in the same commit.
- Add or update tests/smokes referenced by `smokeCoverage`.
- Add server/source hints that fail if the route disappears or moves without
  updating the inventory.
- Run `npm run smoke:route-inventory`.
- Run the specific test/smoke covering the route behavior.
