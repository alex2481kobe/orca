# Open-source macOS release checklist

Use this checklist before making the repository public and publishing the first
macOS release.

## Repo readiness

- `LICENSE` contains the GNU AGPLv3 text and matches `package.json` /
  `src-tauri/Cargo.toml` as `AGPL-3.0-or-later`.
- `README.md` links to contribution, security, support, Tauri release, and
  macOS/manual/web-PWA release docs.
- Public agent docs include the orchestrator skill, executor skill, and
  `docs/agent-run-modes.md`.
- `.github/` issue, pull request, and release templates are present.
- `.github/CODEOWNERS` protects workflows, dependency manifests, Tauri files,
  scripts, service-worker files, and public governance docs.
- GitHub Actions are manual-only (`workflow_dispatch`) by default; automatic
  `push`, `pull_request`, `pull_request_target`, and scheduled triggers are
  blocked by `npm run smoke:workflow-policy`.
- GitHub Actions workflow permissions default to read-only, and Actions cannot
  create or approve pull requests.
- GitHub Actions fork pull requests are reviewed before a maintainer runs any
  workflow against them.
- `main` branch protection requires PR review, CODEOWNERS review, resolved
  conversations, stale-review dismissal, last-push approval, no force pushes,
  and no branch deletion. If automatic CI is later re-enabled, require passing
  CI too.
- Repo Actions policy is limited to GitHub-owned actions unless a third-party
  action is explicitly reviewed and pinned.
- `SECURITY.md` tells reporters not to post secrets publicly.
- `CONTRIBUTING.md` lists required checks and sensitive files that must never
  be committed.
- `.npmrc` blocks git dependencies, lifecycle scripts, non-exact saves, audit
  bypass drift, and funding prompts by default.
- `package.json` has repository, issue, homepage, license, and engine metadata.
- `.gitignore` excludes local credentials, `.tauri/`, artifacts, logs, and
  release bundles.
- The dashboard includes visible Source and License links for AGPL network-use
  compliance.

## Automated release gate

Run from a clean checkout:

```sh
npm install
npm test
npm run smoke:acceptance
npm run smoke:workflow-policy
npm run smoke:orchestrator-executor
npm run smoke:full-buildout-ledger
npm run build:web
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:check
npm run tauri:release-preflight -- --local
git diff --check
```

Expected local-only caveat: `tauri:release-preflight -- --local` must find the
ignored updater private key and Apple release environment. It intentionally
does not require a GitHub token because release assets can be uploaded manually.
If Apple variables are missing, that is a manual release blocker, not an
app-code blocker.

## macOS distribution gate

Complete `docs/tauri-manual-release-checklist.md` from the Mac workstation:

- Developer ID Application certificate installed.
- App Store Connect API key available outside the repo.
- Tauri updater private key restored under ignored local state.
- Version bumped and committed.
- Tag pushed.
- Signed/notarized DMG built from a normal logged-in macOS session or suitable
  macOS CI worker.
- Updater `.app.tar.gz`, `.sig`, and `latest.json` uploaded to the same GitHub
  Release.
- Downloaded DMG installs and passes `spctl`.
- Installed app launches, starts the server, opens the dashboard, and creates a
  pairing code.
- Unpaired phone/browser access shows no workspace data until pairing.

## Do not publish

Do not make a release if any of these are present in git history, release
assets, issue text, or screenshots:

- API tokens, provider secrets, pairing codes, cookies, Apple credentials,
  updater private keys, `.p8` files, `.p12` files, `.env` files, private
  hostnames, generated logs, or raw support bundles.
- Public tunnel defaults or Tailscale Funnel setup.
- Unsigned/unnotarized macOS artifacts presented as production installers.
