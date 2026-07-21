// Evidence capture module entry. Split into native-bridge.js (helpers + native
// WKWebView bridge) and runner.js (Playwright runner); this is the module's
// public surface. (detectPlaywright is internal to runner.js — not re-exported.)

export { PlaywrightEvidenceRunner } from './evidence-runner/runner.js';
