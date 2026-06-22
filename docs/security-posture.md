# Dependency audit posture

Run both audits any time with `npm run audit` (npm + cargo). This file records what
the audits report today and why the remaining items are not user-facing risks.

## JavaScript app (what users actually run — web / PWA / server)

```
npm audit            → 0 vulnerabilities
npm audit --omit=dev → 0 vulnerabilities   (also enforced by manual CI)
```

The server, dashboard, and PWA — the code every user runs — have **zero** known
vulnerable dependencies.

## Rust desktop shell (`src-tauri/`, Tauri v2)

```
cargo audit → 0 vulnerabilities, 17 warnings
```

There are **zero** actual vulnerabilities. The 17 warnings are all
`unmaintained` / `unsound` advisories on **transitive** crates that Tauri pulls in
for its **Linux GTK3 webview backend** (the `gtk-rs` family — `atk`, `gdk`, `gtk`,
`glib`, … — plus `proc-macro-error` and the `unic-*` set). None of these are crates
Orca depends on directly.

**Why this is not a user risk:**

- Orca's validated release path today is **macOS** plus **phone web/PWA access**.
  The macOS shell uses WKWebView, and the web/PWA path does not compile or load
  the GTK3/glib stack. Those crates are only in `Cargo.lock` because the Tauri
  dependency graph also covers a Linux build.
- They are **unmaintained / unsound notices**, not exploitable CVEs, and they are
  **pinned by Tauri** — there is no in-semver-range fix to apply. They clear when
  Tauri bumps its webview dependency stack upstream; we'll pick that up on the next
  Tauri update.

The likely source of the GitHub Dependabot "1 moderate" alert is the `glib`
unsoundness advisory (RUSTSEC‑2024‑0429 / its GHSA equivalent). It is transitive,
Linux‑only, and not reachable in Orca's shipped targets, so it can be dismissed in
the GitHub UI as "vulnerable code is not actually used" with a link to this file.

## Keeping it clean

- `npm run audit` runs both audits locally.
- Manual CI runs `npm audit --omit=dev`; keep CI manual unless untrusted PR
  execution is deliberately re-designed.
- `npm test` + the `smoke:*` gates include the app's own security checks (auth tiers,
  SSRF policy, secret redaction, path containment, rate limits, prototype‑pollution
  rejection, XSS‑safe rendering).
- Routine `cargo update` (within semver) keeps the Rust deps patched; the last pass
  bumped 8 minor crate versions with the build still green.
