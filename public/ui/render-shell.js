// Render view module (split from render-views.js).

import { isLocalHostName, writeHtml } from './dom.js';
import { refs, shell, makeDraftSession } from './state.js';
import { safeAttr, safeText } from './format.js';
import { api, browserAccessBlocked, setApiToken } from './api.js';
import { isVerificationProject, renderBreadcrumbs, renderTopbarTitle } from './render-helpers.js';
import { renderHome } from './render-home.js';
import { renderProject, renderWorkstationPickerPanel } from './render-project.js';
import { loadEvidenceGallery, renderAuditLog, renderLane } from './render-lane.js';
import { renderSession } from './render-session.js';
import { restoreContentUiState } from './render-fragments.js';
import { enhanceSelects } from './dropdown.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES } from './constants.js';
import { orderItems, readSidebarOrder, isProjectExpanded } from './sidebar.js';
import { COMPOSE_ICON, FOLDER_ICON, PENCIL_ICON } from './constants.js';

export function renderAccessGate() {
  const narrowClient = window.matchMedia('(max-width: 880px)').matches;
  const workstationAdmin = isLocalHostName(window.location.hostname) && !narrowClient;
  const browserLabel = narrowClient ? 'phone browser' : 'laptop browser';
  if (!workstationAdmin) {
    // The "Connect to a workstation" URL step is only for the DOWNLOADED desktop
    // app (Tauri) or a desktop laptop — never a phone (a mobile browser already
    // opened the workstation URL to get here, so it just needs the pairing code).
    const isDesktopApp = typeof window !== 'undefined' && Boolean(window.__TAURI__);
    const showConnect = isDesktopApp || !narrowClient;
    let connectCard = '';
    if (showConnect) {
      let recentWorkstations = [];
      try { recentWorkstations = JSON.parse(localStorage.getItem('orca.workstations') || '[]'); } catch { recentWorkstations = []; }
      const recentRows = (Array.isArray(recentWorkstations) ? recentWorkstations : []).slice(0, 5)
        .map((url) => `<button class="btn-ghost" data-action="connectWorkstation" data-url="${safeAttr(url)}" type="button">${safeText(url)}</button>`).join('');
      connectCard = `
          <div class="card-kicker">Using the Orca app on this device</div>
          <h3>Connect to your workstation</h3>
          <p>Installed the Orca app on this laptop/computer? Point it at your workstation over Tailscale — you don't have to use a browser. (You can still just open the workstation URL in a browser if you prefer.)</p>
          <div class="card">
            <h3>Connect to a workstation</h3>
            <p class="tiny muted">Both devices must be on the same Tailscale tailnet. Enter your workstation's Tailscale URL (e.g. http://your-mac.your-tailnet.ts.net).</p>
            <label>Workstation URL
              <input id="workstation-url-input" inputmode="url" placeholder="http://your-mac.your-tailnet.ts.net" />
            </label>
            <div class="lane-row">
              <button class="btn" data-action="connectWorkstation" type="button">Connect</button>
            </div>
            ${recentRows ? `<div class="tiny muted" style="margin-top:0.5rem">Recent workstations</div><div class="lane-row" style="flex-wrap:wrap">${recentRows}</div>` : ''}
          </div>
          <div class="card-kicker" style="margin-top:1rem">Then pair this device</div>`;
    }
    writeHtml(refs.content, `
      <section class="project-shell">
        <article class="card control-card auth-gate">
          ${connectCard}
          <div class="card-kicker">Pair this device</div>
          <h3>Enter the code from your workstation</h3>
          <p>No dashboard data is shown until this device is paired. On the trusted workstation, go to Settings -> Access and paired devices, create a one-time code, then enter it here.</p>
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
            <div class="setup-step">
              <span>4</span>
              <div><strong>Add Orca to your Home Screen</strong><small>After pairing, in Safari tap Share, then "Add to Home Screen" to open Orca like an app. (Android: Chrome menu, then "Add to Home screen".)</small></div>
            </div>
          </div>
          <div class="card">
            <h3>Use pairing code</h3>
            <p>Pairing creates a browser session cookie for this device. API tokens are not shown on unpaired phone or laptop screens.</p>
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
        </article>
      </section>
    `);
    return;
  }
  writeHtml(refs.content, `
    <section class="project-shell">
      <article class="card control-card auth-gate">
        <div class="card-kicker">Workstation admin</div>
        <h3>Unlock setup and pairing</h3>
        <p>Enter the server API token only on a trusted workstation/admin browser. After unlock, Settings shows QR setup, HTTP/HTTPS preference, paired devices, revocation, and one-time pairing codes for phone or laptop browsers.</p>
        <div class="grid-2">
          <div class="card">
            <h3>Use API token</h3>
            <p>The token stays in this browser session only. Remote clients should use one-time pairing codes instead.</p>
            <label>API token
              <input id="api-token-input" type="password" autocomplete="off" placeholder="Paste token" />
            </label>
            <div class="lane-row">
              <button data-action="setApiToken" type="button">Connect</button>
              <button class="secondary" data-action="clearApiToken" type="button">Clear</button>
            </div>
          </div>
          <div class="card">
            <h3>Use pairing code instead</h3>
            <p>If another trusted browser already generated a one-time code, enter it here to create a browser session cookie.</p>
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
        </div>
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

  renderBreadcrumbs(project, session);
  renderTopbarTitle(project, session, lane);
  renderStatusStrip();
  renderBlockers();
  renderPickerModal();
  if (refs.content) refs.content.setAttribute('aria-busy', 'false');
  if (browserAccessBlocked()) {
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
    renderProject(project);
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
  const onWorkstation = isLocalHostName(window.location.hostname);
  if (section) section.hidden = !onWorkstation;
  if (!onWorkstation) return;
  // Count only real paired REMOTE devices — never the local workstation browser.
  const n = Array.isArray(shell.authSessions)
    ? shell.authSessions.filter((s) => s && (s.paired || s.pairedFromId)).length
    : 0;
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
  const running = lanes.filter((lane) => ['running', 'starting'].includes(lane.state)).length;
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
      <div class="tiny" style="color:inherit">${safeText(blocker.detail)}</div>
      <div class="tiny" style="color:inherit;margin-top:0.25rem">Remediation: <code>${safeText(blocker.remediation)}</code></div>
    </div>
  `).join(''));
}

