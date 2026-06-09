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
private hostnames, Apple credentials, updater private keys, screenshots with
secrets, or raw local logs in a public report.

Useful non-secret details include:

- affected version or commit SHA,
- operating system and architecture,
- whether the app was run as web/PWA or Tauri desktop,
- exact route or feature involved,
- minimal reproduction steps,
- expected vs. actual authorization boundary,
- redacted logs or screenshots.

## Supported versions

Security fixes target the latest public release and the current `main` branch.
Older prerelease builds may be asked to upgrade before a fix is validated.

## Security model summary

- The HTTP server binds to `127.0.0.1` by default.
- Direct (non-proxied) requests are gated by an anti-DNS-rebinding Host-header
  allowlist, so a page that rebinds its domain to loopback cannot inherit the
  local bootstrap-admin trust. The admin API token is held in memory only (never
  in web storage).
- Public unauthenticated routes are limited to liveness, auth status, and the
  static shell.
- Workspace data and host controls require an API token or paired browser
  session.
- Tailscale Serve is private tailnet access only. Tailscale Funnel is not part
  of the v1 model.
- Paired phone browsers are operator sessions. They cannot perform workstation
  admin actions such as credential writes, CLI reinstall execution, pairing-code
  creation, private-access mutation, or app export.
- Provider secrets, updater private keys, Apple signing material, pairing
  codes, cookies, and API tokens must never be committed or stored in generated
  artifacts.

## Repository hardening

- GitHub Actions are manual-only by default, dispatched by a maintainer, because
  the third-party contribution policy is intentionally conservative.
- Pull requests from forks should be reviewed before workflows are run,
  especially when they change `.github/workflows/`, dependency manifests,
  scripts, Tauri config, or service-worker files.
- Do not use `pull_request_target` for untrusted code paths. Do not add
  automatic `push`, `pull_request`, or scheduled workflow triggers without
  owner review.
- The default `GITHUB_TOKEN` permission should remain read-only, and workflows
  should not receive secrets from fork pull requests.
- The `main` branch should require a pull request, conversation resolution,
  stale-review dismissal, last-push approval, and CODEOWNERS review. If CI is
  later re-enabled automatically, passing CI should also be required.
- Changes to workflows, dependencies, Tauri packaging, scripts, service-worker
  behavior, security policy, license, or contribution policy are owner-review
  paths.

## Dependency audits

Run `npm run audit` to scan both the JavaScript app and the Rust desktop shell.
Current results and the rationale for the remaining transitive items are recorded
in [`docs/security-posture.md`](docs/security-posture.md): the web/PWA/server code
has zero known-vulnerable dependencies, and the Rust shell has zero actual
vulnerabilities — only unmaintained/unsound notices on Tauri's transitive Linux
GTK webview crates, which are not compiled or used on the shipped macOS/iOS/web
targets.
