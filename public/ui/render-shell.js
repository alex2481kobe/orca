// Render view module (split from render-views.js).

import { isWorkstation, isMobileApp, isLocalHostName, isIosWeb, writeHtml, installToHomeHint } from './dom.js';
import { activeWorkstationUrl, workstationLabel, pendingWorkstationUrl } from './workstations.js';

// The installed app, launched but not yet pointed at a workstation, lives at its
// own bundled origin (tauri://localhost) where there is no server. Detect that so
// we show a dedicated "Connect to your workstation" screen instead of the empty
// workstation home. Once connected the webview navigates to the tailnet origin
// (no __TAURI__ there), so this is false from then on.
function isUnconnectedMobileApp() {
  return isMobileApp() && isLocalHostName(window.location.hostname);
}

// Dedicated first-run screen for the mobile app: brand + "connect to your
// workstation" with the REMOTE-device instructions (how to point it at the Mac),
// not the workstation's "pair a remote device" instructions.
function renderMobileConnect() {
  // A QR scan (orca:// deep link) stores the workstation URL here so the input is
  // pre-filled with the right tailnet address — the user just taps Connect.
  const pendingWs = pendingWorkstationUrl();
  return `
    <section class="connect-shell">
      <div class="connect-brand">
        <img class="connect-logo" src="/orca-mark.png" alt="" width="40" height="40" />
        <span class="connect-wordmark">Orca</span>
      </div>
      <h1 class="connect-title">Connect to your workstation</h1>
      <p class="connect-sub">Orca runs your agents on your computer. Point this app at it to start your journey.</p>
      <div class="connect-card">
        <label class="connect-label" for="workstation-url-input">Workstation URL</label>
        <input id="workstation-url-input" class="connect-input" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="your-mac.your-tailnet.ts.net" value="${safeAttr(pendingWs)}" />
        <button class="connect-go" data-action="connectWorkstation" type="button">Connect</button>
        ${renderWorkstationList({ heading: 'Recent workstations' })}
      </div>
      <p class="connect-scan">Or scan the QR code from your Mac (<strong>Orca → Settings → Pair a remote device</strong>) with this phone's Camera.</p>
      <div class="connect-note">
        <span class="connect-note-icon" aria-hidden="true">⛭</span>
        <span>Make sure this phone and your Mac are signed in to the <strong>same Tailscale account</strong>.</span>
      </div>
      <details class="disclosure connect-help">
        <summary><span>Where do I find the URL?</span></summary>
        <div class="disclosure-body">On your Mac, open Orca → Settings → <strong>Pair a remote device</strong>. It shows your private Tailscale URL (e.g. <code>your-mac.your-tailnet.ts.net</code>) and a QR code. Type the URL above or scan the code. After connecting, you'll enter a one-time pairing code.</div>
      </details>
    </section>`;
}

// Minimal Settings reachable on the unconnected mobile app — so you can still set
// the theme (light/dark/system) before pairing. Everything else needs a connected
// workstation, so we show only Appearance plus a way back to the connect screen.
function renderMobileDisconnectedSettings() {
  return `
    <section class="connect-shell connect-settings">
      <div class="connect-brand">
        <img class="connect-logo" src="/orca-mark.png" alt="" width="36" height="36" />
        <span class="connect-wordmark">Settings</span>
      </div>
      ${renderAppearancePanel()}
      <article class="card control-card">
        <h3>Workstations</h3>
        <p class="muted">Not connected yet. Pick a saved workstation or add one — the rest of Settings unlocks once this app is paired.</p>
        ${renderWorkstationList({ heading: 'Saved workstations' })}
        <label class="connect-label" for="workstation-url-input">Workstation URL</label>
        <input id="workstation-url-input" class="connect-input" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="your-mac.your-tailnet.ts.net" />
        <button class="connect-go" data-action="connectWorkstation" type="button">Connect</button>
      </article>
    </section>`;
}

