import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectSystemChrome,
  detectNativeCapture,
  describeCaptureStatus,
  planPlaywrightInstall,
  runCaptureInstall,
  PLAYWRIGHT_VERSION,
} from '../src/capture-setup.js';

test('detectSystemChrome finds macOS Chrome via channel', () => {
  const found = detectSystemChrome({
    platform: 'darwin',
    fileExists: (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  assert.equal(found.present, true);
  assert.equal(found.channel, 'chrome');
});

test('detectSystemChrome returns absent when no browser is installed', () => {
  const none = detectSystemChrome({ platform: 'darwin', fileExists: () => false });
  assert.equal(none.present, false);
  assert.equal(none.channel, null);
});

test('detectSystemChrome only probes macOS candidates on darwin', () => {
  const linux = detectSystemChrome({ platform: 'linux', fileExists: () => true });
  assert.equal(linux.present, false);
});

test('detectNativeCapture reflects the Tauri-provided endpoint env', () => {
  assert.equal(detectNativeCapture({ env: {} }).available, false);
  const native = detectNativeCapture({ env: { ORCA_NATIVE_CAPTURE_URL: 'http://127.0.0.1:5599' } });
  assert.equal(native.available, true);
  assert.equal(native.endpoint, 'http://127.0.0.1:5599');
});

test('describeCaptureStatus: nothing available -> recommends an install', () => {
  const status = describeCaptureStatus({
    platform: 'darwin',
    env: {},
    fileExists: () => false,
    playwrightAvailable: false,
  });
  assert.equal(status.screenshotsReady, false);
  assert.equal(status.videoReady, false);
  assert.equal(status.recommendedAction, 'install-playwright-download-chromium');
});

test('describeCaptureStatus: system Chrome present -> recommend lightweight install', () => {
  const status = describeCaptureStatus({
    platform: 'darwin',
    env: {},
    fileExists: (p) => p.includes('Google Chrome.app'),
    playwrightAvailable: false,
  });
  assert.equal(status.systemChrome.present, true);
  assert.equal(status.recommendedAction, 'install-playwright-system-chrome');
});

test('describeCaptureStatus: native covers screenshots but still wants Playwright for video', () => {
  const status = describeCaptureStatus({
    platform: 'darwin',
    env: { ORCA_NATIVE_CAPTURE_URL: 'http://127.0.0.1:5599' },
    fileExists: () => false,
    playwrightAvailable: false,
  });
  assert.equal(status.backends.native, true);
  assert.equal(status.screenshotsReady, true); // native handles screenshots
  assert.equal(status.videoReady, false); // but not video
  assert.equal(status.recommendedAction, 'install-playwright-download-chromium');
});

test('describeCaptureStatus: playwright present -> fully ready, no action', () => {
  const status = describeCaptureStatus({
    platform: 'darwin',
    env: {},
    fileExists: () => false,
    playwrightAvailable: true,
  });
  assert.equal(status.screenshotsReady, true);
  assert.equal(status.videoReady, true);
  assert.equal(status.recommendedAction, null);
});

test('planPlaywrightInstall uses system Chrome channel and skips Chromium download', () => {
  const plan = planPlaywrightInstall({
    installDir: '/data/orca/playwright',
    platform: 'darwin',
    fileExists: (p) => p.includes('Google Chrome.app'),
    preferSystemChrome: true,
  });
  assert.equal(plan.backend, 'system-chrome');
  assert.equal(plan.channel, 'chrome');
  assert.equal(plan.steps.length, 1); // only the npm install, no chromium download
  assert.match(plan.steps[0].args.join(' '), new RegExp(`playwright@${PLAYWRIGHT_VERSION}`));
  assert.ok(plan.steps[0].args.includes('--ignore-scripts'));
});

test('planPlaywrightInstall downloads Chromium when no system browser', () => {
  const plan = planPlaywrightInstall({
    installDir: '/data/orca/playwright',
    platform: 'darwin',
    fileExists: () => false,
  });
  assert.equal(plan.backend, 'download-chromium');
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].command, 'npx');
  assert.match(plan.steps[1].args.join(' '), /playwright install chromium/);
  assert.ok(plan.browsersDir);
  assert.equal(plan.steps[1].env.PLAYWRIGHT_BROWSERS_PATH, plan.browsersDir);
});

test('planPlaywrightInstall requires an absolute install dir', () => {
  assert.throws(() => planPlaywrightInstall({ installDir: 'relative/dir' }), /absolute installDir/);
});

test('runCaptureInstall refuses to execute without approval', async () => {
  const plan = planPlaywrightInstall({ installDir: '/abs/dir', platform: 'darwin', fileExists: () => false });
  let spawnCalls = 0;
  const result = await runCaptureInstall(plan, { approved: false, spawn: () => { spawnCalls++; return { code: 0 }; } });
  assert.equal(result.executed, false);
  assert.equal(result.reason, 'approval-required');
  assert.equal(spawnCalls, 0);
});

test('runCaptureInstall executes allowlisted steps in order when approved', async () => {
  const plan = planPlaywrightInstall({ installDir: '/abs/dir', platform: 'darwin', fileExists: () => false });
  const seen = [];
  const result = await runCaptureInstall(plan, {
    approved: true,
    spawn: async (command, args) => { seen.push(`${command} ${args.join(' ')}`); return { code: 0 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /^npm install playwright@/);
  assert.match(seen[1], /^npx .*playwright install chromium/);
});

test('runCaptureInstall stops at the first failing step', async () => {
  const plan = planPlaywrightInstall({ installDir: '/abs/dir', platform: 'darwin', fileExists: () => false });
  const result = await runCaptureInstall(plan, {
    approved: true,
    spawn: async () => ({ code: 1 }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failedStep);
  assert.equal(result.results.length, 1);
});

test('planPlaywrightInstall only ever invokes allowlisted binaries', () => {
  for (const fileExists of [() => true, () => false]) {
    const plan = planPlaywrightInstall({ installDir: '/abs/dir', platform: 'darwin', fileExists });
    for (const step of plan.steps) {
      assert.ok(['npm', 'npx'].includes(step.command), `unexpected binary ${step.command}`);
    }
    assert.equal(plan.approvalRequired, true);
    assert.equal(plan.mutatesMachine, true);
  }
});
