# Contributing

Orca is a local-first daemon with security-sensitive surfaces: local files,
spawned CLI processes, agent tool leases, private network access, and logs. Keep
changes scoped and prove security-sensitive behavior with tests or smoke gates.

## Local setup

```sh
npm ci --ignore-scripts
npm start
```

Open <http://127.0.0.1:3000/>. On loopback with no `ORCA_API_TOKEN` set, the local
process is trusted as admin so you can develop without wiring auth. To exercise the
hardened path instead, set a token:

```sh
ORCA_API_TOKEN="$(openssl rand -hex 32)" npm start
```

## Before opening a pull request

Run the smallest relevant checks for your change. For broad changes, run what CI
runs:

```sh
npm run typecheck:imports
npm run smoke:no-hardcoded-colors
npm test                    # the full node --test suite
npm run smoke               # full-flow gate
npm run smoke:screens       # 7 browser screen proofs (Chromium)
npm run smoke:unauth-sweep  # every mutating route must refuse anonymous callers
git diff --check
```

Useful extras that are **not** in CI (run them when your change touches the area):
`smoke:screens-webkit` (iOS Safari engine), `smoke:canvas-perf` (dashboard FPS/heap),
`smoke:real-executor` (spawns a real CLI agent), `smoke:mcp-cli-handshake`,
`smoke:private-access`.

If you change anything the browser renders, run `smoke:screens` — a screenshot
harness catches layout regressions that unit tests cannot.

## Security expectations

- Do not commit `.env` files, API keys, pairing codes, auth cookies, generated
  logs, screenshots, or `.orca/` state.
- GitHub Actions are manual-only by default. Do not add automatic `push`,
  `pull_request`, `pull_request_target`, or scheduled workflow triggers without
  owner review.
- Fork PRs should be reviewed before any maintainer runs workflows against
  them. Never expose repository secrets to untrusted pull request code.
- Dependency installs use repo npm guardrails. Do not bypass `ignore-scripts`,
  `allow-git=none`, `min-release-age=30`, exact-version saves, or production
  audit checks without calling it out for owner review.
- Do not add public tunnels or default public exposure. Tailscale Funnel is not
  part of the security model.
- Keep the server authoritative for pairing, live links, MCP tools, executor
  lifecycle, cleanup, and route authorization. A client must never be able to
  grant itself a tool the server did not lease it.
- Mutating browser-session routes need same-origin protection. Paired phone
  browsers are operator sessions, not workstation admins.

## Pull request shape

- Explain what changed and which checks passed.
- Include screenshots only when UI changed.
- Keep unrelated refactors out of the PR.
- Changes to `.github/`, dependencies, scripts, the service worker, license,
  security policy, or contribution policy require owner review before merge.

## License

Contributions are accepted under `Apache-2.0`. By contributing, you agree that
your contribution can be distributed under that license.
