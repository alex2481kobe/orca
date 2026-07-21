# Dependency audit posture

Run the audit any time with `npm run audit` (`npm audit --omit=dev`). This file
records what the audit reports today. Orca v2 ships as a Node daemon plus a
read-only web/PWA dashboard — there is no native/Rust build in the tree — so the
dependency surface is JavaScript only.

## JavaScript app (what users actually run — web / PWA / server)

```
npm audit            → 0 vulnerabilities
npm audit --omit=dev → 0 vulnerabilities   (also enforced by manual CI)
```

The server, dashboard, and PWA — the code every user runs — have **zero** known
vulnerable dependencies.

## Keeping it clean

- `npm run audit` runs the production audit locally.
- Manual CI runs `npm audit --omit=dev`; keep CI manual unless untrusted PR
  execution is deliberately re-designed.
- `npm test` + the `smoke:*` gates include the app's own security checks (auth tiers,
  SSRF policy, secret redaction, path containment, rate limits, prototype‑pollution
  rejection, XSS‑safe rendering).