// App Store download badge (Apple-style) shown to iOS users on the WEB client,
// nudging them to the native app. Mock link until the App Store listing is live.
const APP_STORE_URL = 'https://apps.apple.com/app/orca/id000000000';
function renderIosAppPromo() {
  if (!isIosWeb()) return '';
  return `
    <section class="ios-promo">
      <div class="ios-promo-body">
        <strong>Orca for iPhone</strong>
        <span>Get the native app — faster, full-screen, opens from your Home Screen.</span>
        <div class="ios-promo-cta">
        <img class="ios-promo-icon" src="/icon-512.png" alt="Orca" width="44" height="44" />
        <a class="appstore-badge" href="${APP_STORE_URL}" target="_blank" rel="noopener noreferrer" aria-label="Download Orca on the App Store">
        <svg viewBox="0 0 120 40" width="135" height="45" role="img" aria-hidden="true">
          <rect x="0.5" y="0.5" width="119" height="39" rx="7" fill="#000" stroke="#a6a6a6"/>
          <path fill="#fff" d="M24.77 20.3c-.02-2.35 1.92-3.48 2-3.53-1.09-1.6-2.79-1.82-3.4-1.84-1.43-.15-2.81.85-3.54.85-.74 0-1.86-.84-3.06-.81-1.55.02-2.99.91-3.79 2.31-1.64 2.84-.42 7.02 1.15 9.32.78 1.13 1.7 2.39 2.9 2.34 1.17-.05 1.61-.75 3.02-.75 1.4 0 1.8.75 3.03.73 1.25-.02 2.04-1.14 2.8-2.27.91-1.3 1.28-2.57 1.29-2.64-.03-.01-2.46-.94-2.49-3.74zM22.45 12.4c.65-.79 1.09-1.88.97-2.98-.94.04-2.07.63-2.74 1.4-.6.69-1.13 1.79-.99 2.85 1.05.08 2.12-.53 2.76-1.27z"/>
          <text x="34" y="15.5" fill="#fff" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="7">Download on the</text>
          <text x="34" y="30" fill="#fff" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="15" font-weight="600">App Store</text>
        </svg>
        </a>
        </div>
      </div>
    </section>`;
}
import { refs, shell, makeDraftSession } from './state.js';
import { safeAttr, safeText } from './format.js';
import { api, browserAccessBlocked, setApiToken } from './api.js';
import { activeHomePanel, computeUnreadSessions, isLiveLaneState, isRunningLaneState, isSettingsHomePanel, isVerificationProject, renderBreadcrumbs, renderTopbarTitle } from './render-helpers.js';
import { renderHome } from './render-home.js';
import { renderAppearancePanel, renderWorkstationList } from './render-home-panels.js';
import { renderWorkstationPickerPanel } from './render-project.js';
import { loadEvidenceGallery, renderAuditLog, renderLane } from './render-lane.js';
import { renderSession } from './render-session.js';
import { restoreContentUiState } from './render-fragments.js';
import { subscribeLaneStream, unsubscribeLaneStream, fillLaneStream } from './lane-stream.js';
import { enhanceSelects } from './dropdown.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES } from './constants.js';
import { orderItems, readSidebarOrder, isProjectExpanded } from './sidebar.js';
import { icon, COMPOSE_ICON, FOLDER_ICON, ARCHIVE_ICON } from './icons.js';

const SETTINGS_NAV_GROUPS = [
  ['Control', [
    ['system', 'General'],
    ['agents', 'Agents'],
    ['supervisor', 'Supervisor'],
  ]],
  ['Integrations', [
    ['mcp', 'MCP'],
    ['providers', 'Providers'],
  ]],
  ['System', [
    ['access', 'Access'],
    ['operations', 'Operations'],
  ]],
];

