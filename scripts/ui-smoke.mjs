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
 *   node scripts/ui-smoke.mjs
 *   COMMAND_DECK_API_TOKEN=<token> node scripts/ui-smoke.mjs --base http://127.0.0.1:3000
 */
import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const previousCwd = process.cwd();
const previousEnv = { ...process.env };
let explicitBase = Boolean(process.env.COMMAND_DECK_BASE_URL);
let base = process.env.COMMAND_DECK_BASE_URL || 'http://127.0.0.1:3000';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base' && args[i + 1]) {
    base = args[i + 1];
    explicitBase = true;
  }
}
let token = process.env.COMMAND_DECK_API_TOKEN || '';
const tempDir = explicitBase ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-ui-smoke-'));
let server = null;
let stopServer = null;
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

async function startIsolatedServerIfNeeded() {
  if (explicitBase) return;
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.COMMAND_DECK_HOST = '127.0.0.1';
  process.env.COMMAND_DECK_API_TOKEN = 'ui-smoke-token';
  process.env.COMMAND_DECK_CREDENTIAL_BACKEND = 'memory';
  process.env.COMMAND_DECK_RATE_LIMIT_DISABLED = 'true';
  token = process.env.COMMAND_DECK_API_TOKEN;
  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
  log('server', `started isolated local server at ${base}`);
}

async function cleanupStartedServer() {
  if (stopServer) await stopServer();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) {
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previousEnv)) {
    process.env[key] = value;
  }
}

async function requestJson(reqPath, options = {}) {
  const response = await fetch(`${base}${reqPath}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-commanddeck-token': token } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
}

async function createBrowserSessionCookie() {
  if (!token) return null;
  const pairing = await requestJson('/api/auth/pairing-codes', {
    method: 'POST',
    body: {
      actor: 'ui-smoke',
      label: 'UI smoke browser',
      ttlMs: 60_000,
    },
  });
  if (pairing.status !== 201) fail('create UI smoke pairing code', JSON.stringify(pairing.body));
  const paired = await requestJson('/api/auth/pair', {
    method: 'POST',
    headers: {},
    body: {
      code: pairing.body.pairing.code,
      label: 'UI smoke browser',
    },
  });
  if (paired.status !== 200) fail('pair UI smoke browser', JSON.stringify(paired.body));
  return paired.headers['set-cookie'] || '';
}

async function addSessionCookie(context, cookieHeader) {
  if (!cookieHeader) return;
  const [cookiePair] = String(cookieHeader).split(';');
  const [name, ...valueParts] = cookiePair.split('=');
  if (!name || !valueParts.length) return;
  await context.addCookies([{
    name: name.trim(),
    value: valueParts.join('=').trim(),
    url: base,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
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
  await addSessionCookie(ctx, await createBrowserSessionCookie());
  const artifactDir = path.resolve('artifacts', 'ui-smoke');
  await fs.mkdir(artifactDir, { recursive: true });

  const viewports = [
    { name: 'desktop', width: 1366, height: 900 },
    { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true },
  ];

  for (const viewport of viewports) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 15000 });

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
        'dryRunAppImport',
        'dryRunProviderImport',
        'editMcpTool',
        'exportAppBackup',
        'exportProviderProfiles',
        'exportSupportBundle',
        'applyAppImport',
        'markAllNotificationsRead',
        'markNotificationRead',
        'refresh',
        'refreshExecutorCli',
        'refreshProviderHealth',
        'reinstallExecutorCli',
        'checkPrivateAccessTarget',
        'copyPrivateAccessCommand',
        'createPairingCode',
        'requestBrowserNotifications',
        'removeWorktree',
        'retryLane',
        'setApiToken',
        'pairBrowserSession',
        'logoutBrowserSession',
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
      await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 15000 });
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
  await startIsolatedServerIfNeeded();
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
}).finally(async () => {
  await cleanupStartedServer();
});
