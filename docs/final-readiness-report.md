# Final readiness report

This report records the current full-buildout evidence for Command Deck. It is
public-safe: it does not include API tokens, pairing codes, provider secrets,
local private prompts, machine-specific Tailscale hostnames, or raw credential
values.

## Status

- Local product buildout: ready by current automated evidence.
- Private Tailscale Serve: implemented and locally verifiable with
  `npm run operator:status` when configured on a host.
- Real phone reachability: requires user-device confirmation.
- Native Tauri/iOS/Android packaging: initial Tauri v2 scaffold exists; signed
  production packaging and native mobile adapters remain later product phases.

Do not mark the overall project goal complete until real phone access is
confirmed from the user's phone or the user explicitly accepts that final
manual check as external.

## Live setup shape

- Local backend: `http://127.0.0.1:3000`
- Private Tailscale URL: host-specific; read it from `tailscale serve status`.
- Tailscale Serve mode: HTTP over Tailscale, tailnet-only.
- Tailscale Funnel: must remain off.
- Direct Tailscale IP behavior: hostname routing is expected; use MagicDNS URL,
  not bare Tailscale IP, for Serve.
- Durable Mac service setup: documented in `docs/macos-launchd-runbook.md`.
  It is optional and not auto-installed.

## Latest implementation commits

```text
74d8d62 Add phone pairing helper
6da5203 Add live operator status check
6f3f1cc Document durable Mac launch setup
c611e14 Record live Tailscale Serve verification
d3ebe7b Align public docs with acceptance baseline
8b65a30 Add full acceptance smoke gate
6c2f062 Harden self-contained UI smokes
559ac95 Clarify private access external verification
bc54f42 Expand full-flow smoke proof
bd5e3cc Add native Gemini provider execution
e552f89 Prove credential backend states
```

## Acceptance evidence

Primary acceptance artifact:

```text
artifacts/acceptance/acceptance-summary.json
```

Latest recorded acceptance result:

- Status: `passed`
- Started: `2026-05-31T20:44:54.190Z`
- Ended: `2026-05-31T20:46:23.894Z`
- Elapsed: `89704ms`
- Steps passed: `23`

Additional live operator preflight:

- `COMMAND_DECK_PRIVATE_URL=<tailnet-url> npm run operator:phone-check`
- Status: `passed`
- Artifact: `artifacts/operator-phone-check/phone-check-summary.json`
- Artifact redaction: API tokens, cookies, pairing codes, and private hostnames
  are not stored.

Covered commands:

```text
npm test
npm run smoke
npm run smoke:api
npm run smoke:full-flow
npm run smoke:security
npm run smoke:ssrf
npm run smoke:ui
npm run smoke:ui-inventory
npm run smoke:ui-contract
npm run smoke:route-inventory
npm run smoke:route-security-matrix
npm run smoke:full-buildout-ledger
npm run smoke:security-headers
npm run smoke:streams
npm run smoke:private-access
npm run smoke:pwa-cache
npm run smoke:providers
npm run smoke:api-provider
npm run smoke:notifications
npm run smoke:app-backup
npm run smoke:state-migrations
npm run smoke:auth-sessions
npm run smoke:credential-backends
npm run smoke:credential-redaction
npm run smoke:evidence-redaction
npm run smoke:process-lifecycle
```

Unit tests:

- `141/141` passing in the acceptance run.

Ledger:

- `docs/full-buildout-ledger.md`
- `npm run smoke:full-buildout-ledger` reports 26 areas:
  - `24 implemented_and_proven`
  - `2 externally_blocked`

The two external rows are:

- `private-access-tailscale`: code-side and local Serve proof complete; real
  phone reachability remains a user-device check.
- `native-packaging-tauri`: Tauri v2 scaffold exists and compiles with native
  server lifecycle, OS credential storage, menu/tray actions, and bundled
  macOS package-path resources. Release updater scaffolding is present with a
  committed public key and ignored private-key/CI-secret path. Signed/notarized
  DMG validation and native mobile adapters remain later-phase work.