// Mobile pairing gate — the same clean connect-shell look as the unconnected app
// (renderMobileConnect), but for a device that's ALREADY reached the workstation
// URL (a phone browser, or the app after it navigated to the tailnet origin) and
// just needs the one-time code. Keeps web and app visually consistent.
function renderMobilePairGate(browserLabel, homeHint) {
  // This device has ALREADY reached a workstation origin (scanned QR, tapped a
  // recent, or typed the URL) — so step 1 is DONE. We show it connected (green
  // check + host) and focus the user on the only remaining step: the pairing code.
  const activeUrl = activeWorkstationUrl();
  const activeHost = activeUrl ? workstationLabel(activeUrl) : (typeof window !== 'undefined' ? window.location.host : '');
  return `
    <section class="connect-shell connect-gate">
      ${renderIosAppPromo()}
      <div class="connect-brand">
        <img class="connect-logo" src="/orca-mark.png" alt="" width="40" height="40" />
        <span class="connect-wordmark">Orca</span>
      </div>
      <h1 class="connect-title">Pair this device</h1>
      <p class="connect-sub">You're connected to your workstation. Enter the one-time pairing code to finish — no data is shown until this device is paired.</p>
      <ol class="connect-steps">
        <li class="connect-step is-done">
          <span class="connect-step-mark" aria-hidden="true">✓</span>
          <div class="connect-step-body">
            <strong>Connected to workstation</strong>
            <span class="connect-step-host">${safeText(activeHost)}</span>
          </div>
        </li>
        <li class="connect-step is-active">
          <span class="connect-step-mark" aria-hidden="true">2</span>
          <div class="connect-step-body">
            <strong>Enter the pairing code</strong>
            <span class="connect-step-hint">From your Mac: Orca → Settings → Pair a remote device.</span>
          </div>
        </li>
      </ol>
      <div class="connect-card">
        <label class="connect-label" for="pairing-code-input">Pairing code</label>
        <input id="pairing-code-input" class="connect-input" autocomplete="one-time-code" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX" />
        <label class="connect-label" for="pairing-label-input">Device label</label>
        <input id="pairing-label-input" class="connect-input" value="${safeAttr(browserLabel)}" />
        <button class="connect-go" data-action="pairBrowserSession" type="button">Pair device</button>
      </div>
      <details class="disclosure connect-help" data-uikey="switch-workstation">
        <summary><span>Switch workstation</span></summary>
        <div class="disclosure-body">
          ${renderWorkstationList({ heading: 'Your workstations' })}
          <label class="connect-label" for="workstation-url-input">Connect to a different workstation</label>
          <input id="workstation-url-input" class="connect-input" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="your-mac.your-tailnet.ts.net" />
          <button class="secondary" data-action="connectWorkstation" type="button">Connect</button>
        </div>
      </details>
      ${homeHint ? `<p class="connect-scan">After pairing, add Orca to your Home Screen so it opens like an app: ${safeText(homeHint)}</p>` : ''}
    </section>`;
}

