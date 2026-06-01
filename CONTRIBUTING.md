# Contributing

Command Deck is a local-first desktop/web app with security-sensitive surfaces:
local files, shells, provider credentials, agent sessions, private network
access, screenshots, logs, and update artifacts. Keep changes scoped and prove
security-sensitive behavior with tests or smoke gates.

## Local setup

```sh
npm install
COMMAND_DECK_API_TOKEN="$(openssl rand -hex 32)" npm run dev
```

Open <http://127.0.0.1:3000/>.

## Before opening a pull request

Run the smallest relevant checks for your change. For broad changes, run:

```sh
npm test
npm run smoke:acceptance
npm run smoke:route-security-matrix
npm run smoke:full-buildout-ledger
git diff --check
```

For Tauri changes, also run:

```sh
npm run build:web
npm run tauri:check
cargo test --manifest-path src-tauri/Cargo.toml
```

## Security expectations

- Do not commit `.env` files, `.tauri/`, Apple certificates, updater private
  keys, API keys, pairing codes, auth cookies, generated logs, screenshots, or
  release bundles.
- Do not add public tunnels or default public exposure. Tailscale Funnel is not
  part of the v1 security model.
- Keep the server authoritative for credentials, pairing, live links, MCP
  tools, executor lifecycle, cleanup, import/export, and route authorization.
- Provider secrets must remain server-side credential references or environment
  variables. They must not be stored in browser state, artifacts, logs,
  service-worker cache, MCP config, or support bundles.
- Mutating browser-session routes need same-origin protection. Paired phone
  browsers are operator sessions, not workstation admins.

## Pull request shape

- Explain what changed and which checks passed.
- Include screenshots only when UI changed.
- Keep unrelated refactors out of the PR.
- Update `docs/full-buildout-ledger.md` and run
  `npm run smoke:full-buildout-ledger` when changing implementation status.

## Release changes

Use `docs/tauri-manual-release-checklist.md` for macOS releases. Do not commit
signing material, notarization credentials, local release artifacts, or updater
private keys.
