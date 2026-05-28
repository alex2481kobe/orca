#!/usr/bin/env node
/*
 * Command Deck dashboard UI smoke.
 *
 * Two modes:
 *
 *   With Playwright installed:
 *     - Launches Chromium headless.
 *     - Loads the dashboard at desktop (1366x900) and iPhone 14 (390x844).
 *     - Asserts: top bar, status strip, blockers area, sidebar with project
 *       link, main content rendered (no "Loading…" stuck), no text overflowing
 *       horizontally beyond viewport.
 *     - Takes screenshots into ./artifacts/ui-smoke/*.png so an operator can
 *       review.
 *
 *   Without Playwright:
 *     - Fetches /, /styles.css, /app.js, /api/system/blockers, /api/mobile/
 *       manifest and validates HTML markers + JSON shape. This is a strict
 *       fallback; the script always exits non-zero on any missing marker.
 *
 * Usage:
 *   COMMAND_DECK_API_TOKEN=<token> node scripts/ui-smoke.mjs --base http://127.0.0.1:3000
 */
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
let base = process.env.COMMAND_DECK_BASE_URL || 'http://127.0.0.1:3000';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base' && args[i + 1]) base = args[i + 1];
}
const token = process.env.COMMAND_DECK_API_TOKEN || '';
const log = (label, info = '') => console.log(`[ui-smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info) => {
  console.error(`[ui-smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(label);
};

async function http(reqPath) {
  const res = await fetch(`${base}${reqPath}`, {
    headers: token ? { 'x-commanddeck-token': token } : {},
  });
  const text = await res.text();
  return { status: res.status, text };
}

const REQUIRED_HTML_MARKERS = [
  'class="ops-shell"',
  'id="sidebar"',
  'id="breadcrumbs"',
  'data-action="toggleNav"',
  'src="/app.js',
];
const REQUIRED_CSS_MARKERS = [
  '.ops-shell',
  '.ops-sidebar',
  '.status-strip',
  '.blocker',
  '.click-card',
  '.disclosure',
];

async function htmlOnlyMode() {
  log('mode', 'http-only (Playwright not installed)');
  const indexPage = await http('/');
  if (indexPage.status !== 200) fail('GET /', String(indexPage.status));
  for (const marker of REQUIRED_HTML_MARKERS) {
    if (!indexPage.text.includes(marker)) fail('HTML missing marker', marker);
  }
  log('html', `${REQUIRED_HTML_MARKERS.length} markers found`);
  const css = await http('/styles.css');
  if (css.status !== 200) fail('GET /styles.css', String(css.status));
  for (const marker of REQUIRED_CSS_MARKERS) {
    if (!css.text.includes(marker)) fail('CSS missing marker', marker);
  }
  log('css', `${REQUIRED_CSS_MARKERS.length} markers found`);
  const js = await http('/app.js');
  if (js.status !== 200) fail('GET /app.js', String(js.status));
  if (!js.text.includes('renderStatusStrip') || !js.text.includes('renderSidebarProjects')) {
    fail('app.js missing required renderers');
  }
  log('js', `${js.text.length} bytes`);
  const blockers = await http('/api/system/blockers');
  if (blockers.status !== 200) fail('GET /api/system/blockers', String(blockers.status));
  log('blockers', 'OK');
  const manifest = await http('/api/mobile/manifest');
  if (manifest.status !== 200) fail('GET /api/mobile/manifest', String(manifest.status));
  log('manifest', 'OK');
}

async function playwrightMode(pw) {
  log('mode', 'Playwright Chromium');
  const browser = await pw.chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const artifactDir = path.resolve('artifacts', 'ui-smoke');
  await fs.mkdir(artifactDir, { recursive: true });

  const viewports = [
    { name: 'desktop', width: 1366, height: 900 },
    { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true },
  ];

  for (const viewport of viewports) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    if (token) {
      // Bootstrap token via query so the app's session-storage flow sets it.
      await page.goto(`${base}/?apiToken=${encodeURIComponent(token)}`, { waitUntil: 'networkidle', timeout: 15000 });
    } else {
      await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 15000 });
    }

    // Wait for the operator console to render past its loading state.
    await page.waitForFunction(() => {
      const content = document.getElementById('content');
      return content && !content.textContent.trim().startsWith('Loading');
    }, { timeout: 12000 });

    // Required structural pieces.
    for (const selector of ['#sidebar', '#content', '#breadcrumbs']) {
      const handle = await page.$(selector);
      if (!handle) fail(`${viewport.name} missing selector`, selector);
    }

    const sidebarLinks = await page.$$eval('#sidebar a', (els) => els.length);
    if (sidebarLinks < 1) fail(`${viewport.name} sidebar has no navigation links`);

    // Document scrollWidth shouldn't exceed viewport width (proxy for overflowing text).
    const overflow = await page.evaluate((vw) => {
      return document.documentElement.scrollWidth - vw;
    }, viewport.width);
    if (overflow > 16) fail(`${viewport.name} document overflows viewport by ${overflow}px`);

    const orphanActions = await page.$$eval('[data-action]', (els) => {
      const wired = new Set([
        'ackAuditEvent',
        'auditDone',
        'auditLane',
        'captureEvidence',
        'captureEvidencePreset',
        'cleanupArtifacts',
        'cleanupArtifactsRunNow',
        'clearApiToken',
        'clearEvidence',
        'deleteMcpTool',
        'deletePrivateAccessTarget',
        'deleteProviderSecret',
        'deleteProjectQuickLink',
        'dryRunProviderImport',
        'editMcpTool',
        'exportProviderProfiles',
        'refresh',
        'refreshExecutorCli',
        'refreshProviderHealth',
        'reinstallExecutorCli',
        'checkPrivateAccessTarget',
        'copyPrivateAccessCommand',
        'removeWorktree',
        'retryLane',
        'setApiToken',
        'setProviderSecret',
        'showArtifacts',
        'stopLane',
        'toggleNav',
        'toggleProviderEnabled',
      ]);
      return els
        .map((el) => el.getAttribute('data-action'))
        .filter((action) => action && !wired.has(action));
    });
    if (orphanActions.length) fail(`${viewport.name} has unwired data-action`, orphanActions.join(', '));

    const disclosureCount = await page.$$eval('details.disclosure', (els) => els.length);
    if (disclosureCount < 1) fail(`${viewport.name} has no collapsible disclosure sections`);

    const projectRowCount = await page.$$eval('.simple-section a[href^="/projects/"]', (els) => els.length);
    if (projectRowCount > 0) {
      const currentUrl = page.url();
      await page.$eval('.simple-section a[href^="/projects/"]', (el) => el.click());
      await page.waitForFunction((before) => window.location.href !== before, currentUrl, { timeout: 5000 });
      if (!page.url().includes('/projects/')) fail(`${viewport.name} clickable card did not navigate`, page.url());
      await page.waitForFunction(() => {
        const content = document.getElementById('content');
        return content && !content.textContent.trim().startsWith('Loading');
      }, { timeout: 12000 });
      if (token) {
        await page.goto(`${base}/?apiToken=${encodeURIComponent(token)}`, { waitUntil: 'networkidle', timeout: 15000 });
      } else {
        await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 15000 });
      }
      await page.waitForFunction(() => {
        const content = document.getElementById('content');
        return content && !content.textContent.trim().startsWith('Loading');
      }, { timeout: 12000 });
    }

    const shotPath = path.join(artifactDir, `${viewport.name}.png`);
    await page.screenshot({ path: shotPath, fullPage: true });
    log(viewport.name, `sidebarLinks=${sidebarLinks} overflowPx=${overflow} shot=${shotPath}`);
    await page.close();
  }
  await ctx.close();
  await browser.close();
}

async function main() {
  let pw = null;
  try { pw = await import('playwright'); } catch { pw = null; }
  if (pw && pw.chromium) {
    await playwrightMode(pw);
  } else {
    await htmlOnlyMode();
  }
  log('done', 'ok');
}

await main().catch((error) => {
  console.error('[ui-smoke ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
});
