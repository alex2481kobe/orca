// Render view module (split from render-views.js).

import { isLocalHostName, writeHtml } from './dom.js';
import { refs, shell } from './state.js';
import { safeAttr, safeText } from './format.js';
import { api, browserAccessBlocked, setApiToken } from './api.js';
import { isVerificationProject, renderBreadcrumbs, renderTopbarTitle } from './render-helpers.js';
import { renderHome } from './render-home.js';
import { renderProject } from './render-project.js';
import { loadEvidenceGallery, renderAuditLog, renderLane } from './render-lane.js';
import { renderSession } from './render-session.js';
import { restoreContentUiState } from './render-fragments.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES } from './constants.js';
import { orderItems, readSidebarOrder, isProjectExpanded } from './sidebar.js';
import { COMPOSE_ICON, FOLDER_ICON, PENCIL_ICON } from './constants.js';

export function renderAccessGate() {
  const narrowClient = window.matchMedia('(max-width: 880px)').matches;
  const workstationAdmin = isLocalHostName(window.location.hostname) && !narrowClient;
  const browserLabel = narrowClient ? 'phone browser' : 'laptop browser';
  if (!workstationAdmin) {
    refs.content.innerHTML = `
      <section class="project-shell">
        <article class="card control-card auth-gate">
          <div class="card-kicker">Pair this device</div>
          <h3>Enter the code from your workstation</h3>
          <p>No dashboard data is shown until this browser is paired. Open Orca on the trusted workstation, go to Settings -> Access and paired devices, create a one-time code, then enter it here.</p>
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
              <div><strong>Pair this browser</strong><small>Chrome, Safari, and installed PWAs each keep their own session.</small></div>
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
          <details class="disclosure compact-disclosure">
            <summary><span>Add to Home Screen after pairing</span><small>PWA</small></summary>
            <div class="disclosure-body tiny muted">After this device is paired, open the private URL in Safari, tap Share, then Add to Home Screen. HTTPS Serve gives the cleanest installed-app behavior; HTTP over Tailscale remains private but may show browser warnings.</div>
          </details>
        </article>
      </section>
    `;
    return;
  }
  refs.content.innerHTML = `
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
  `;
}

export function render(uiState = null) {
  const project = shell.projects.find((value) => value.slug === shell.route.projectSlug || value.id === shell.route.projectSlug);
  const sessions = project ? shell.sessions : [];
  const session = sessions.find((value) => value.id === shell.route.sessionId);
  const lane = shell.lanes.find((value) => value.id === shell.route.laneId);

  renderBreadcrumbs(project, session);
  renderTopbarTitle(project, session, lane);
  renderStatusStrip();
  renderBlockers();
  if (refs.content) refs.content.setAttribute('aria-busy', 'false');
  if (browserAccessBlocked()) {
    renderSidebarProjects();
    if (refs.topbarTitle) refs.topbarTitle.textContent = 'Orca';
    renderAccessGate();
    return;
  }
  renderSidebarProjects(project);
  if (!project) {
    renderHome();
  } else if (!session) {
    renderProject(project);
  } else if (shell.route.laneId) {
    refs.content.innerHTML = renderLane(project, session, lane);
    if (lane) loadEvidenceGallery(lane.id);
  } else {
    renderSession(project, session);
  }
  renderAuditLog();
  restoreContentUiState(uiState);
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
  const executorTags = (statusExecutorTypes.length ? statusExecutorTypes : ['codex', 'claude']).map((type) => {
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
      <a class="sidebar-link sidebar-create-project" href="/#create">
        <span class="row-icon" aria-hidden="true">+</span>
        <span>New project</span>
      </a>
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
        <a class="sidebar-project ${isActiveProject ? 'active' : ''}" href="${safeAttr(project.route)}" data-route-project="${safeAttr(project.slug)}" data-project-id="${safeAttr(project.id)}" data-project-toggle="1">
          <span class="sidebar-chevron" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false"><path d="M7.5 5l5 5-5 5"></path></svg>
          </span>
          ${FOLDER_ICON}
          <span class="sidebar-project-name">${safeText(project.name)}</span>
          ${active ? `<span class="pill" title="${active} active lanes">${active}</span>` : ''}
        </a>
        <div class="sidebar-sessions">
          ${sessionRows}
          <a class="sidebar-new-session" href="${safeAttr(project.route)}#create-session">
            <span class="sidebar-new-session-plus" aria-hidden="true">+</span>
            <span>New session</span>
          </a>
        </div>
      </div>
    `;
  };
  const primaryProjects = orderItems(projects.filter((project) => !isVerificationProject(project)), storedOrder.projects);
  writeHtml(refs.sidebarProjects, `
    <a class="sidebar-link sidebar-create-project" href="/#create">
      <span class="row-icon" aria-hidden="true">+</span>
      <span>New project</span>
    </a>
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