export function renderAccessGate() {
  const narrowClient = window.matchMedia('(max-width: 880px)').matches;
  const workstationAdmin = isWorkstation() && !narrowClient;
  const browserLabel = narrowClient ? 'phone browser' : 'laptop browser';
  // Instruction tailored to the browser THIS device is on (null once installed).
  const homeHint = installToHomeHint();
  if (!workstationAdmin) {
    const isDesktopAppEarly = typeof window !== 'undefined' && Boolean(window.__TAURI__);
    // Phone-sized clients that already reached the workstation URL (mobile browser,
    // or the app at the tailnet origin) get the clean connect-shell pairing screen,
    // matching the app's design. The desktop app / laptop keep the URL + steps card.
    if (narrowClient && !isDesktopAppEarly) {
      writeHtml(refs.content, renderMobilePairGate(browserLabel, homeHint));
      return;
    }
    // The "Connect to a workstation" URL step is only for the DOWNLOADED desktop
    // app (Tauri) or a desktop laptop — never a phone (a mobile browser already
    // opened the workstation URL to get here, so it just needs the pairing code).
    const isDesktopApp = typeof window !== 'undefined' && Boolean(window.__TAURI__);
    const showConnect = isDesktopApp || !narrowClient;
    let connectCard = '';
    if (showConnect) {
      connectCard = `
          <section class="gate-section">
            <div class="card-kicker">Using the Orca app on this device</div>
            <h3>Connect to your workstation</h3>
            <p>Installed the Orca app on this laptop or computer? Point it at your workstation over Tailscale — both devices just need to be on the same tailnet. (You can also open the workstation URL in a browser if you prefer.)</p>
            <div class="gate-form">
              <label>Workstation URL
                <input id="workstation-url-input" inputmode="url" placeholder="http://your-mac.your-tailnet.ts.net" />
              </label>
              <div class="lane-row">
                <button class="btn" data-action="connectWorkstation" type="button">Connect</button>
              </div>
              ${renderWorkstationList({ heading: 'Recent workstations' })}
            </div>
          </section>`;
    }
    writeHtml(refs.content, `
      <section class="project-shell">
        <article class="card control-card auth-gate">
          ${renderIosAppPromo()}
          ${connectCard}
          <section class="gate-section">
            <div class="card-kicker">Pair this device</div>
            <h3>Enter the code from your workstation</h3>
            <p>No dashboard data is shown until this device is paired. On the trusted workstation, open Settings → Access and paired devices, create a one-time code, then enter it below.</p>
            <div class="setup-steps">
              <div class="setup-step ok">
                <span>1</span>
                <div><strong>Stay on the same tailnet</strong><small>This URL is private to devices allowed by your Tailscale ACLs.</small></div>
              </div>
              <div class="setup-step warn">
                <span>2</span>
                <div><strong>Get a one-time code</strong><small>The code is generated only from an already-authenticated workstation/admin browser.</small></div>
              </div>
              <div class="setup-step warn">
                <span>3</span>
                <div><strong>Pair this browser</strong><small>Each browser on this device keeps its own session.</small></div>
              </div>
              ${homeHint ? `<div class="setup-step">
                <span>4</span>
                <div><strong>Add Orca to your Home Screen</strong><small>After pairing, open Orca like an app: ${safeText(homeHint)}</small></div>
              </div>` : ''}
            </div>
            <div class="gate-form">
              <label>Pairing code
                <input id="pairing-code-input" autocomplete="one-time-code" placeholder="XXXX-XXXX-XXXX" />
              </label>
              <label>Device label
                <input id="pairing-label-input" value="${safeAttr(browserLabel)}" />
              </label>
              <div class="lane-row">
                <button data-action="pairBrowserSession" type="button">Pair device</button>
              </div>
            </div>
          </section>
        </article>
      </section>
    `);
    return;
  }
  writeHtml(refs.content, `
    <section class="project-shell">
      <article class="card control-card auth-gate">
        <section class="gate-section">
          <div class="card-kicker">Workstation admin</div>
          <h3>Unlock setup and pairing</h3>
          <p>Enter the server API token only on a trusted workstation/admin browser. After unlock, Settings shows QR setup, HTTP/HTTPS preference, paired devices, revocation, and one-time pairing codes for phone or laptop browsers.</p>
          <div class="gate-form">
            <label>API token
              <input id="api-token-input" type="password" autocomplete="off" placeholder="Paste token" />
            </label>
            <div class="lane-row">
              <button data-action="setApiToken" type="button">Connect</button>
              <button class="secondary" data-action="clearApiToken" type="button">Clear</button>
            </div>
          </div>
        </section>
        <section class="gate-section">
          <div class="card-kicker">Already have a code?</div>
          <h3>Use a pairing code instead</h3>
          <p>If another trusted browser already generated a one-time code, enter it here to create a browser session cookie.</p>
          <div class="gate-form">
            <label>Pairing code
              <input id="pairing-code-input" autocomplete="one-time-code" placeholder="XXXX-XXXX-XXXX" />
            </label>
            <label>Browser label
              <input id="pairing-label-input" value="workstation browser" />
            </label>
            <div class="lane-row">
              <button data-action="pairBrowserSession" type="button">Pair browser</button>
            </div>
          </div>
        </section>
      </article>
    </section>
  `);
}

// The new-project folder picker renders as a modal overlay (Codex-style: clicking
// "New project" brings up the folder picker directly, not a form page).
function renderPickerModal() {
  if (!refs.pickerOverlay) return;
  const picker = shell.workstationPicker;
  if (!picker || !picker.open || picker.mode !== 'project') {
    writeHtml(refs.pickerOverlay, '');
    return;
  }
  writeHtml(refs.pickerOverlay, `
    <div class="modal-overlay picker-overlay">
      <div class="picker-modal">
        ${renderWorkstationPickerPanel('__project__')}
      </div>
    </div>`);
}

