#!/usr/bin/env node
/*
 * Command Deck UI contract smoke.
 *
 * This is a stricter Codex-style design-system gate than the screenshot
 * inventory. It checks that visible controls are styled/wired, advanced debug
 * strips stay hidden by default, the top bar is not a separate colored strip,
 * and the rail/main layout does not overlap when expanded or collapsed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const base = process.env.COMMAND_DECK_BASE_URL || 'http://127.0.0.1:3000';
const token = process.env.COMMAND_DECK_API_TOKEN || '';
const artifactDir = path.resolve('artifacts', 'ui-contract');
const runSuffix = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

const WIRED_ACTIONS = new Set([
  'ackAuditEvent',
  'auditDone',
  'auditLane',
  'captureEvidence',
  'captureEvidencePreset',
  'checkPrivateAccessTarget',
  'cleanupArtifacts',
  'cleanupArtifactsRunNow',
  'clearApiToken',
  'clearEvidence',
  'copyPrivateAccessCommand',
  'createPairingCode',
  'deleteMcpTool',
  'deletePrivateAccessTarget',
  'deleteProjectQuickLink',
  'deleteProviderSecret',
  'dryRunProviderImport',
  'editMcpTool',
  'exportProviderProfiles',
  'logoutBrowserSession',
  'markAllNotificationsRead',
  'markNotificationRead',
  'pairBrowserSession',
  'refresh',
  'refreshExecutorCli',
  'refreshProviderHealth',
  'requestBrowserNotifications',
  'reinstallExecutorCli',
  'removeWorktree',
  'retryLane',
  'setApiToken',
  'setProviderSecret',
  'showArtifacts',
  'stopLane',
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
      ...(token ? { 'x-commanddeck-token': token } : {}),
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

async function staticContractChecks() {
  const [html, css, appJs] = await Promise.all([
    fs.readFile(path.resolve('public', 'index.html'), 'utf8'),
    fs.readFile(path.resolve('public', 'styles.css'), 'utf8'),
    fs.readFile(path.resolve('public', 'app.js'), 'utf8'),
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
  if (result.titleRect && result.toggleRect && result.titleRect.x < result.toggleRect.right + 8) {
    fail(`${viewport.name}/${screenName} title overlaps collapse toggle`, JSON.stringify({ title: result.titleRect, toggle: result.toggleRect }));
  }
  return result;
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
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: Boolean(viewport.isMobile),
        hasTouch: Boolean(viewport.hasTouch),
      });
      for (const route of routes) {
        const page = await context.newPage();
        const target = new URL(route.path, base);
        if (token) target.searchParams.set('apiToken', token);
        await page.goto(target.toString(), { waitUntil: 'networkidle', timeout: 20000 });
        await waitForApp(page);
        const expanded = await inspectPage(page, viewport, route.name);
        if (viewport.width > 880 && route.name === 'project') {
          await page.click('#mobile-nav-toggle');
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
});
