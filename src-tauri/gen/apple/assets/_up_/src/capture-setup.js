// Capture backend detection and governed on-demand setup.
//
// Orca's evidence capture (screenshots/video/traces of project URLs) needs a
// browser engine. To keep the app small we ship NO browser by default and set
// one up on demand, governed like any other install (admin + approval + audit).
//
// Backends, in preference order:
//   1. native   - the desktop app's own WKWebView (screenshots only, macOS).
//                 Advertised by the Tauri shell via ORCA_NATIVE_CAPTURE_URL.
//   2. playwright + system Chrome (channel) - small install, no 150MB download.
//   3. playwright + downloaded Chromium - fully self-contained fallback.
//
// This module is pure/injectable so it can be unit-tested without touching the
// real filesystem, network, or spawning processes. Execution of the plan is
// the caller's responsibility (governed runner), mirroring CLI reinstall.

import { existsSync } from 'node:fs';
import path from 'node:path';

export const CAPTURE_CONTRACT_VERSION = 'orca.capture-setup.v1';

// Pinned to the devDependency version so source and on-demand installs match.
export const PLAYWRIGHT_VERSION = '1.60.0';

// macOS system-browser candidates mapped to the Playwright `channel` that
// drives them without downloading Chromium.
const MAC_BROWSER_CANDIDATES = [
  { channel: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { channel: 'chrome-beta', path: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta' },
  { channel: 'msedge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  { channel: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
];

// Only these binaries may be invoked by a capture-setup plan. Anything else is
// rejected before execution.
const ALLOWED_INSTALL_BINARIES = new Set(['npm', 'npx']);

export function detectSystemChrome({ platform = process.platform, fileExists = existsSync } = {}) {
  const candidates = platform === 'darwin' ? MAC_BROWSER_CANDIDATES : [];
  for (const candidate of candidates) {
    if (fileExists(candidate.path)) {
      return { present: true, channel: candidate.channel, path: candidate.path };
    }
  }
  return { present: false, channel: null, path: null };
}

export function detectNativeCapture({ env = process.env } = {}) {
  const url = String(env.ORCA_NATIVE_CAPTURE_URL || '').trim();
  return { available: Boolean(url), endpoint: url || null };
}

// Compose the current capture posture from injected probes.
export function describeCaptureStatus({
  platform = process.platform,
  env = process.env,
  fileExists = existsSync,
  playwrightAvailable = false,
} = {}) {
  const native = detectNativeCapture({ env });
  const systemChrome = detectSystemChrome({ platform, fileExists });

  const backends = {
    native: native.available, // screenshots only
    playwright: Boolean(playwrightAvailable),
    systemChrome: systemChrome.present,
  };

  // Screenshots are possible via native OR playwright; video/traces need playwright.
  const screenshotsReady = backends.native || backends.playwright;
  const videoReady = backends.playwright;

  let recommendedAction = null;
  if (!screenshotsReady) {
    recommendedAction = systemChrome.present
      ? 'install-playwright-system-chrome'
      : 'install-playwright-download-chromium';
  } else if (!videoReady) {
    // Native covers screenshots but video/traces still need Playwright.
    recommendedAction = systemChrome.present
      ? 'install-playwright-system-chrome'
      : 'install-playwright-download-chromium';
  }

  return {
    contractVersion: CAPTURE_CONTRACT_VERSION,
    backends,
    systemChrome: { present: systemChrome.present, channel: systemChrome.channel },
    native: { available: native.available },
    screenshotsReady,
    videoReady,
    recommendedAction,
  };
}

// Build a governed, dry-runnable install plan. No execution here.
// installDir is where the Playwright npm package is installed (must be writable;
// the read-only app bundle is never a valid target).
export function planPlaywrightInstall({
  installDir,
  platform = process.platform,
  fileExists = existsSync,
  preferSystemChrome = true,
  browsersDir = null,
} = {}) {
  if (!installDir || !path.isAbsolute(installDir)) {
    throw new Error('planPlaywrightInstall requires an absolute installDir');
  }
  const systemChrome = detectSystemChrome({ platform, fileExists });
  const useSystemChrome = preferSystemChrome && systemChrome.present;
  const backend = useSystemChrome ? 'system-chrome' : 'download-chromium';

  const steps = [
    {
      label: `Install Playwright ${PLAYWRIGHT_VERSION} into ${installDir}`,
      command: 'npm',
      args: [
        'install',
        `playwright@${PLAYWRIGHT_VERSION}`,
        '--prefix', installDir,
        '--no-save',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ],
      cwd: installDir,
      env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    },
  ];

  if (!useSystemChrome) {
    const env = { PLAYWRIGHT_BROWSERS_PATH: browsersDir || path.join(installDir, 'browsers') };
    steps.push({
      label: 'Download the pinned Chromium build (~150MB)',
      command: 'npx',
      args: ['--prefix', installDir, 'playwright', 'install', 'chromium'],
      cwd: installDir,
      env,
    });
  }

  // Validate every step against the binary allowlist before returning.
  for (const step of steps) {
    if (!ALLOWED_INSTALL_BINARIES.has(step.command)) {
      throw new Error(`capture install plan rejected disallowed binary: ${step.command}`);
    }
  }

  return {
    contractVersion: CAPTURE_CONTRACT_VERSION,
    backend,
    channel: useSystemChrome ? systemChrome.channel : null,
    installDir,
    browsersDir: useSystemChrome ? null : (browsersDir || path.join(installDir, 'browsers')),
    mutatesMachine: true,
    approvalRequired: true,
    dryRun: true,
    estimatedDownload: useSystemChrome ? 'small (Playwright package only)' : '~150MB (Playwright + Chromium)',
    steps,
  };
}

// Execute a previously-built plan. Approval/audit are the caller's job (route
// layer); this only runs allowlisted steps and returns a redacted result.
// `spawn` is injectable so command construction is unit-testable without
// actually installing anything.
export async function runCaptureInstall(plan, {
  spawn,
  approved = false,
} = {}) {
  if (!plan || plan.contractVersion !== CAPTURE_CONTRACT_VERSION) {
    throw new Error('runCaptureInstall requires a current capture-setup plan');
  }
  if (!approved) {
    return { executed: false, reason: 'approval-required', plan: { ...plan, dryRun: true } };
  }
  if (typeof spawn !== 'function') {
    throw new Error('runCaptureInstall requires an injected spawn(command, args, options)');
  }

  const results = [];
  for (const step of plan.steps) {
    if (!ALLOWED_INSTALL_BINARIES.has(step.command)) {
      throw new Error(`capture install execution rejected disallowed binary: ${step.command}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const outcome = await spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
    });
    results.push({ label: step.label, code: outcome?.code ?? null });
    if (outcome && outcome.code !== 0) {
      return { executed: true, ok: false, failedStep: step.label, results };
    }
  }
  return {
    executed: true,
    ok: true,
    backend: plan.backend,
    channel: plan.channel,
    installDir: plan.installDir,
    browsersDir: plan.browsersDir,
    results,
  };
}