// Calm full-content screen when the Orca server can't be reached (e.g. it isn't
// running, or a remote device can't reach the workstation). Replaces the degraded
// "empty/scrunched shell" with an intentional message; the poll auto-reconnects.
function renderServerUnreachable() {
  const remote = !isWorkstation();
  const sub = remote
    ? 'Can’t reach your workstation. Make sure Orca is running on your Mac and this device is on the same Tailscale network — this page reconnects on its own.'
    : 'The local server isn’t responding. Start it and this page reconnects on its own.';
  const startBlock = remote
    ? ''
    : `<div class="connect-start">
         <div class="tiny muted">In the Orca project folder, run:</div>
         <code class="copy-url">npm start</code>
       </div>`;
  return `
    <section class="home-welcome">
      <div class="home-hero">
        <img class="home-hero-logo" src="/orca-mark.png" alt="" width="56" height="56" />
        <h1 class="home-hero-title">Orca isn’t running</h1>
        <p class="home-hero-sub">${sub}</p>
        ${startBlock}
        <div class="tiny muted server-reconnect"><span class="chat-spinner" aria-hidden="true"></span> Waiting for the server…</div>
      </div>
    </section>`;
}

export function render(uiState = null) {
  const project = shell.projects.find((value) => value.slug === shell.route.projectSlug || value.id === shell.route.projectSlug);
  const sessions = project ? shell.sessions : [];
  let session = sessions.find((value) => value.id === shell.route.sessionId)
    || (shell.draftSessions ? shell.draftSessions[shell.route.sessionId] : null);
  // Reload landed on a draft route whose in-memory draft is gone: re-mint a fresh
  // empty draft for the project so the user gets an empty chat (still unsaved)
  // rather than a dead route — an untouched chat simply doesn't survive a reload.
  if (!session && project && String(shell.route.sessionId || '').startsWith('draft-')) {
    session = makeDraftSession(project);
    shell.draftSessions = shell.draftSessions || {};
    shell.draftSessions[session.id] = session;
  }
  const lane = shell.lanes.find((value) => value.id === shell.route.laneId);
  const homePanel = activeHomePanel();
  const settingsMode = isSettingsHomePanel(homePanel);
  document.body.classList.toggle('settings-sidebar-mode', settingsMode);
  if (!settingsMode) {
    shell.lastWorkspaceHref = `${window.location.pathname || '/'}${window.location.search || ''}${window.location.hash || ''}` || '/';
  }

  renderBreadcrumbs(project, session);
  renderTopbarTitle(project, session, lane);
  renderStatusStrip();
  renderBlockers();
  renderPickerModal();
  if (refs.content) refs.content.setAttribute('aria-busy', 'false');
  // Server can't be reached (not running / workstation offline) → calm takeover
  // instead of a degraded shell. Takes precedence over the auth/connect gates,
  // which derive from now-stale auth state. The poll keeps retrying and this
  // clears automatically once the server responds.
  if (shell.serverUnreachable) {
    unsubscribeLaneStream();
    renderSidebarProjects(project);
    if (refs.topbarTitle) refs.topbarTitle.textContent = 'Orca';
    writeHtml(refs.content, renderServerUnreachable());
    restoreContentUiState(uiState);
    return;
  }
  // Installed app not yet pointed at a workstation → dedicated connect screen.
  // Settings (#system) still works while disconnected so the theme is adjustable
  // before pairing; every other route shows the connect screen.
  if (isUnconnectedMobileApp()) {
    unsubscribeLaneStream();
    renderSidebarProjects();
    const onSettings = activeHomePanel() === 'system';
    if (refs.topbarTitle) refs.topbarTitle.textContent = onSettings ? 'Settings' : 'Orca';
    writeHtml(refs.content, onSettings ? renderMobileDisconnectedSettings() : renderMobileConnect());
    restoreContentUiState(uiState);
    return;
  }
  if (browserAccessBlocked()) {
    unsubscribeLaneStream();
    renderSidebarProjects();
    if (refs.topbarTitle) refs.topbarTitle.textContent = 'Orca';
    renderAccessGate();
    // Was missing: without this, every background poll re-rendered the access /
    // pairing gate and wiped half-typed inputs (e.g. the pairing code) and any
    // open disclosures — the "opens then auto-closes" bug on the pairing screen.
    restoreContentUiState(uiState);
    return;
  }
  renderSidebarProjects(project);
  if (!project) {
    renderHome();
  } else if (!session) {
    // Codex-style: opening a project drops straight into a NEW chat (the empty
    // composer), not a create-session form. Reuse one stable draft per project so
    // background polls don't spawn duplicates or reset what's being typed.
    shell.draftSessions = shell.draftSessions || {};
    let draft = Object.values(shell.draftSessions).find((d) => d && d.projectId === project.id);
    if (!draft) { draft = makeDraftSession(project); shell.draftSessions[draft.id] = draft; }
    renderSession(project, draft);
  } else if (shell.route.laneId) {
    writeHtml(refs.content, renderLane(project, session, lane));
    if (lane) loadEvidenceGallery(lane.id);
  } else {
    renderSession(project, session);
  }
  renderAuditLog();
  updatePairLabel();
  restoreContentUiState(uiState);
  enhanceSelects(refs.content);
  // Live terminal stream: subscribe ONLY for the open lane-detail view (the focused
  // lane), and re-fill the mount from the buffer after this (re)render rebuilt it.
  // Any other view tears the stream down so at most one lane streams at a time.
  if (shell.route.laneId && lane) {
    subscribeLaneStream(lane.id);
    fillLaneStream(lane.id);
  } else {
    unsubscribeLaneStream();
  }
}

