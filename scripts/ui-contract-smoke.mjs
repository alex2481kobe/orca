#!/usr/bin/env node
/*
 * Orca UI contract smoke.
 *
 * This is a stricter Codex-style design-system gate than the screenshot
 * inventory. It checks that visible controls are styled/wired, advanced debug
 * strips stay hidden by default, the top bar is not a separate colored strip,
 * and the rail/main layout does not overlap when expanded or collapsed.
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
const artifactDir = path.resolve('artifacts', 'ui-contract');
const runSuffix = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const tempDir = explicitBase ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'orca-ui-contract-'));
let server = null;
let stopServer = null;

const WIRED_ACTIONS = new Set([
  'ackAuditEvent',
  'applyAppImport',
  'archiveProject',
  'archiveSession',
  'auditDone',
  'auditLane',
  'captureEvidence',
  'captureEvidencePreset',
  'checkProjectQuickLink',
  'checkPrivateAccessTarget',
  'cleanupArtifacts',
  'cleanupArtifactsRunNow',
  'clearApiToken',
  'clearEvidence',
  'copyPhoneUrl',
  'copyPrivateAccessCommand',
  'createPairingCode',
  'connectDesktopApp',
  'copyDesktopConfig',
  'pickAttachment',
  'removeAttachment',
  'saveSessionPlan',
  'approveApproval',
  'denyApproval',
  'setupCapture',
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
  'logoutBrowserSession',
  'markAllNotificationsRead',
  'markNotificationRead',
  'pairBrowserSession',
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
  'setProviderSecret',
  'showArtifacts',
  'stopLane',
  'toggleExecutorPanel',
  'toggleNav',
  'toggleProviderEnabled',
]);

const REQUIRED_CSS_MARKERS = [
  '--bg:',
  '--panel:',
  '--sidebar-width:',
  '.app-topbar',
  'background: transparent;',
  '.ops-sidebar',
  '.sidebar-project-line:hover',
  '.sidebar-compose:hover',
  '.disclosure',
  '@media (max-width: 880px)',
];

const log = (label, info = '') => console.log(`[ui-contract] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[ui-contract FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

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
  process.env.ORCA_API_TOKEN = 'ui-contract-token';
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
      actor: 'ui-contract',
      label: 'UI contract browser',
      ttlMs: 60_000,
    },
  });
  if (pairing.status !== 201) fail('create contract pairing code', JSON.stringify(pairing.body));
  const paired = await requestJsonWithHeaders('/api/auth/pair', {
    method: 'POST',
    headers: {},
    body: {
      code: pairing.body.pairing.code,
      label: 'UI contract browser',
    },
  });
  if (paired.status !== 200) fail('pair contract browser', JSON.stringify(paired.body));
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

async function staticContractChecks() {
  const [html, css, appJs] = await Promise.all([
    fs.readFile(path.join(previousCwd, 'public', 'index.html'), 'utf8'),
    fs.readFile(path.join(previousCwd, 'public', 'styles.css'), 'utf8'),
    fs.readFile(path.join(previousCwd, 'public', 'app.js'), 'utf8'),
  ]);
  for (const marker of REQUIRED_CSS_MARKERS) {
    if (!css.includes(marker)) fail('CSS contract marker missing', marker);
  }
  if (!html.includes('class="app-topbar"')) fail('HTML shell missing app-topbar');
  if (!html.includes('class="ops-shell"')) fail('HTML shell missing ops-shell');
  if (html.includes('status-strip')) fail('debug status strip must not be in default shell HTML');

  const declaredActions = [...new Set([...appJs.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]))].sort();
  const unknown = declaredActions.filter((action) => !WIRED_ACTIONS.has(action));
  if (unknown.length) fail('declared data-action lacks contract entry', unknown.join(', '));
  for (const action of declaredActions) {
    if (!appJs.includes(`'${action}'`) && !appJs.includes(`"${action}"`)) {
      fail('declared data-action is not present in dispatch/source strings', action);
    }
  }
  log('static', `${declaredActions.length} action(s), ${REQUIRED_CSS_MARKERS.length} CSS marker(s)`);
}

async function seedContractState() {
  const project = await requestJson('/api/projects', {
    method: 'POST',
    body: {
      actor: 'ui-contract',
      approved: true,
      name: `UI Contract ${runSuffix}`,
      quickLinks: [
        { label: 'Dashboard local', url: base },
      ],
    },
  });
  if (project.status !== 201) fail('create contract project', JSON.stringify(project.body));
  const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
    method: 'POST',
    body: {
      actor: 'ui-contract',
      approved: true,
      name: 'Contract session',
      leader: 'codex',
    },
  });
  if (session.status !== 201) fail('create contract session', JSON.stringify(session.body));
  const lane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
    method: 'POST',
    body: {
      actor: 'ui-contract',
      approved: true,
      title: 'Contract lane',
      executorType: 'mock',
      taskPrompt: 'Exercise UI contract screens.',
      targetUrl: base,
    },
  });
  if (lane.status !== 201) fail('create contract lane', JSON.stringify(lane.body));
  return { project: project.body, session: session.body, lane: lane.body };
}

async function waitForApp(page) {
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && !content.textContent.trim().startsWith('Loading');
  }, { timeout: 15000 });
}

async function inspectPage(page, viewport, screenName) {
  const result = await page.evaluate((vw) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const parseAlpha = (value) => {
      const match = String(value || '').match(/rgba?\(([^)]+)\)/);
      if (!match) return 1;
      const parts = match[1].split(',').map((item) => Number.parseFloat(item.trim()));
      return parts.length >= 4 ? parts[3] : 1;
    };
    const topbar = document.querySelector('.app-topbar');
    const toggle = document.getElementById('mobile-nav-toggle');
    const title = document.getElementById('topbar-title');
    const sidebar = document.getElementById('sidebar');
    const topbarStyle = topbar ? window.getComputedStyle(topbar) : null;
    const topbarRect = topbar?.getBoundingClientRect?.() || null;
    const toggleRect = toggle?.getBoundingClientRect?.() || null;
    const titleRect = title?.getBoundingClientRect?.() || null;
    const sidebarRect = sidebar?.getBoundingClientRect?.() || null;
    const visibleButtons = Array.from(document.querySelectorAll('button')).filter(visible).map((button) => {
      const style = window.getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        text: button.textContent.trim(),
        action: button.getAttribute('data-action') || '',
        type: button.getAttribute('type') || '',
        ariaLabel: button.getAttribute('aria-label') || '',
        title: button.getAttribute('title') || '',
        disabled: button.disabled,
        borderRadius: Number.parseFloat(style.borderTopLeftRadius) || 0,
        height: rect.height,
        textDecoration: style.textDecorationLine || '',
      };
    });
    const underlinedLinks = Array.from(document.querySelectorAll('a')).filter(visible).filter((link) => {
      const style = window.getComputedStyle(link);
      return String(style.textDecorationLine || '').includes('underline');
    }).map((link) => link.textContent.trim().slice(0, 80));
    const visibleDebug = Array.from(document.querySelectorAll('.status-strip, .blockers')).filter(visible).length;
    const unstyledControls = visibleButtons.filter((button) => button.borderRadius < 6 || button.height < 28);
    const unlabeledIconButtons = visibleButtons.filter((button) =>
      !button.text &&
      !button.ariaLabel &&
      !button.title
    );
    return {
      overflowPx: document.documentElement.scrollWidth - vw,
      topbarBackground: topbarStyle?.backgroundColor || '',
      topbarBackgroundAlpha: parseAlpha(topbarStyle?.backgroundColor || ''),
      topbarBorderBottomWidth: topbarStyle?.borderBottomWidth || '',
      topbarRect: topbarRect ? { x: topbarRect.x, y: topbarRect.y, width: topbarRect.width, height: topbarRect.height } : null,
      toggleRect: toggleRect ? { x: toggleRect.x, y: toggleRect.y, width: toggleRect.width, height: toggleRect.height, right: toggleRect.right } : null,
      titleRect: titleRect ? { x: titleRect.x, y: titleRect.y, width: titleRect.width, height: titleRect.height } : null,
      sidebarRect: sidebarRect ? { x: sidebarRect.x, y: sidebarRect.y, width: sidebarRect.width, height: sidebarRect.height } : null,
      visibleDebug,
      underlinedLinks,
      unstyledControls,
      unlabeledIconButtons,
      visibleButtonCount: visibleButtons.length,
    };
  }, viewport.width);

  if (result.overflowPx > 16) fail(`${viewport.name}/${screenName} horizontal overflow`, `${result.overflowPx}px`);
  if (result.topbarBackgroundAlpha > 0.04) fail(`${viewport.name}/${screenName} top bar has separate background`, result.topbarBackground);
  if (Number.parseFloat(result.topbarBorderBottomWidth || '0') > 0) fail(`${viewport.name}/${screenName} top bar has visible separator`, result.topbarBorderBottomWidth);
  if (result.visibleDebug > 0) fail(`${viewport.name}/${screenName} default debug/status clutter visible`);
  if (result.underlinedLinks.length) fail(`${viewport.name}/${screenName} underlined visible links`, result.underlinedLinks.join(', '));
  if (result.unstyledControls.length) fail(`${viewport.name}/${screenName} unstyled visible controls`, JSON.stringify(result.unstyledControls));
  if (result.unlabeledIconButtons.length) fail(`${viewport.name}/${screenName} unlabeled icon buttons`, JSON.stringify(result.unlabeledIconButtons));
  if (viewport.width > 880 && result.sidebarRect && result.sidebarRect.y > 1) {
    fail(`${viewport.name}/${screenName} sidebar does not extend to top`, JSON.stringify(result.sidebarRect));
  }
  // The global top bar is hidden on desktop (brand + collapse now live in the
  // sidebar header, ChatGPT-style); only assert overlap when it's actually visible.
  if (result.titleRect && result.toggleRect && result.titleRect.width > 0 && result.toggleRect.width > 0
    && result.titleRect.x < result.toggleRect.right + 8) {
    fail(`${viewport.name}/${screenName} title overlaps collapse toggle`, JSON.stringify({ title: result.titleRect, toggle: result.toggleRect }));
  }
  return result;
}

async function inspectAccessGate(page, viewport, expectedRole) {
  const gate = await page.evaluate(() => {
    const text = document.body.textContent || '';
    const actions = Array.from(document.querySelectorAll('[data-action]')).map((element) => element.getAttribute('data-action') || '');
    return {
      text,
      hasQr: Boolean(document.querySelector('.qr-wrap')),
      hasPairInput: Boolean(document.getElementById('pairing-code-input')),
      hasTokenInput: Boolean(document.getElementById('api-token-input')),
      hasCreatePairing: actions.includes('createPairingCode'),
      hasProjectData: /UI Contract|Contract session|Exercise UI contract|Example Project/.test(text),
      hasWorkstationInstructions: /workstation/i.test(text),
      hasOneTimeCodeInstructions: /one-time/i.test(text),
    };
  });

  if (!gate.hasPairInput) fail(`${viewport.name}/access-gate missing pairing input`, JSON.stringify(gate));
  if (gate.hasQr) fail(`${viewport.name}/access-gate exposes QR before auth`, JSON.stringify(gate));
  if (gate.hasCreatePairing) fail(`${viewport.name}/access-gate can create pairing code before auth`, JSON.stringify(gate));
  if (gate.hasProjectData) fail(`${viewport.name}/access-gate leaks app data before auth`, JSON.stringify(gate));
  if (!gate.hasWorkstationInstructions || !gate.hasOneTimeCodeInstructions) {
    fail(`${viewport.name}/access-gate missing setup instructions`, JSON.stringify(gate));
  }
  if (expectedRole === 'client' && gate.hasTokenInput) {
    fail(`${viewport.name}/access-gate exposes token input to unpaired client`, JSON.stringify(gate));
  }
  if (expectedRole === 'workstation' && !gate.hasTokenInput) {
    fail(`${viewport.name}/access-gate missing trusted workstation token input`, JSON.stringify(gate));
  }

  const result = await inspectPage(page, viewport, `access-gate-${expectedRole}`);
  return { ...result, gate };
}

async function checkRuntimeContract(pw) {
  await fs.mkdir(artifactDir, { recursive: true });
  const seeded = await seedContractState();
  const routes = [
    { name: 'home', path: '/' },
    { name: 'settings', path: '/#system' },
    { name: 'providers', path: '/#providers' },
    { name: 'private-access', path: '/#private-access' },
    { name: 'notifications', path: '/#notifications' },
    { name: 'backup', path: '/#backup' },
    { name: 'project', path: seeded.project.route },
    { name: 'session', path: seeded.session.route },
    { name: 'lane', path: seeded.lane.route },
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
      const accessContext = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: Boolean(viewport.isMobile),
        hasTouch: Boolean(viewport.hasTouch),
      });
      const accessPage = await accessContext.newPage();
      await accessPage.goto(base, { waitUntil: 'networkidle', timeout: 20000 });
      await waitForApp(accessPage);
      const expectedRole = viewport.width <= 880 ? 'client' : 'workstation';
      const accessResult = await inspectAccessGate(accessPage, viewport, expectedRole);
      const accessScreenshotPath = path.join(artifactDir, `${viewport.name}-access-gate.png`);
      await accessPage.screenshot({ path: accessScreenshotPath, fullPage: true });
      summary.push({ viewport: viewport.name, route: `access-gate-${expectedRole}`, screenshotPath: accessScreenshotPath, result: accessResult });
      log(`${viewport.name}/access-gate-${expectedRole}`, `buttons=${accessResult.visibleButtonCount} overflow=${accessResult.overflowPx}px shot=${accessScreenshotPath}`);
      await accessPage.close();
      await accessContext.close();

      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: Boolean(viewport.isMobile),
        hasTouch: Boolean(viewport.hasTouch),
      });
      await addSessionCookie(context, sessionCookie);
      for (const route of routes) {
        const page = await context.newPage();
        const target = new URL(route.path, base);
        await page.goto(target.toString(), { waitUntil: 'networkidle', timeout: 20000 });
        await waitForApp(page);
        const expanded = await inspectPage(page, viewport, route.name);
        if (viewport.width > 880 && route.name === 'project') {
          // Desktop collapse now lives in the sidebar header (ChatGPT-style).
          await page.click('.sidebar-collapse');
          await page.waitForTimeout(120);
          const collapsed = await inspectPage(page, viewport, `${route.name}-collapsed`);
          summary.push({ viewport: viewport.name, route: `${route.name}-collapsed`, result: collapsed });
        }
        const screenshotPath = path.join(artifactDir, `${viewport.name}-${route.name}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        summary.push({ viewport: viewport.name, route: route.name, screenshotPath, result: expanded });
        log(`${viewport.name}/${route.name}`, `buttons=${expanded.visibleButtonCount} overflow=${expanded.overflowPx}px shot=${screenshotPath}`);
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const summaryPath = path.join(artifactDir, 'contract-summary.json');
  await fs.writeFile(summaryPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    base,
    summary,
  }, null, 2));
  log('summary', summaryPath);
}

async function main() {
  await startIsolatedServerIfNeeded();
  await staticContractChecks();
  let pw = null;
  try {
    pw = await import('playwright');
  } catch {
    fail('Playwright is required for smoke:ui-contract');
  }
  await checkRuntimeContract(pw);
  log('done', 'ok');
}

await main().catch((error) => {
  console.error('[ui-contract ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
}).finally(async () => {
  await cleanupStartedServer();
});
