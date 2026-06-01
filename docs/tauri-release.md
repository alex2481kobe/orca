# Tauri release, signing, notarization, and updates

Command Deck has two desktop build modes:

- `npm run tauri:build` creates a local unsigned macOS `.app` bundle for
  workstation testing.
- `npm run tauri:build:release` uses `src-tauri/tauri.release.conf.json` to
  create updater-signed release artifacts. The default release bundle is the
  macOS `.app`.
- `npm run tauri:build:dmg` produces the DMG bundle path.
- `npm run tauri:release-preflight` checks whether the release environment has
  the required updater, Apple signing/notarization, and GitHub upload secrets
  without printing secret values. Add `-- --local` to allow the ignored local
  `.tauri/` updater key and a local `APPLE_SIGNING_IDENTITY`.
- `npm run tauri:version -- 0.2.0` updates `package.json`,
  `package-lock.json`, and `src-tauri/tauri.conf.json` together.
- `npm run tauri:release-local` runs the local release prep sequence after
  manual secrets are exported. Add `-- --dmg` to include the DMG target and
  `-- --manifest-url=<url>` after the release asset URL is known.

For the exact workstation flow, use
[`docs/tauri-manual-release-checklist.md`](tauri-manual-release-checklist.md).

## Secrets

Never commit updater private keys, Apple certificates, app-specific passwords,
App Store Connect API keys, or notarization credentials.

The committed release config contains only the Tauri updater public key. The
private updater key generated during setup lives under `.tauri/`, which is
ignored by git. In CI, provide it as one of:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PATH`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, if the key is password-protected

If a fresh local key is needed:

```sh
npm run tauri signer generate -- --ci --write-keys .tauri/command-deck-updater.key
```

Losing the updater private key means previously installed apps cannot trust new
update artifacts signed by a replacement key.

## macOS signing and notarization

For public distribution outside the Mac App Store, use a Developer ID
Application certificate and Apple notarization. Tauri reads Apple signing and
notarization credentials from environment variables.

Common CI secrets:

- `APPLE_CERTIFICATE`: base64-encoded `.p12` Developer ID certificate.
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting the `.p12`.
- `APPLE_SIGNING_IDENTITY`: Developer ID Application identity, if needed.
- `APPLE_API_ISSUER`: App Store Connect issuer ID.
- `APPLE_API_KEY`: App Store Connect key ID.
- `APPLE_API_KEY_PATH`: path to the App Store Connect `.p8` private key.
- `APPLE_API_PRIVATE_KEY`: inline App Store Connect `.p8` private key, if the
  CI workflow writes it to a temporary file before running Tauri.
- `GITHUB_TOKEN` or `GH_TOKEN`: upload release assets and `latest.json`.

Apple ID notarization also works with:

- `APPLE_ID`
- `APPLE_PASSWORD`: app-specific password, not the account password.
- `APPLE_TEAM_ID`

App Store Connect API keys are better for CI because they avoid storing an Apple
ID app-specific password in the workflow.

## Release flow

1. Bump `version` in `src-tauri/tauri.conf.json` and `package.json`.
2. Build and test the web/PWA app normally.
3. Verify the release environment:

   ```sh
   npm run tauri:release-preflight
   ```

4. Build release artifacts:

   ```sh
   npm run tauri:build:release
   ```

5. For DMG output:

   ```sh
   npm run tauri:build:dmg
   ```

6. Upload the app/DMG and the updater artifact files to GitHub Releases.
7. Generate `latest.json` after setting the final download URL:

   ```sh
   COMMAND_DECK_UPDATE_ARTIFACT_URL="https://github.com/alex2481kobe/orca/releases/download/v0.1.0/Command%20Deck.app.tar.gz" \
     npm run tauri:release-manifest
   ```

8. Upload `latest.json` to:

   ```text
   https://github.com/alex2481kobe/orca/releases/latest/download/latest.json
   ```

The installed app checks that endpoint, verifies the updater signature with the
compiled public key, downloads the update artifact, installs it, and restarts.

## Local DMG note

The Tauri DMG bundler uses macOS `hdiutil` and Finder AppleScript to create the
drag-to-Applications disk image. In a restricted automation session, that
AppleScript step can fail or hang even when the `.app` and updater artifacts are
healthy. Run the DMG build from a normal logged-in macOS desktop session or a
macOS CI worker with the required UI automation permissions.

## Notarization timing

Apple does not provide a hard public SLA for notarization time. In normal cases
it is often minutes, but first-time setup, Apple service delays, certificate
issues, rejected submissions, or stapling problems can make it take longer. The
build should treat notarization as asynchronous release infrastructure, not as a
runtime app dependency.