// Reflect paired-device state on the sidebar link: "Pair a device" when none are
// paired, "Paired devices · N" once one or more are (clicking still opens the
// pairing view, where you generate codes to pair more / revoke existing).
function updatePairLabel() {
  const label = document.querySelector('.sidebar-pair-label');
  if (!label) return;
  const section = label.closest('.sidebar-pair-section');
  // Pairing is a WORKSTATION-only concern. On a paired remote device (not the
  // local workstation) hide the whole pairing affordance entirely.
  const onWorkstation = isWorkstation();
  if (section) section.hidden = !onWorkstation;
  if (!onWorkstation) return;
  // Count only real paired REMOTE devices — never the local workstation browser.
  // While the session list is still loading (null), leave the existing label in
  // place rather than flashing "Pair a remote device" before the count arrives.
  if (!Array.isArray(shell.authSessions)) return;
  const n = shell.authSessions.filter((s) => s && (s.paired || s.pairedFromId) && s.active !== false).length;
  // Consistent wording: always "Pair a remote device" until a device is paired,
  // then "Paired devices · N" (no flicker between the two phrasings on refresh).
  label.textContent = n > 0 ? `Paired devices · ${n}` : 'Pair a remote device';
  const link = label.closest('.sidebar-pair-button');
  if (link) link.setAttribute('aria-label', n > 0 ? `${n} paired device${n === 1 ? '' : 's'} — pair another` : 'Pair a remote device');
}

