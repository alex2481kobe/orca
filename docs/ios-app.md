# Orca iOS app (thin Tauri wrapper)

A native iOS shell (Tauri v2 mobile) that loads the Orca web client in a
fully-controlled WKWebView. It is a **remote client** to the workstation — iOS
cannot run Node or the CLI agents, so the orchestration server always stays on
the Mac and the phone drives it over Tailscale (same as the paired-device PWA).

What going native buys us over the PWA:
- A real app icon, no Safari/Chrome chrome, TestFlight/App Store distribution.
- **Native control of the webview frame** — we set it to the exact full screen and
  control safe-area / scroll-inset behavior, instead of fighting iOS's PWA
  "standalone" viewport heuristics. This is what fixes the "shifted up / dead
  space at the bottom" class of bugs for good.
- Native push, Keychain for the token, deep links — later, via Tauri plugins.

It is still a WKWebView rendering the same HTML/CSS/JS, so it reuses the entire
frontend. The only behavioral difference: on first launch it shows the existing
"Connect to a workstation" gate; entering the tailnet URL navigates the webview
there (`window.location.href`), and from then on the client runs same-origin from
the workstation (pairing cookies work normally).

## Architecture: desktop vs iOS

| | Desktop (macOS/Win) | iOS |
|---|---|---|
| Node server | spawned as a sidecar by the Rust shell | NOT run — connects to the workstation |
| Agents/CLIs | run locally | run on the workstation |
| Rust entry | `run_desktop()` — server mgmt, tray, native capture, updater | `run_mobile()` — minimal: just load the webview |
| Webview content | bundled client → `127.0.0.1` local server | bundled connect gate → navigates to tailnet URL |

The desktop-only Rust (Node spawn, `tauri::tray`/`menu`, `native_capture`, the
`server_*`/`pick_directory` commands, updater) must be gated behind
`#[cfg(desktop)]` — `tauri::tray`/`menu` don't even exist on mobile, so the
mobile build won't compile until they're gated. `run()` branches:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)] run_desktop();
    #[cfg(mobile)]  run_mobile();
}

#[cfg(mobile)]
fn run_mobile() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running Orca iOS");
}
```

## One-time toolchain setup (on the Mac)

Tauri iOS needs rustup (for the iOS cross-compile targets) and CocoaPods. This
adds rustup *alongside* Homebrew Rust; rustup's `cargo` builds the desktop app
fine too, but if you want to keep Homebrew Rust as default, only put
`~/.cargo/bin` ahead of `/opt/homebrew/bin` when building iOS.

```bash
# 1. rustup + iOS targets (device + simulator)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# 2. CocoaPods
brew install cocoapods            # or: sudo gem install cocoapods

# 3. Verify
xcodebuild -version               # Xcode 16+ (you have 26.2)
rustc --version                   # should now be the rustup one when ~/.cargo/bin is first
pod --version
```

## Scaffold + run

```bash
cd command-deck-client

# Generate the gen/apple Xcode project (one time)
npm run tauri ios init

# Dev: builds the Rust for iOS, opens the simulator or a connected device
npm run tauri ios dev

# Release IPA (needs signing configured — see below)
npm run tauri ios build
```

`tauri ios init` writes `src-tauri/gen/apple/` (the Xcode project). The first
build will surface any remaining `#[cfg(desktop)]` gaps — fix and rebuild.

## Signing (you have the dev cert + account)

- Open `src-tauri/gen/apple/<app>.xcodeproj` in Xcode once, select your Team under
  Signing & Capabilities, set a unique bundle id (e.g. `app.orca.ios`).
- Device install / TestFlight works with your developer account immediately.
- App Store submission is a separate review (Orca is a remote client, so the
  "controls your computer" angle is defensible, but expect a question).

## iOS config notes (tauri.conf.json)

- Use a distinct identifier for iOS if desired; keep `app.orca.desktop` for desktop.
- The webview should be edge-to-edge; our CSS already handles insets via
  `env(safe-area-inset-*)` + `100dvh`, which in a plain (non-PWA-standalone)
  WKWebView resolves to the real webview bounds — the predictable case.
- Allow the top-level navigation to the tailnet host (Tauri restricts external
  navigation by default). Confirm on-device; if blocked, set the webview to load
  the remote URL directly or widen the navigation allowlist.

## Status

- [x] Frontend connect-to-workstation flow does a full cross-origin navigation.
- [x] Rust `#[cfg(desktop)]` gating + `run_mobile()` — **compiles for `aarch64-apple-ios`, `-sim`, and desktop** (verified with `cargo check`).
- [x] `tauri ios init` scaffold — `src-tauri/gen/apple/orca-desktop.xcodeproj` generated and committed.
- [x] Toolchain installed: rustup + iOS targets + CocoaPods + libimobiledevice.
- [x] First **simulator run verified** — `npm run tauri ios dev "iPhone 17 Pro"` builds the
      iOS Rust lib, assembles `Orca.app`, installs + launches it, and the client
      renders **full-screen with correct safe-area handling and no "shifted up" gap**
      (the native-viewport win). In the simulator it loads the host dev server, so it
      shows the full home; a real device shows the Connect-to-workstation gate.
- [ ] On-device run (needs signing).
- [ ] Signing (set your Team + bundle id in Xcode) + TestFlight.

Note: `tauri ios dev` injects a few build-time edits into `gen/apple` (PRODUCT_NAME
quoting, a staged `assets/` copy of the frontend). `assets/` is gitignored; the
trivial pbxproj/Info.plist reformatting can be reverted (`git checkout`) — it
re-appears on each build and isn't worth committing.

## Next: run it

```bash
# Make sure rustup's cargo is on PATH (it has the iOS targets):
source "$HOME/.cargo/env"

# Simulator (no signing needed):
npm run tauri ios dev          # pick a simulator when prompted

# Real device / TestFlight (signing needed):
#  open src-tauri/gen/apple/orca-desktop.xcodeproj in Xcode,
#  Signing & Capabilities -> select your Team, set a bundle id (e.g. app.orca.ios),
#  then:
npm run tauri ios build
```

If the first run errors, it's almost always (a) PATH not pointing at rustup's
cargo, or (b) signing not set for a *device* build (simulator needs none).
