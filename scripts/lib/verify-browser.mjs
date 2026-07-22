// Shared engine + host-strategy helper for the browser verify scripts, so the
// same proof can run under Chromium (CI default) AND WebKit (iOS Safari's engine
// — the one that catches the engine-sensitive mobile bugs: drawer pointer-events
// and prefers-color-scheme). Pick the engine with VERIFY_ENGINE; default is
// chromium, and the default path is byte-for-byte identical to the old launches.
import { chromium, webkit } from 'playwright';

export function verifyEngine() {
  return String(process.env.VERIFY_ENGINE || 'chromium').toLowerCase();
}

// Reaching the app as a "remote" (non-loopback) client while the listener stays
// on 127.0.0.1. The client renders the remote-client UI purely from
// window.location.hostname being non-loopback (public/ui/overview.js), and the
// server's anti-DNS-rebinding gate only needs the Host in ORCA_ALLOWED_HOSTS —
// the socket being loopback is irrelevant to both. So we just need a hostname
// that (a) is NOT a loopback literal and (b) resolves to 127.0.0.1.
//   chromium: a fake tailnet host + a launch-time host-resolver rule → loopback.
//   webkit:   no such launch flag exists, so use the public wildcard
//             *.localtest.me, which really resolves to 127.0.0.1 via DNS.
export function remoteHostStrategy(engine = verifyEngine()) {
  if (engine === 'webkit') {
    return { host: 'remote.localtest.me', launchArgs: [] };
  }
  return {
    host: 'remote.test',
    launchArgs: ['--host-resolver-rules=MAP remote.test 127.0.0.1'],
  };
}

// Launch the engine's browser. `args` are Chromium launch flags (WebKit takes
// none and ignores them). launchBrowser() with no options and no VERIFY_ENGINE
// is exactly chromium.launch() — the pre-existing default behavior.
export async function launchBrowser({ engine = verifyEngine(), args = [] } = {}) {
  if (engine === 'webkit') return webkit.launch();
  return args.length ? chromium.launch({ args }) : chromium.launch();
}