export function renderStatusStrip() {
  if (!refs.statusStrip) return;
  const profiles = shell.executorProfiles || {};
  const cli = shell.executorCliInfo || {};
  const tokenTag = shell.apiToken
    ? '<span class="tag ok" data-status="token">token: set</span>'
    : '<span class="tag warn" data-status="token">token: unset</span>';
  // Status tags for every first-class CLI executor we actually know about
  // (codex, claude, gemini-cli, composer-cli, …) rather than a fixed pair.
  const statusExecutorTypes = FIRST_CLASS_CLI_EXECUTOR_TYPES.filter((type) => cli[type] || profiles[type]);
  const executorTags = (statusExecutorTypes.length ? statusExecutorTypes : [...FIRST_CLASS_CLI_EXECUTOR_TYPES]).map((type) => {
    const info = cli[type];
    if (!info) return '';
    const tone = info.binaryExists ? 'ok' : 'bad';
    const label = info.binaryExists ? `${type}: ${info.version || 'ready'}` : `${type}: missing`;
    return `<span class="tag ${tone}" data-status="executor-${type}">${safeText(label)}</span>`;
  }).join('');
  const scheduler = shell.cleanupSchedule || {};
  const schedTag = scheduler.enabled
    ? `<span class="tag ok" data-status="scheduler">cleanup: every ${safeText(String(scheduler.intervalHours))}h</span>`
    : '<span class="tag warn" data-status="scheduler">cleanup: off</span>';
  const lanes = shell.lanes || [];
  const running = lanes.filter((lane) => isRunningLaneState(lane.state)).length;
  const failed = lanes.filter((lane) => lane.state === 'failed').length;
  const auditCount = (shell.pendingAuditEvents || []).length;
  const blockerCount = (shell.systemBlockers || []).filter((b) => b.severity === 'error').length;
  writeHtml(refs.statusStrip, [
    tokenTag,
    executorTags,
    schedTag,
    `<span class="tag" data-status="lanes">${running} running · ${failed} failed</span>`,
    `<span class="tag ${auditCount > 0 ? 'warn' : ''}" data-status="audit">${auditCount} pending audits</span>`,
    blockerCount ? `<span class="tag bad" data-status="blockers">${blockerCount} blockers</span>` : '',
  ].filter(Boolean).join(''));
}

export function renderBlockers() {
  if (!refs.blockers) return;
  const blockers = shell.systemBlockers || [];
  if (!blockers.length) {
    writeHtml(refs.blockers, '');
    return;
  }
  writeHtml(refs.blockers, blockers.map((blocker) => `
    <div class="blocker ${blocker.severity === 'warn' ? 'warn' : ''}" role="alertdialog">
      <strong>${safeText(blocker.summary)}</strong>
      <div class="tiny">${safeText(blocker.detail)}</div>
      <div class="tiny">Remediation: <code>${safeText(blocker.remediation)}</code></div>
    </div>
  `).join(''));
}