## UI evidence

UI inventory artifact:

```text
artifacts/ui-inventory/inventory-summary.json
```

UI inventory result:

- 30 route screenshots generated.
- Desktop and 390px phone viewports covered.
- Every recorded route had `overflowPx: 0`.
- Dead action scan: passed.
- Accessible label scan: passed.

Representative screenshot paths:

```text
artifacts/ui-inventory/desktop-home.png
artifacts/ui-inventory/desktop-project-detail.png
artifacts/ui-inventory/desktop-session-workflow.png
artifacts/ui-inventory/desktop-lane-detail.png
artifacts/ui-inventory/desktop-settings.png
artifacts/ui-inventory/desktop-providers.png
artifacts/ui-inventory/desktop-private-access.png
artifacts/ui-inventory/phone-home.png
artifacts/ui-inventory/phone-project-detail.png
artifacts/ui-inventory/phone-session-workflow.png
artifacts/ui-inventory/phone-lane-detail.png
artifacts/ui-inventory/phone-settings.png
artifacts/ui-inventory/phone-providers.png
artifacts/ui-inventory/phone-private-access.png
```

UI contract artifact:

```text
artifacts/ui-contract/contract-summary.json
```

UI contract result:

- Shared shell, rail, topbar, and main-surface checks passed.
- Topbar background alpha is `0` on checked routes.
- No underlined route links reported.
- No unstyled controls reported.
- No unlabeled icon buttons reported.
- Desktop and 390px phone overflow remained `0`.

Live Tailscale UI proof can be rerun on a configured host with:

```bash
COMMAND_DECK_PRIVATE_URL=<tailnet-url> npm run operator:status
COMMAND_DECK_BASE_URL=<tailnet-url> COMMAND_DECK_API_TOKEN=... npm run smoke:ui
```

## Provider support

First-class provider profiles are implemented and proven for:

- Codex
- Claude
- Custom CLI
- OpenAI-compatible API
- Gemini API
- Kimi
- DeepSeek
- OpenRouter
- Composer

Provider proof:

- `npm run smoke:providers`
- `npm run smoke:api-provider`
- `npm test`

API provider execution is proven against local dummy OpenAI-compatible and
native Gemini servers, including secret lookup and redaction. Real hosted
provider checks require user-provided keys and are intentionally not run by
default.

## Credential status

Credential behavior is proven without writing real OS secrets by default:

- Memory/test backend.
- Env fallback.
- Injectable macOS Keychain command path.
- Delete/fallback behavior.
- Dashboard-safe backend status metadata.
- Windows Credential Manager and Linux Secret Service fail-closed blocked
  states when unavailable.

Credential proof:

- `npm run smoke:credential-backends`
- `npm run smoke:credential-redaction`
- `npm test`

Secret values must never be returned in API state, browser storage, project
JSON, lane JSON, MCP config, logs, artifacts, screenshots, exports,
notifications, service-worker cache, route inventory, or support bundles.

## MCP, orchestration, critique, and audit status

MCP/tooling proof:

- Public-safe discovery.
- Server-minted leases.
- Role/provider/lane-scoped tools.
- Per-lane config generation.
- Invalid tool refusal.
- Compact `nextAction` envelopes.

Orchestration proof:

- Default spawn policy: `within_capacity`.
- Default approved capacity: `2`.
- Capacity is a ceiling, not a target.
- Solo-orchestrator mode is represented.
- Structured capacity requests are policy-gated.
- Audit-one, audit-all, accept, fix, block, and retry transitions are tested.
- Required critique, visual-required screenshot checks, stale nonce refusal,
  and waiver approval are tested.

Proof commands:

- `npm test`
- `npm run smoke:full-flow`
- `npm run smoke:acceptance`

## Security status

Security controls proven by tests/smokes include:

- Token or paired-browser auth for mutating routes.
- Same-origin checks for browser-session mutations.
- Pairing code rate limits.
- JSON body limits and malformed JSON/query handling.
- Route security matrix for 102 routes.
- Centralized rate-limit metadata.
- Security headers and no-store sensitive responses.
- SSRF URL policy reused by accepted URL surfaces.
- Artifact traversal, encoded traversal, absolute path, backslash, and symlink
  refusal.
- Actor spoofing refusal.
- Redaction for credentials and sensitive evidence routes.
- Static-only PWA cache.
- No default auto-install/update behavior.

Proof commands:

- `npm run smoke:route-inventory`
- `npm run smoke:route-security-matrix`
- `npm run smoke:security-headers`
- `npm run smoke:ssrf`
- `npm run smoke:pwa-cache`
- `npm run smoke:credential-redaction`
- `npm run smoke:evidence-redaction`
- `npm test`

## Tailscale and phone handoff

Current private URL:

```bash
tailscale serve status
```

Live operator status check:

```bash
COMMAND_DECK_PRIVATE_URL=<tailnet-url> npm run operator:status
```

If `COMMAND_DECK_PRIVATE_URL` is omitted, `operator:status` attempts to
discover a tailnet-only URL from `tailscale serve status`.

This command is read-only. It checks local health, private Tailscale health,
tailnet-only Serve status, and public Funnel status without changing Serve,
Funnel, auth sessions, provider credentials, or project state.

Fresh one-time pairing code helper:

```bash
COMMAND_DECK_API_TOKEN=... npm run operator:pair
```

The helper creates a phone/browser pairing code through the local authenticated
API and prints only the one-time code, expiry, and safety warning. It never
prints the API token.

Phone-readiness preflight:

```bash
COMMAND_DECK_PRIVATE_URL=<tailnet-url> npm run operator:phone-check
```

Pairing-code-enabled preflight:

```bash
COMMAND_DECK_PRIVATE_URL=<tailnet-url> COMMAND_DECK_API_TOKEN=... npm run operator:phone-check -- --create-pairing-code
```

This writes `artifacts/operator-phone-check/phone-check-summary.json` with
local/private health, pre-pairing no-data checks for private workspace routes,
Tailscale Serve, Funnel, and manual phone checklist status. The summary never
stores API tokens, cookies, or pairing codes. It also redacts private hostnames
from recorded URLs and Tailscale status output.

Local completion audit:

```bash
npm run operator:completion-audit
```

This writes `artifacts/completion-audit/completion-audit-summary.json` from the
acceptance summary, full-buildout ledger, phone preflight summary, and git
status. It is the fastest way to see whether the app is locally ready or still
blocked by external/manual proof.

Use one-time browser pairing from the dashboard. Do not put tokens in URLs.
Pairing codes are one-time secrets and should not be stored in docs, logs,
screenshots, or issue comments.

If Command Deck needs to stay available after the active terminal session exits,
use `docs/macos-launchd-runbook.md` to install a user LaunchAgent. The runbook
keeps the API token in `~/.command-deck.env` with mode `600` and keeps the
plist secret-free.

Phone check:

1. Open the tailnet URL from `tailscale serve status` on a phone connected to
   the same tailnet.
2. Pair the browser with a fresh one-time code from the local dashboard or
   `npm run operator:pair`.
3. Confirm the project rail loads.
4. Open a project, a session, and a lane.
5. Open settings, providers, private access, and evidence routes.
6. Confirm no horizontal overflow or unusable controls on the phone.

If the phone check passes, update:

- `docs/full-buildout-ledger.md`
- `docs/implementation-plan.md`
- this readiness report

Then run:

```bash
npm run smoke:full-buildout-ledger
git diff --check
```

Commit the update with explicit paths.

## Remaining blockers

Only these remain after current evidence:

- Real phone reachability from the user's phone is still unverified in this
  report.
- Native packaging is later-phase and not part of the PWA v1 completion bar
  unless explicitly approved.