export function renderSidebarProjects(activeProject) {
  if (!refs.sidebarProjects) return;
  if (browserAccessBlocked()) {
    writeHtml(refs.sidebarProjects, `
      <a class="sidebar-link sidebar-create-project" href="/#private-access">
        <span class="row-icon" aria-hidden="true">🔒</span>
        <span>Device not paired</span>
      </a>
      <div class="tiny muted">Open pairing setup to unlock projects and sessions.</div>
    `);
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
  const archiveIcon = `
    <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
      <path d="M3.2 6.5h13.6"></path>
      <path d="M5 6.5v9.2c0 .8.6 1.4 1.4 1.4h7.2c.8 0 1.4-.6 1.4-1.4V6.5"></path>
      <path d="M7.2 3.3h5.6l.8 3.2H6.4l.8-3.2Z"></path>
      <path d="M8 10h4"></path>
    </svg>`;
  const renderSidebarProject = (project) => {
    const projectSessions = orderItems(
      (shell.sessions || []).filter((session) => session.projectId === project.id),
      storedOrder.sessions[project.id] || [],
    );
    const lanes = (shell.lanes || []).filter((lane) => lane.projectId === project.id);
    const active = lanes.filter((lane) => ['running', 'starting', 'queued'].includes(lane.state)).length;
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
          <button class="sidebar-rename" type="button" data-action="renameSession" data-session-id="${safeAttr(session.id)}" data-session-name="${safeAttr(session.name)}" aria-label="Rename ${safeAttr(session.name)} session" title="Rename session">
            ${PENCIL_ICON}
          </button>
          <button class="sidebar-archive" type="button" data-action="archiveSession" data-session-id="${safeAttr(session.id)}" data-session-name="${safeAttr(session.name)}" aria-label="Archive ${safeAttr(session.name)} session" title="Archive session">
            ${archiveIcon}
          </button>
        </div>
      `;
    }).join('');
    return `
      <div class="sidebar-project-group ${expanded ? 'expanded' : 'collapsed'}" draggable="true" data-reorder-kind="project" data-project-id="${safeAttr(project.id)}">
        <div class="sidebar-project-line">
          <a class="sidebar-project ${isActiveProject ? 'active' : ''}" href="${safeAttr(project.route)}" data-route-project="${safeAttr(project.slug)}" data-project-id="${safeAttr(project.id)}" data-project-toggle="1">
            ${FOLDER_ICON}
            <span class="sidebar-project-name">${safeText(project.name)}</span>
            ${active ? `<span class="pill" title="${active} active lanes">${active}</span>` : ''}
          </a>
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