export function renderSidebarProjects(activeProject) {
  if (!refs.sidebarProjects) return;
  const panel = activeHomePanel();
  const settingsMode = isSettingsHomePanel(panel);
  document.body.classList.toggle('settings-sidebar-mode', settingsMode);
  const title = document.querySelector('.sidebar-title');
  if (title) title.textContent = settingsMode ? 'Settings' : 'Projects';
  if (isUnconnectedMobileApp()) {
    writeHtml(refs.sidebarProjects, `
      <div class="tiny muted">Not connected to a workstation yet.</div>
    `);
    return;
  }
  if (browserAccessBlocked()) {
    writeHtml(refs.sidebarProjects, `
      <div class="tiny muted">Not connected to a workstation yet.</div>
    `);
    return;
  }
  if (settingsMode) {
    const rows = SETTINGS_NAV_GROUPS.map(([group, items]) => `
      <div class="settings-nav-group">
        <div class="settings-nav-section-title">${safeText(group)}</div>
        ${items.map(([key, label]) => `
          <div class="sidebar-project-line settings-nav-line">
            <a class="sidebar-project settings-nav-project ${panel === key ? 'active' : ''}" href="/#${safeAttr(key)}" data-route="${safeAttr(key)}">
              <span class="sidebar-folder" aria-hidden="true"></span>
              <span class="sidebar-project-label">
                <span class="sidebar-project-name">${safeText(label)}</span>
              </span>
            </a>
          </div>
        `).join('')}
      </div>
    `).join('');
    writeHtml(refs.sidebarProjects, rows);
    return;
  }
  const projects = shell.projects || [];
  if (!projects.length) {
    writeHtml(refs.sidebarProjects, `
      <button class="sidebar-link sidebar-create-project" data-action="newProject" type="button">
        <span class="row-icon" aria-hidden="true">+</span>
        <span>New project</span>
      </button>
      <div class="tiny muted">No projects yet.</div>
    `);
    return;
  }
  const storedOrder = readSidebarOrder();
  const archiveIcon = ARCHIVE_ICON;
  // Sessions with finished, unseen agent activity get a blue "unread" dot.
  const unreadSessions = computeUnreadSessions(shell.sessions || [], shell.lanes || [], shell.route?.sessionId);
  const renderSidebarProject = (project) => {
    const projectSessions = orderItems(
      (shell.sessions || []).filter((session) => session.projectId === project.id),
      storedOrder.sessions[project.id] || [],
    );
    const lanes = (shell.lanes || []).filter((lane) => lane.projectId === project.id);
    const active = lanes.filter((lane) => isLiveLaneState(lane.state)).length;
    const isActiveProject = shell.route.projectSlug === project.slug || shell.route.projectSlug === project.id;
    const expanded = isProjectExpanded(project.id, isActiveProject);
    // Icons (rename + archive) live on SESSIONS only; the project row is just a
    // folder + name that expands/collapses its sessions.
    const sessionRows = projectSessions.slice(0, 12).map((session) => {
      const isCurrentSession = shell.route.sessionId === session.id;
      return `
        <div class="sidebar-session-line" draggable="true" data-reorder-kind="session" data-project-id="${safeAttr(project.id)}" data-session-id="${safeAttr(session.id)}">
          <a class="sidebar-thread ${isCurrentSession ? 'active' : ''}" href="${safeAttr(session.route)}">
            <span>${safeText(session.name)}</span>
          </a>
          <button class="sidebar-menu-btn" type="button" data-action="openSessionMenu" data-menu="session" data-session-id="${safeAttr(session.id)}" data-session-name="${safeAttr(session.name)}" aria-haspopup="menu" aria-label="Menu for ${safeAttr(session.name)}" title="More">
            ${icon('more', { size: 16 })}
          </button>
          <button class="sidebar-archive" type="button" data-action="archiveSession" data-session-id="${safeAttr(session.id)}" data-session-name="${safeAttr(session.name)}" aria-label="Archive ${safeAttr(session.name)} session" title="Archive session">
            ${archiveIcon}
          </button>
          ${unreadSessions.has(session.id) ? '<span class="session-unread-dot" title="New activity — open to view" aria-label="Unread activity"></span>' : ''}
        </div>
      `;
    }).join('');
    return `
      <div class="sidebar-project-group ${expanded ? 'expanded' : 'collapsed'}" draggable="true" data-reorder-kind="project" data-project-id="${safeAttr(project.id)}">
        <div class="sidebar-project-line">
          <a class="sidebar-project ${isActiveProject ? 'active' : ''}" href="${safeAttr(project.route)}" data-route-project="${safeAttr(project.slug)}" data-project-id="${safeAttr(project.id)}" data-project-toggle="1">
            ${FOLDER_ICON}
            <span class="sidebar-project-label"><span class="sidebar-project-name">${safeText(project.name)}</span>${active ? `<span class="pill" title="${active} active lanes">(${active})</span>` : ''}</span>
          </a>
          <button class="sidebar-menu-btn" type="button" data-action="openProjectMenu" data-menu="project" data-project-id="${safeAttr(project.id)}" data-project-name="${safeAttr(project.name)}" aria-haspopup="menu" aria-label="Menu for ${safeAttr(project.name)}" title="More">${icon('more', { size: 16 })}</button>
          <button class="sidebar-project-new" data-action="newSession" data-project-id="${safeAttr(project.id)}" aria-label="New session in ${safeAttr(project.name)}" title="New session" type="button">${COMPOSE_ICON}</button>
        </div>
        <div class="sidebar-sessions">
          ${sessionRows}
        </div>
      </div>
    `;
  };
  const primaryProjects = orderItems(projects.filter((project) => !isVerificationProject(project)), storedOrder.projects);
  writeHtml(refs.sidebarProjects, `
    <button class="sidebar-link sidebar-create-project" data-action="newProject" type="button">
      <span class="row-icon" aria-hidden="true">+</span>
      <span>New project</span>
    </button>
    ${primaryProjects.map(renderSidebarProject).join('')}
  `);
}

export function renderMobileManifest() {
  api('/api/mobile/manifest')
    .then(({ data }) => {
      if (!data) return;
      shell.mobileManifest = data;
    })
    .catch(() => {});
}
