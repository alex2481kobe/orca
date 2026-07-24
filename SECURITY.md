# Security Policy

Orca controls local automation and private operator access, so security
reports should avoid public disclosure of exploitable details until a fix is
available.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue. Use
GitHub's **"Report a vulnerability"** button on the
[Security tab](https://github.com/alex2481kobe/orca/security/advisories/new)
(private vulnerability reporting is enabled). We'll acknowledge the report, work
with you on a fix, and coordinate disclosure.

Do not include live API tokens, provider secrets, pairing codes, cookies,
private hostnames, screenshots with secrets, or raw local logs in a public
report.

Useful non-secret details include:

- affected commit SHA,
- operating system and architecture,
- Node version,
- whether the request came from the workstation browser or a paired remote
  device,
- exact route, MCP tool, or feature involved,
- minimal reproduction steps,
- expected vs. actual authorization boundary,
- redacted logs or screenshots.

## Supported versions

Orca is not published to a package registry and has no release artifacts — you
run it from a git checkout. Security fixes target the current `main` branch. If
you are on an older commit, pull `main` before reporting.

## Security model summary

- The HTTP server binds to `127.0.0.1` by default.
- Direct (non-proxied) requests are gated by an anti-DNS-rebinding Host-header
  allowlist, so a page that rebinds its domain to loopback cannot inherit the
  local bootstrap-admin trust. The admin API token is held in memory only (never
  in web storage).
- Public unauthenticated routes are limited to liveness (`GET /api/health`),
  auth status (`GET /api/auth/status`), and the static shell. Every other
  `/api/*` route refuses unauthenticated callers.
- There are two authenticated tiers:
  - **operator** — an API token, loopback bootstrap when no token is set, or a
    paired browser session. Operators get workflow reads **and writes**.
  - **admin** — an API token or loopback bootstrap only. Workstation-level
    actions live here.
- A paired remote device (for example, a phone) is an **operator, not an
  admin**. It can read the workspace and it can use the dashboard's break-glass
  controls: stop an executor, stop the agents under an orchestrator, close an
  agent. It cannot mint pairing codes, change private-access/Tailscale Serve
  settings, revoke another device's session, mint host-level MCP credentials,
  run a fleet-wide stop, or grant a lane unsandboxed permissions. Those require
  workstation admin auth.
- The dashboard is a monitoring surface with deliberate break-glass controls. It
  is not an agent console: there is no chat, no prompt box, and no way to type
  into a running agent from it. Orchestration is driven by agents over MCP.
- Tailscale Serve is private tailnet access only. Tailscale Funnel is not part
  of the security model.
- Provider secrets, pairing codes, cookies, and API tokens must never be
  committed or written into generated artifacts.

## Repository hardening

- GitHub Actions are manual-only by default, dispatched by a maintainer, because
  the third-party contribution policy is intentionally conservative.
- Pull requests from forks should be reviewed before workflows are run,
  especially when they change `.github/workflows/`, dependency manifests,
  scripts, or service-worker files.
- Do not use `pull_request_target` for untrusted code paths. Do not add
  automatic `push`, `pull_request`, or scheduled workflow triggers without
  owner review.
- The default `GITHUB_TOKEN` permission should remain read-only, and workflows
  should not receive secrets from fork pull requests.
- The `main` branch is protected: merges go through a pull request with
  CODEOWNERS review and resolved conversations, and force-pushes and branch
  deletion are blocked. If automatic CI is later enabled, passing CI is also
  required.
- Changes to workflows, dependencies, scripts, service-worker behavior, security
  policy, license, or contribution policy are owner-review paths.

## Dependency audits

`npm run audit` is exactly `npm audit --omit=dev` — a production-dependency
audit of this repo's npm tree. Orca's source is JavaScript only; there is no
native build in the tree. The single runtime dependency is `@lydell/node-pty`
(the PTY behind interactive CLI executors, currently pinned to a beta); the rest
are dev-only (`playwright`, `typescript`, `@types/node`).

Run the audit yourself for the current answer. A snapshot of audit results
committed to a doc goes stale the moment a new advisory lands, so this repo
does not publish one.

`npm test` and the `smoke:*` gates cover Orca's own security behavior: auth
tiers, the unauthenticated-route sweep, SSRF/URL policy, secret redaction, path
containment, rate limits, prototype-pollution rejection, and XSS-safe rendering.
