// Evidence capture. Split into native-bridge.js (helpers + native WKWebView
// bridge) and runner.js (Playwright runner); barrel preserves the public surface.

export { detectPlaywright } from './evidence-runner/native-bridge.js';
export { PlaywrightEvidenceRunner } from './evidence-runner/runner.js';
