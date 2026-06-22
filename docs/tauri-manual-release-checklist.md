# Manual macOS release checklist

Use this when making the first real signed/notarized Orca release from
the Mac workstation. This checklist intentionally keeps Apple and updater
secrets local.

## One-time setup

1. Confirm the Developer ID Application certificate is installed in Keychain.

   ```sh
   security find-identity -v -p codesigning
   ```

2. Generate or restore the Tauri updater private key under ignored local state:

   ```sh
   npm run tauri signer generate -- --ci --write-keys .tauri/orca-updater.key
   ```

   Do not regenerate this key after users install the app unless you are willing
   to break update trust for older installs.

3. Create an App Store Connect API key for notarization, then place the `.p8`
   file somewhere outside the repo or under ignored local state.

4. Export local release environment variables for the current shell:

   ```sh
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   export APPLE_API_ISSUER="issuer-uuid"
   export APPLE_API_KEY="key-id"
   export APPLE_API_KEY_PATH="/absolute/path/to/AuthKey_KEYID.p8"
   ```

   Apple ID notarization fallback is available with `APPLE_ID`,
   `APPLE_PASSWORD`, and `APPLE_TEAM_ID`, but App Store Connect API keys are
   preferred.

## Per-release steps

1. Sync the repo and install dependencies if needed.

   ```sh
   git pull --ff-only
   npm ci --ignore-scripts
   ```

2. Bump the app version in all required files.

   ```sh
   npm run tauri:version -- 0.2.0
   ```

3. Run the local release preflight.

   ```sh
   npm run tauri:release-preflight -- --local
   ```

4. Commit the version bump.

   ```sh
   git add package.json package-lock.json src-tauri/tauri.conf.json
   git commit -m "Release 0.2.0"
   ```

5. Create and push the tag.

   ```sh
   git tag v0.2.0
   git push origin main
   git push origin v0.2.0
   ```

6. Build release artifacts.

   ```sh
   npm run tauri:release-local -- --dmg
   ```

   If the DMG AppleScript step fails in automation, rerun `npm run
   tauri:build:dmg` from the normal logged-in desktop session.

7. Create a GitHub Release for the tag and upload:

   ```text
   src-tauri/target/release/bundle/dmg/Orca_0.2.0_aarch64.dmg
   src-tauri/target/release/bundle/macos/Orca.app.tar.gz
   src-tauri/target/release/bundle/macos/Orca.app.tar.gz.sig
   ```

8. Generate the update manifest using the final GitHub asset URL.

   ```sh
   npm run tauri:release-local -- --skip-tests --manifest-url=https://github.com/alex2481kobe/orca/releases/download/v0.2.0/Command%20Deck.app.tar.gz
   ```

9. Upload `artifacts/tauri/latest.json` to the same GitHub Release.

10. Download the DMG from GitHub Releases on the Mac, install it, and confirm:

    ```sh
    spctl --assess --type execute --verbose "/Applications/Orca.app"
    ```

11. Launch the installed app and confirm:

    - Dashboard opens.
    - Server starts.
    - Native menu can create a pairing code.
    - Phone/browser pairing still shows no workspace data until paired.

12. For update validation, install an older signed version, publish a newer
    version with `latest.json`, then use the app menu to check and install the
    update.

## Artifacts

- DMG: user-facing first install.
- `.app.tar.gz`: updater payload.
- `.sig`: updater signature for the payload.
- `latest.json`: update feed read by the installed app.
