#!/usr/bin/env node
/*
 * Orca UI inventory smoke.
 *
 * This is the product-quality gate for the Codex-style shell and route
 * inventory. It intentionally visits multiple real screens at desktop and
 * phone widths and fails on dead visible actions, route JavaScript errors, or
 * horizontal overflow.
 *
 * Usage:
 *   npm run smoke:ui-inventory
 *   ORCA_API_TOKEN=<token> ORCA_BASE_URL=http://127.0.0.1:3000 npm run smoke:ui-inventory
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const args = process.argv.slice(2);
let explicitBase = Boolean(process.env.ORCA_BASE_URL);
let base = process.env.ORCA_BASE_URL || 'http://127.0.0.1:3000';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base' && args[i + 1]) {
    base = args[i + 1];
    explicitBase = true;
  }
}
let token = process.env.ORCA_API_TOKEN || '';
const artifactDir = path.resolve('artifacts', 'ui-inventory');
const inventoryDocPath = path.resolve('docs', 'ui-inventory.md');
const runSuffix = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const tempDir = explicitBase ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'orca-ui-inventory-'));
let server = null;
let stopServer = null;

const log = (label, info = '') => console.log(`[ui-inventory] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[ui-inventory FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

const WIRED_ACTIONS = new Set([
  'ackAuditEvent',
  'applyAppImport',
  'archiveProject',
  'auditDone',
  'auditLane',
  'captureEvidence',
  'captureEvidencePreset',
  'pickAttachment',
  'removeAttachment',
  'saveSessionPlan',
  'approveApproval',
  'denyApproval',
  'setupCapture',
  'checkProjectQuickLink',
  'checkPrivateAccessTarget',
  'cleanupArtifacts',
  'cleanupArtifactsRunNow',
  'clearApiToken',
  'clearEvidence',
  'copyPrivateAccessCommand',
  'copyPhoneUrl',
  'archiveSession',
  'createPairingCode',
  'connectDesktopApp',
  'copyDesktopConfig',
  'deleteMcpTool',
  'deletePrivateAccessTarget',
  'deleteProjectQuickLink',
  'deleteProviderSecret',
  'dryRunAppImport',
  'dryRunProviderImport',
  'editMcpTool',
  'exportAppBackup',
  'exportProviderProfiles',
  'exportSupportBundle',
  'markAllNotificationsRead',
  'markNotificationRead',
  'refresh',
  'refreshExecutorCli',
  'refreshProviderHealth',
  'renameProject',
  'renameSession',
  'requestBrowserNotifications',
  'revokeBrowserSession',
  'reinstallExecutorCli',
  'removeWorktree',
  'restartLane',
  'retryLane',
  'setApiToken',
  'pairBrowserSession',
  'logoutBrowserSession',
  'setProviderSecret',
  'showArtifacts',
  'stopLane',
  'toggleExecutorPanel',
  'toggleNav',
  'toggleProviderEnabled',
  'browseWorkstation',
  'workstationOpenDir',
  'workstationUseDir',
  'workstationPickerClose',
]);

const REQUIRED_INVENTORY_SCREENS = [
  { name: 'home', path: '/', purpose: 'Default operator overview and project navigation entry.', primaryAction: 'Open a project/session.' },
  { name: 'pair', path: '/#pair', purpose: 'Pair a remote laptop/phone via QR code and one-time pairing code.', primaryAction: 'Create pairing code.' },
  { name: 'projects', path: '/#projects', purpose: 'Project list management view.', primaryAction: 'Open project.' },
  { name: 'new-project', path: '/#create', purpose: 'Create a new project.', primaryAction: 'Create project.' },
  { name: 'settings', path: '/#system', purpose: 'Global settings and system health entry.', primaryAction: 'Review effective system state.' },
  { name: 'providers', path: '/#providers', purpose: 'Provider catalog and health.', primaryAction: 'Check or configure provider.' },
  { name: 'secrets', path: '/#providers', purpose: 'Provider secret setup surface.', primaryAction: 'Set/delete provider secret reference.' },
  { name: 'mcp-tools', path: '/#mcp', purpose: 'MCP tool management.', primaryAction: 'Create or edit tool.' },
  { name: 'audit-queue', path: '/#audit', purpose: 'Audit queue and review actions.', primaryAction: 'Open or acknowledge audit.' },
  { name: 'private-access', path: '/#private-access', purpose: 'Tailscale/private mobile access setup.', primaryAction: 'Copy/check dry-run setup command.' },
  { name: 'cleanup', path: '/#cleanup', purpose: 'Artifact cleanup and schedule controls.', primaryAction: 'Run cleanup dry-run.' },
  { name: 'notifications', path: '/#notifications', purpose: 'Notification settings and unread status.', primaryAction: 'Mark notification read.' },
  { name: 'backup-support', path: '/#backup', purpose: 'Local app backup, import dry-run, and redacted support bundle.', primaryAction: 'Export app backup.' },
];

const SEEDED_INVENTORY_SCREENS = [
  { name: 'project-detail', key: 'project', purpose: 'Project details, quick links, and sessions.', primaryAction: 'Open/create session.' },
  { name: 'session-workflow', key: 'session', purpose: 'Active session workflow and lanes.', primaryAction: 'Create/open lane.' },
  { name: 'lane-detail', key: 'lane', purpose: 'Lane status, logs, evidence, and audit handoff.', primaryAction: 'Run next safe lane action.' },
];

async function verifyInventoryDoc() {
  let raw = '';
  try {
    raw = await fs.readFile(inventoryDocPath, 'utf8');
  } catch (error) {
    fail('missing UI inventory doc', `${inventoryDocPath}: ${error.message}`);
  }
  for (const marker of [
    'Required shared primitives',
    'Inventory fields required per screen',
    'Screen matrix',
    'Smoke gates',
  ]) {
    if (!raw.includes(marker)) fail('UI inventory doc missing section', marker);
  }
  for (const screen of [...REQUIRED_INVENTORY_SCREENS, ...SEEDED_INVENTORY_SCREENS]) {
    if (!raw.includes(`\`${screen.name}\``)) fail('UI inventory doc missing screen', screen.name);
  }
  log('doc', inventoryDocPath);
}

async function requestJson(reqPath, options = {}) {
  const response = await fetch(`${base}${reqPath}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-orca-token': token } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function startIsolatedServerIfNeeded() {
  if (explicitBase) return;
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = 'ui-inventory-token';
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  token = process.env.ORCA_API_TOKEN;
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

async function requestJsonWithHeaders(reqPath, options = {}) {
  const response = await fetch(`${base}${reqPath}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-orca-token': token } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
}

async function createBrowserSessionCookie() {
  if (!token) return null;
  const pairing = await requestJsonWithHeaders('/api/auth/pairing-codes', {
    method: 'POST',
    body: {
      actor: 'ui-inventory',
      label: 'UI inventory browser',
      ttlMs: 60_000,
    },
  });
  if (pairing.status !== 201) fail('create inventory pairing code', JSON.stringify(pairing.body));
  const paired = await requestJsonWithHeaders('/api/auth/pair', {
    method: 'POST',
    headers: {},
    body: {
      code: pairing.body.pairing.code,
      label: 'UI inventory browser',
    },
  });
  if (paired.status !== 200) fail('pair inventory browser', JSON.stringify(paired.body));
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

async function seedInventoryState() {
  if (!token) fail('ORCA_API_TOKEN is required for inventory seeding');
  const project = await requestJson('/api/projects', {
    method: 'POST',
    body: {
      actor: 'ui-inventory',
      approved: true,
      name: `UI Inventory ${runSuffix}`,
      quickLinks: [
        { label: 'Dashboard local', url: base },
      ],
    },
  });
  if (project.status !== 201) fail('create inventory project', JSON.stringify(project.body));

  const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
    method: 'POST',
    body: {
      actor: 'ui-inventory',
      approved: true,
      name: 'Inventory session',
      leader: 'codex',
      laneConcurrencyLimit: 2,
    },
  });
  if (session.status !== 201) fail('create inventory session', JSON.stringify(session.body));

  const lane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
    method: 'POST',
    body: {
      actor: 'ui-inventory',
      approved: true,
      title: 'Inventory lane',
      executorType: 'mock',
      taskPrompt: 'Exercise UI inventory screens without destructive actions.',
      targetUrl: base,
    },
  });
  if (lane.status !== 201) fail('create inventory lane', JSON.stringify(lane.body));

  return {
    project: project.body,
    session: session.body,
    lane: lane.body,
  };
}

async function waitForApp(page) {
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && !content.textContent.trim().startsWith('Loading');
  }, { timeout: 15000 });
}

async function checkRoute(page, viewport, screen) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const target = new URL(screen.path, base);
  await page.goto(target.toString(), {
    waitUntil: 'networkidle',
    timeout: 20000,
  });
  await waitForApp(page);

  const result = await page.evaluate((vw) => {
    const overflowPx = document.documentElement.scrollWidth - vw;
    const orphanActions = Array.from(document.querySelectorAll('[data-action]'))
      .map((el) => el.getAttribute('data-action'))
      .filter(Boolean);
    const visibleButtons = Array.from(document.querySelectorAll('button')).filter((button) => {
      const style = window.getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).map((button) => ({
      text: button.textContent.trim(),
      action: button.getAttribute('data-action') || '',
      type: button.getAttribute('type') || '',
      disabled: button.disabled,
      ariaDisabled: button.getAttribute('aria-disabled') || '',
      ariaLabel: button.getAttribute('aria-label') || '',
      title: button.getAttribute('title') || '',
      // Custom-dropdown trigger/option buttons are wired by the dropdown controller
      // (delegated listener), not data-action — exempt from the dead-button check.
      dropdown: Boolean(button.closest('.dd')),
    }));
    const visibleLinksWithoutHref = Array.from(document.querySelectorAll('a')).filter((link) => {
      const style = window.getComputedStyle(link);
      const rect = link.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        !link.getAttribute('href');
    }).map((link) => link.textContent.trim());
    const nativeControls = Array.from(document.querySelectorAll('input, select, textarea, button')).filter((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).length;
    const disclosures = document.querySelectorAll('details.disclosure, details').length;
    const sharedPrimitives = {
      topbar: Boolean(document.querySelector('.app-topbar')),
      rail: Boolean(document.querySelector('.ops-sidebar')),
      shell: Boolean(document.querySelector('.ops-shell')),
      main: Boolean(document.querySelector('.ops-main')),
      content: Boolean(document.querySelector('.ops-content')),
      rows: document.querySelectorAll('.sidebar-project-row, .sidebar-session-row, .lane-row, .simple-row').length,
      cards: document.querySelectorAll('.card, .panel, .simple-section, .project-shell, .lane-card').length,
      disclosures,
      forms: document.querySelectorAll('form').length,
    };
    const iconOnlyButtonsWithoutLabel = visibleButtons.filter((button) =>
      !button.text && !button.ariaLabel && !button.title
    );
    return {
      overflowPx,
      orphanActions,
      visibleButtons,
      visibleLinksWithoutHref,
      nativeControls,
      disclosures,
      sharedPrimitives,
      iconOnlyButtonsWithoutLabel,
      title: document.title,
      bodyText: document.body.textContent.slice(0, 2000),
    };
  }, viewport.width);

  if (!result.sharedPrimitives.topbar || !result.sharedPrimitives.rail || !result.sharedPrimitives.main || !result.sharedPrimitives.content) {
    fail(`${viewport.name}/${screen.name} missing shared shell primitive`, JSON.stringify(result.sharedPrimitives));
  }
  if (result.iconOnlyButtonsWithoutLabel.length) {
    fail(`${viewport.name}/${screen.name} icon-only buttons missing labels`, JSON.stringify(result.iconOnlyButtonsWithoutLabel));
  }
  const unwiredActions = result.orphanActions.filter((action) => !WIRED_ACTIONS.has(action));
  if (unwiredActions.length) fail(`${viewport.name}/${screen.name} unwired data-action`, [...new Set(unwiredActions)].join(', '));
  const deadButtons = result.visibleButtons.filter((button) => {
    if (button.dropdown) return false; // wired via the dropdown controller
    if (button.disabled || button.ariaDisabled === 'true') return !button.title;
    if (button.action) return !WIRED_ACTIONS.has(button.action);
    return button.type !== 'submit';
  });
  if (deadButtons.length) fail(`${viewport.name}/${screen.name} dead buttons`, JSON.stringify(deadButtons));
  if (result.visibleLinksWithoutHref.length) fail(`${viewport.name}/${screen.name} visible links without href`, result.visibleLinksWithoutHref.join(', '));
  if (result.overflowPx > 16) fail(`${viewport.name}/${screen.name} horizontal overflow`, `${result.overflowPx}px`);
  if (errors.length) fail(`${viewport.name}/${screen.name} route errors`, errors.join(' | '));

  const screenshotPath = path.join(artifactDir, `${viewport.name}-${screen.name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return {
    screen: screen.name,
    viewport: viewport.name,
    path: screen.path,
    purpose: screen.purpose,
    primaryAction: screen.primaryAction,
    sharedPrimitives: result.sharedPrimitives,
    visibleButtonCount: result.visibleButtons.length,
    deadActionScan: 'passed',
    accessibleLabelScan: 'passed',
    focusSmoke: 'visible controls scanned for labels; full keyboard traversal covered by smoke:ui-contract',
    overflowPx: result.overflowPx,
    nativeControls: result.nativeControls,
    disclosures: result.disclosures,
    screenshotPath,
  };
}

async function main() {
  await startIsolatedServerIfNeeded();
  await verifyInventoryDoc();
  let pw = null;
  try {
    pw = await import('playwright');
  } catch {
    fail('Playwright is required for smoke:ui-inventory');
  }
  await fs.mkdir(artifactDir, { recursive: true });
  const seeded = await seedInventoryState();
  const screens = [
    ...REQUIRED_INVENTORY_SCREENS,
    ...SEEDED_INVENTORY_SCREENS.map((screen) => ({
      ...screen,
      path: seeded[screen.key].route,
    })),
  ];
  const viewports = [
    { name: 'desktop', width: 1366, height: 900 },
    { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true },
  ];

  const browser = await pw.chromium.launch({ headless: true });
  const summary = [];
  const sessionCookie = await createBrowserSessionCookie();
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: Boolean(viewport.isMobile),
        hasTouch: Boolean(viewport.hasTouch),
      });
      await addSessionCookie(context, sessionCookie);
      for (const screen of screens) {
        const page = await context.newPage();
        const item = await checkRoute(page, viewport, screen);
        summary.push(item);
        await page.close();
        log(`${viewport.name}/${screen.name}`, `overflow=${item.overflowPx}px shot=${item.screenshotPath}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const summaryPath = path.join(artifactDir, 'inventory-summary.json');
  await fs.writeFile(summaryPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    base,
    screens: summary,
  }, null, 2));
  log('summary', summaryPath);
  log('done', `${summary.length} screenshots`);
}

await main().catch((error) => {
  console.error('[ui-inventory ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
}).finally(async () => {
  await cleanupStartedServer();
});
