# Preview surfaces

Orca previews are server-authoritative targets that can be opened,
health-checked, or captured as evidence. The dashboard should send a saved
preview or evidence preset id, not an arbitrary client-supplied URL, for normal
operator flows.

## Current model

- Project live links are saved through the quick-link API or agent tools.
- Lane evidence presets are derived by the server from the lane target URL and
  saved project live links.
- Dashboard capture buttons submit a preset id. The server resolves the URL,
  applies SSRF/sensitive-route policy, and records the screenshot, trace, video,
  or degraded artifact.
- One-time ad hoc capture URLs remain an advanced API path only when explicitly
  approved. They are not the normal dashboard UX.

## Preview classes

| Class | Status | Expected source | Capture path | Notes |
| --- | --- | --- | --- | --- |
| `web-dev-server` | implemented | saved project live link | Playwright page screenshot/trace/video | Best fit for Vite, Next, docs servers, Storybook, and dashboard-relative views. |
| `web-mobile-emulation` | scoped | saved project live link plus device profile | Playwright browser context with mobile viewport, user agent, scale factor, and touch | Good for phone/tablet responsive and PWA checks without requiring native SDKs. |
| `artifact-preview` | implemented | saved artifact or dashboard-relative link | artifact route plus evidence gallery | Good for generated files, reports, screenshots, and exports. |
| `pwa-shell` | scoped | saved project live link plus PWA manifest checks | Playwright browser context and service-worker/static cache gates | Good for installability and offline/static-cache verification. |
| `android-browser-device` | future adapter | approved Android device or emulator | Playwright Android Chrome/WebView automation | Requires ADB, an awake authenticated device/emulator, and Android browser setup. Treat as optional host capability. |
| `ios-simulator-native` | future adapter | approved macOS/Xcode simulator host | native simulator tooling screenshot and logs | Playwright does not replace native iOS app build/run requirements. Keep behind a host adapter such as XcodeBuild tooling. |
| `android-native` | future adapter | approved Android SDK/emulator or device host | Android tooling screenshot and logs | Requires Android native tooling; browser emulation alone is not enough for arbitrary native apps. |
| `tauri-desktop-app` | future adapter | Tauri host-managed desktop process | native host screenshot/status plus webview route checks | Requires packaged desktop host lifecycle and narrow Tauri commands. |

## Server-authoritative rules

- The client may request `presetId`, `linkId`, `projectId`, `laneId`, or a
  named device profile.
- The server or host adapter resolves actual URLs, local paths, process ids,
  simulator ids, and executable commands.
- Adapters must return redacted status and evidence metadata only. They must not
  expose API tokens, pairing codes, cookies, credential values, local secrets,
  or unrestricted filesystem paths.
- Health checks probe saved links only. They do not accept arbitrary URLs from
  chat text.
- Preview capture must keep using the existing evidence artifact containment,
  redaction, and cleanup rules.

## Tool direction

Preview capabilities should be exposed as narrow tools instead of raw shell
execution:

- `project.quick_link.upsert`: save or update the canonical live link.
- `project.quick_link.health`: check a saved link.
- `preview.targets.list`: list server-resolved preview targets for a project or
  lane.
- `preview.capture`: capture a saved target using a profile such as `desktop`,
  `phone`, `tablet`, or `trace`.
- `preview.host_capabilities`: report whether this workstation has Playwright
  browsers, Android ADB, Xcode simulators, or a Tauri host bridge available.

The last three tools are scoped future work. They should sit on top of the same
registry and evidence runner contracts instead of adding a second preview
system.

## Web-only versus native prerequisites

The web/PWA app can open saved links, capture browser evidence, check mobile
browser layouts, and guide phone pairing while the local server is already
running. It cannot start a stopped local server or manage native simulators by
itself.

The desktop/Tauri app is the right owner for startup, restart, OS credentials,
launch-at-login, and host capability bridges. Native iOS and Android previews
should remain optional adapters because they require platform SDKs, simulators,
devices, or authenticated host tools.

## References

- Playwright emulation guide: https://playwright.dev/docs/emulation
- Playwright Android automation API: https://playwright.dev/docs/api/class-android
- Tauri sidecar binaries: https://v2.tauri.app/develop/sidecar/
- Tauri autostart plugin: https://v2.tauri.app/plugin/autostart/
