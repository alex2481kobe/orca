# Command Deck vX.Y.Z

## Install

Download the macOS DMG from this release, open it, and drag Command Deck to
Applications.

## macOS verification

- Signed and notarized DMG was built with Developer ID.
- `spctl --assess --type execute --verbose "/Applications/Command Deck.app"`
  passed after installing from the release DMG.
- The installed app launched, started the local server, opened the dashboard,
  and created a one-time pairing code.
- Pre-pairing phone/browser access showed no workspace data until pairing.

## Update artifacts

This release includes:

- `Command Deck_<version>_<arch>.dmg`
- `Command Deck.app.tar.gz`
- `Command Deck.app.tar.gz.sig`
- `latest.json`

The installed app reads
`https://github.com/alex2481kobe/orca/releases/latest/download/latest.json` and
verifies updater payload signatures with the public key compiled into the app.

## Checks

```text
npm test
npm run smoke:acceptance
npm run smoke:full-buildout-ledger
npm run build:web
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:check
npm run tauri:release-preflight -- --local
npm run tauri:release-local -- --dmg
```

## Notes

-
