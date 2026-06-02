// All dashboard view renderers + their sub-renderers/view-helpers (render()
// dispatcher, project/session/lane/audit views, status strip, blockers, sidebar,
// mobile manifest, access gate, orchestrator console, composer, executor panels,
// evidence gallery, content UI-state preserve). Extracted from app.js.

import { apiProviderOptions, cliExecutorOptions, getExecutorProfile, getExecutorScopedMcpTools, getProviderProfile, isApiExecutorType, normalizeExecutorType } from './executor.js';
import { formatMeta, formatRelative, latestTimestamp, safeAttr, safeText, stateBadge } from './format.js';
import { refs, shell } from './state.js';
import { clientUrl, isLocalHostName, renderAlert, safeHref, writeHtml } from './dom.js';
import { api, browserAccessBlocked, currentActiveProject, setApiToken } from './api.js';
import { effectiveProjectQuickLinkUrl, quickLinkHealthLabel } from './access-mode.js';
import { activeHomePanel, agentEventLabel, agentEventTone, executorCapabilitiesFor, getActionPolicy, isLiveLaneState, isRestartableLaneState, isVerificationProject, laneDetailRoute, pendingAuditsForLane, pendingAuditsForSession, renderBreadcrumbs, renderExecutorCapabilities, renderTopbarTitle, stateTagClass } from './render-helpers.js';
import { renderHome } from './render-home.js';
import { orderItems, readSidebarOrder } from './sidebar.js';
import { COMPOSE_ICON, FOLDER_ICON, PENCIL_ICON } from './constants.js';


export function renderLaneExecutorGuidance(form) {
  if (!form || form.id !== 'create-lane-form') return;
  const profileEl = document.getElementById('lane-command-guidance');
  if (!profileEl) return;
  const selectedType = normalizeExecutorType(form.executorType?.value || 'mock');
  const profile = getExecutorProfile(selectedType);
  const providerProfile = getProviderProfile(selectedType);
  const lowerType = normalizeExecutorType(selectedType);
  const commandInput = form.elements.command;
  const binaryInput = form.elements.executorBinary;
  const scopedTools = getExecutorScopedMcpTools(selectedType);
  // Populate MCP picker select with executor-scoped tools.
  const mcpSelect = form.querySelector('select[name="mcpToolIds"]');
  if (mcpSelect) {
    const previous = new Set(Array.from(mcpSelect.selectedOptions || []).map((opt) => opt.value));
    mcpSelect.innerHTML = scopedTools.map((tool) => {
      const value = safeText(tool.id || tool.name);
      const label = safeText(tool.name || tool.id);
      return `<option value="${value}" ${previous.has(value) ? 'selected' : ''}>${label}</option>`;
    }).join('');
    if (!scopedTools.length) {
      mcpSelect.innerHTML = '<option disabled>No tools available for this executor</option>';
    }
  }
  const defaultBinary = safeText(profile?.defaultBinary || '');
  const defaultArgs = Array.isArray(profile?.defaultArgs) ? profile.defaultArgs.join(' ') : '';
  const allowedBinaries = Array.isArray(profile?.allowedBinaries) ? profile.allowedBinaries : [];
  const allowedList = allowedBinaries.length ? `Allowed binaries: ${safeText(allowedBinaries.join(', '))}` : 'No curated binary allowlist available';
  const visibleToolIds = scopedTools.map((tool) => safeText(tool.id || tool.name)).slice(0, 10).join(', ');
  const toolSummary = scopedTools.length
    ? `Available MCP tools: ${visibleToolIds}${scopedTools.length > 10 ? ', ...' : ''}`
    : 'No MCP tools currently available for this lane type.';

  const defaultArgsText = defaultArgs ? ` ${safeText(defaultArgs)}` : '';
  const binaryHint = defaultBinary ? `Try ${defaultBinary}${defaultArgsText} for ${lowerType}-led lanes.` : '';

  if (lowerType === 'codex' || lowerType === 'claude') {
    commandInput.placeholder = defaultBinary
      ? `${defaultBinary} run --help`
      : `${lowerType} <args>`;
    binaryInput.placeholder = defaultBinary || `${lowerType}`;
    profileEl.innerHTML = `
      <div class="tiny muted">
        Executor guidance: command or binary must contain "${lowerType}".
        ${binaryHint ? `${binaryHint} ` : ''}
        ${allowedList ? `${allowedList}` : ''}
        <br/>${toolSummary}
      </div>
    `.trim();
    return;
  }

  if (lowerType === 'mock') {
    commandInput.placeholder = 'e.g., node';
    binaryInput.placeholder = 'e.g., codex, claude, node, ./scripts/run.sh';
    profileEl.innerHTML = `
      <div class="tiny muted">
        ${toolSummary}
      </div>
    `.trim();
    return;
  }

  if (isApiExecutorType(lowerType)) {
    const credentialLabel = providerProfile?.apiKeyEnv || providerProfile?.secretRef || 'configured provider secret';
    commandInput.placeholder = 'Not used for API provider lanes';
    binaryInput.placeholder = 'Not used for API provider lanes';
    profileEl.innerHTML = `
      <div class="tiny muted">
        API lane: uses ${safeText(providerProfile?.displayName || lowerType)} provider settings,
        ${safeText(providerProfile?.apiStyle || 'configured')} request shape,
        and secret reference ${safeText(credentialLabel)}. Configure secrets in Providers settings.
        <br/>${toolSummary}
      </div>
    `.trim();
    return;
  }

  commandInput.placeholder = 'e.g., node';
  binaryInput.placeholder = 'e.g., codex, claude, node, ./scripts/run.sh';
  profileEl.textContent = toolSummary;
}

export function captureContentUiState() {
  if (!refs.content) return null;
  return {
    detailsOpen: Array.from(refs.content.querySelectorAll('details')).map((detail) => detail.open),
    projectToolsOpen: Boolean(refs.content.querySelector('.project-shell.tools-open')),
  };
}

export function restoreContentUiState(state) {
  if (!state || !refs.content) return;
  Array.from(refs.content.querySelectorAll('details')).forEach((detail, index) => {
    if (index < state.detailsOpen.length) {
      detail.open = state.detailsOpen[index];
    }
  });
  const projectShell = refs.content.querySelector('.project-shell');
  if (projectShell && state.projectToolsOpen) {
    projectShell.classList.add('tools-open');
  }
}

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

export function renderProject(project) {
  const sessionsMarkup = shell.sessions.filter((session) => session.projectId === project.id).map((session) => {
    const route = session.route;
    const sessionLanes = shell.lanes.filter((lane) => lane.sessionId === session.id);
    const latestActivity = latestTimestamp([...sessionLanes, session]);
    return `
      <article class="card click-card session-card" data-href="${safeAttr(route)}" tabindex="0" role="link" aria-label="Open ${safeAttr(session.name)} session">
        <div class="card-kicker">Session</div>
        <h3>${safeText(session.name)}</h3>
        <p>${safeText(sessionLanes.length)} lane${sessionLanes.length === 1 ? '' : 's'} coordinated by ${safeText(session.leader)}.</p>
        <div class="card-meta">
          <span>${safeText(session.laneConcurrencyLimit)} max parallel</span>
          <span>${safeText(formatRelative(latestActivity))}</span>
        </div>
        <div class="lane-row"><a href="${safeAttr(route)}" class="secondary">Open session</a></div>
      </article>
    `;
  }).join('');
  const createSessionOpen = window.location.hash === '#create-session' || !sessionsMarkup;
  const quickLinks = Array.isArray(project.quickLinks) ? project.quickLinks.filter((quick) => !quick.hidden) : [];
  const quickLinksMarkup = quickLinks
    .map((quick) => {
      const url = clientUrl(effectiveProjectQuickLinkUrl(quick));
      return `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.label)}</a>`;
    })
    .join('');
  const quickLinkRows = quickLinks.map((quick) => {
    const url = clientUrl(effectiveProjectQuickLinkUrl(quick));
    const detail = [
      quick.kind || 'other',
      quick.port ? `:${quick.port}` : '',
      quick.lastCheckedAt ? `checked ${formatRelative(quick.lastCheckedAt)}` : 'not checked',
    ].filter(Boolean).join(' / ');
    return `
      <div class="lane-row">
        <div>
          <div>${safeText(quick.label || 'Live link')}</div>
          <a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${safeText(url)}</a>
          <div class="tiny muted">${safeText(detail)}</div>
          <div class="tiny">${safeText(quickLinkHealthLabel(quick.healthStatus))}${quick.lastStatusCode ? ` / HTTP ${safeText(quick.lastStatusCode)}` : ''}</div>
        </div>
        <div class="lane-row">
          <button class="secondary" data-action="checkProjectQuickLink" data-project-id="${safeAttr(project.id)}" data-link-id="${safeAttr(quick.id)}" type="button">Check</button>
          <button class="secondary" data-action="deleteProjectQuickLink" data-project-id="${safeAttr(project.id)}" data-link-id="${safeAttr(quick.id)}" type="button">Remove</button>
        </div>
      </div>
    `;
  }).join('');

  refs.content.innerHTML = `
    <section class="project-shell">
      <div class="project-workspace">
        <div class="project-main">
          <article class="card control-card">
            <details class="disclosure" ${createSessionOpen ? 'open' : ''}>
              <summary>
                <span>Create session</span>
                <small>Start a new work board</small>
              </summary>
              <div class="disclosure-body">
            <form id="create-session-form" data-project-id="${project.id}">
              <label>Session name
                <input name="name" required />
              </label>
              <label>Leader
                <select name="leader">
                  <option value="codex">Codex-led</option>
                  <option value="claude">Claude-led</option>
                  <option value="mixed">Mixed</option>
                </select>
              </label>
              <label>Max parallel lanes
                <input name="laneConcurrencyLimit" type="number" min="1" max="4" value="1" />
              </label>
              <button type="submit">Create session</button>
            </form>
              </div>
            </details>
          </article>
          <article class="card">
          <h3>Sessions</h3>
          <div class="card-grid">${sessionsMarkup || '<div class="muted">No sessions yet.</div>'}</div>
          </article>
        </div>
        <aside class="project-side-panel" id="project-tools" aria-label="Project tools">
          <details class="disclosure">
            <summary>
              <span>Quick links</span>
              <small>Dev routes</small>
            </summary>
            <div class="disclosure-body">
              <div class="lane-row">${quickLinksMarkup || '<span class="muted">No quick links.</span>'}</div>
              <div class="card-grid">
                ${quickLinkRows || '<div class="muted">No quick links.</div>'}
              </div>
              <form id="update-project-links-form" data-project-id="${project.id}">
                <label>Quick link label
                  <input name="quickLinkLabel" placeholder="My web app" required />
                </label>
                <label>Quick link URL
                  <input name="quickLinkUrl" placeholder="http://localhost:5173" required />
                </label>
                <div class="grid-2">
                  <label>Kind
                    <select name="quickLinkKind">
                      <option value="vite">Vite</option>
                      <option value="dev-server">Dev server</option>
                      <option value="preview">Preview</option>
                      <option value="dashboard">Dashboard</option>
                      <option value="artifact">Artifact</option>
                      <option value="docs">Docs</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label>Port
                    <input name="quickLinkPort" type="number" min="1" max="65535" placeholder="5173" />
                  </label>
                </div>
                <label><input type="checkbox" name="quickLinkFavorite"> Favorite</label>
                <details class="disclosure compact-disclosure">
                  <summary><span>Remote variants</span><small>optional</small></summary>
                  <div class="disclosure-body">
                    <label>Local URL
                      <input name="quickLinkLocalUrl" placeholder="http://127.0.0.1:5173" />
                    </label>
                    <label>Tailnet HTTP URL
                      <input name="quickLinkTailnetHttpUrl" placeholder="http://device.tailnet.ts.net:5173" />
                    </label>
                    <label>HTTPS Serve URL
                      <input name="quickLinkHttpsServeUrl" placeholder="https://device.tailnet.ts.net" />
                    </label>
                  </div>
                </details>
                <button type="submit">Save live link</button>
              </form>
            </div>
          </details>
          <details class="disclosure">
            <summary>
              <span>Operations</span>
              <small>Global tools</small>
            </summary>
            <div class="disclosure-body action-list">
              <button class="danger" data-action="archiveProject" data-project-id="${safeAttr(project.id)}" data-project-name="${safeAttr(project.name)}" type="button">Archive project</button>
              <a href="/#notifications">Notifications</a>
              <a href="/#audit">Audit queue</a>
              <a href="/#mcp">MCP tools</a>
              <a href="/#cleanup">Cleanup</a>
              <a href="/#token">API token</a>
            </div>
          </details>
        </aside>
      </div>
    </section>
  `;
}

export function renderLaneCard(lane) {
  const artifactsLink = `/api/lanes/${lane.id}/artifacts`;
  const evidenceLatestUrl = `/api/lanes/${lane.id}/evidence/latest`;
  const lanePendingAudits = pendingAuditsForLane(lane.id);
  const auditQueuedBadge = lanePendingAudits.length
    ? `<span class="tag warn">Audit queued (${lanePendingAudits.length})</span>`
    : '';
  const laneAuditWarning = lanePendingAudits.length
    ? `<div class="tiny">Pending audit event${lanePendingAudits.length > 1 ? 's' : ''}: ${
      lanePendingAudits.map((event) => event.id.slice(0, 8)).join(', ')
    }</div>`
    : '';
  const stopButton = ['running', 'starting', 'queued'].includes(lane.state)
    ? `<button data-action="stopLane" data-lane-id="${safeAttr(lane.id)}" title="${safeAttr(getActionPolicy('stopLane').message)}" type="button">Stop lane</button>` : '';
  const retryButton = ['failed', 'stopped'].includes(lane.state)
    ? `<button class="secondary" data-action="retryLane" data-lane-id="${safeAttr(lane.id)}" title="${safeAttr(getActionPolicy('retryLane').message)}" type="button">Retry lane</button>` : '';
  const laneLink = lane.route ? `<a class="secondary" href="${safeAttr(lane.route)}">Lane detail</a>` : '';
  const auditLabel = lanePendingAudits.length ? 'Audit already queued' : 'Audit now';
  return `
      <article class="lane-list-item click-card" data-href="${safeAttr(lane.route || '')}" tabindex="0" role="link" aria-label="Open lane ${safeAttr(lane.title)}">
        <div class="row">
          <h4>${safeText(lane.title)}</h4>
          ${stateBadge(lane.state)}
          ${auditQueuedBadge}
      </div>
      <p>${safeText(lane.taskDescription || lane.taskPrompt || 'No task description yet.')}</p>
      <div class="card-meta">
        <span>${safeText(lane.executorType)}</span>
        <span>${safeText(lane.owner)}</span>
        <span>${safeText((lane.mcpTools || []).length)} MCP</span>
        <span>${safeText(formatRelative(lane.updatedAt || lane.startedAt))}</span>
      </div>
      ${laneAuditWarning}
      <div class="lane-row">
        ${stopButton}
        ${retryButton}
        <button class="secondary" data-action="captureEvidence" data-lane-id="${lane.id}" type="button">Capture evidence</button>
        <button class="secondary" data-action="auditLane" data-lane-id="${lane.id}" type="button">${auditLabel}</button>
      </div>
      <details class="disclosure compact-disclosure">
        <summary>More</summary>
        <div class="tiny">
          Started: ${formatMeta(lane.startedAt)} · Heartbeat: ${formatMeta(lane.heartbeatAt)} · Last evidence: ${safeText(lane.lastEvidenceCaptureAt || 'never')} (${safeText(lane.lastEvidence?.status || 'not captured')})
        </div>
        <div class="muted tiny">Path: ${safeText(lane.artifactPath || '')}</div>
        <div class="lane-row">
          ${laneLink}
          <button class="secondary" data-action="clearEvidence" data-lane-id="${lane.id}" type="button">Clear evidence</button>
          <button class="secondary" data-action="showArtifacts" data-lane-id="${lane.id}" type="button">Artifacts</button>
          <a class="secondary" href="${artifactsLink}" target="_blank" rel="noopener noreferrer">Artifact API</a>
          <a class="secondary" href="${evidenceLatestUrl}" target="_blank" rel="noopener noreferrer">Latest evidence</a>
        </div>
      </details>
      <div id="lane-artifacts-${lane.id}" class="tiny"></div>
    </article>
  `;
}

export function activeOrchestratorLaneForSession(session) {
  const thread = session?.orchestratorThread || {};
  if (thread.activeLaneId) {
    const active = shell.lanes.find((lane) => lane.id === thread.activeLaneId);
    if (active) return active;
  }
  const laneIds = Array.isArray(thread.laneIds) ? thread.laneIds : [];
  for (let i = laneIds.length - 1; i >= 0; i -= 1) {
    const lane = shell.lanes.find((item) => item.id === laneIds[i]);
    if (lane) return lane;
  }
  return shell.lanes
    .filter((lane) => lane.sessionId === session?.id && lane.owner === 'orchestrator')
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
}

export function renderAgentEventTimeline(lane, { limit = 80, compact = false } = {}) {
  const events = Array.isArray(lane?.agentEvents) ? lane.agentEvents.slice(-limit) : [];
  if (!events.length) {
    return '<div class="agent-event-empty muted">No structured agent events yet. Raw terminal output will appear below.</div>';
  }
  return `
    <div class="agent-event-list ${compact ? 'compact' : ''}">
      ${events.map((item) => {
        const type = String(item.type || 'event');
        const tone = agentEventTone(type);
        const content = item.command || item.content || item.title || '';
        const meta = [
          item.toolName,
          item.stream,
          item.source,
          formatMeta(item.at),
        ].filter(Boolean).join(' · ');
        return `
          <article class="agent-event ${safeAttr(type.replaceAll('.', '-'))}">
            <div class="agent-event-topline">
              <span class="tag ${tone}">${safeText(agentEventLabel(type))}</span>
              <span class="tiny muted">${safeText(meta)}</span>
            </div>
            ${content ? `<pre>${safeText(content)}</pre>` : ''}
          </article>
        `;
      }).join('')}
    </div>
  `;
}

export function modelPresetOptions(selected = '') {
  const normalized = String(selected || '').trim();
  const options = [
    ['', 'Default'],
    ['gpt-5.5', 'GPT-5.5'],
    ['gpt-5', 'GPT-5'],
    ['claude-sonnet-4-5', 'Claude Sonnet 4.5'],
    ['claude-opus-4-7', 'Claude Opus 4.7'],
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ['cursor-default', 'Cursor default'],
  ];
  return options.map(([value, label]) => `<option value="${safeAttr(value)}"${normalized === value ? ' selected' : ''}>${safeText(label)}</option>`).join('');
}

export function intelligenceOptions(selected = 'high') {
  const normalized = String(selected || 'high').trim().toLowerCase();
  return [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
    ['max', 'Max'],
  ].map(([value, label]) => `<option value="${safeAttr(value)}"${normalized === value ? ' selected' : ''}>${safeText(label)}</option>`).join('');
}

export function runModeOptions(selected = 'plan') {
  const normalized = String(selected || 'plan').trim();
  return [
    ['plan', 'Plan'],
    ['read-only', 'Read only'],
    ['auto-edit', 'Auto edit'],
    ['acceptEdits', 'Accept edits'],
    ['bypassPermissions', 'Bypass permissions'],
  ].map(([value, label]) => `<option value="${safeAttr(value)}"${normalized === value ? ' selected' : ''}>${safeText(label)}</option>`).join('');
}

export function modelControlOptions(selected = '') {
  return modelPresetOptions(selected || '');
}

export function renderOrchestratorTerminal(project, session, lane) {
  if (!lane) {
    return `
      <div class="orchestrator-terminal empty">
        <div class="terminal-titlebar">
          <span>Terminal</span>
          <span class="tag">Idle</span>
        </div>
        <pre class="orchestrator-terminal-output">No active orchestrator process.</pre>
      </div>
    `;
  }
  const allLogs = Array.isArray(lane.logs) ? lane.logs : [];
  const hiddenCount = Math.max(0, allLogs.length - 500);
  const logs = allLogs.slice(-500);
  const logText = logs.length
    ? logs.map((entry) => {
      const at = entry?.at ? formatMeta(entry.at) : '--:--:--';
      return `[${at}] ${String(entry?.message || '')}`;
    }).join('\n')
    : 'Waiting for process output...';
  const route = laneDetailRoute(project, session, lane);
  const stopButton = isLiveLaneState(lane.state)
    ? `<button data-action="stopLane" data-lane-id="${safeAttr(lane.id)}" type="button">Stop</button>`
    : '';
  const restartButton = (isLiveLaneState(lane.state) || isRestartableLaneState(lane.state))
    ? `<button class="secondary" data-action="restartLane" data-lane-id="${safeAttr(lane.id)}" type="button">Restart</button>`
    : '';
  const openLane = route ? `<a class="secondary" href="${safeAttr(route)}">Open lane</a>` : '';
  const artifactBase = `/artifacts/${encodeURIComponent(lane.sessionId)}/${encodeURIComponent(lane.id)}`;
  const terminalLinks = `
    <a class="secondary" href="${artifactBase}/terminal.log" target="_blank" rel="noopener noreferrer">Full log</a>
    <a class="secondary" href="${artifactBase}/stdout.log" target="_blank" rel="noopener noreferrer">stdout</a>
    <a class="secondary" href="${artifactBase}/stderr.log" target="_blank" rel="noopener noreferrer">stderr</a>
  `;
  const processMeta = lane.processMeta
    ? `PID ${safeText(String(lane.processMeta.pid ?? 'n/a'))} / exit ${safeText(String(lane.processMeta.exitCode ?? 'running'))}`
    : 'Process pending';
  return `
    <div class="orchestrator-terminal">
      <div class="terminal-titlebar">
        <div>
          <span>${safeText(lane.title || 'Orchestrator lane')}</span>
          <div class="tiny muted">${safeText(lane.executorType)} | ${processMeta}</div>
        </div>
        <div class="lane-row">
          ${stateBadge(lane.state)}
          ${openLane}
          ${terminalLinks}
          ${stopButton}
          ${restartButton}
        </div>
      </div>
      ${renderAgentEventTimeline(lane, { limit: 80 })}
      <pre class="orchestrator-terminal-output">${hiddenCount ? safeText(`[Showing latest 500 of ${allLogs.length} stored log entries. Open Full log for raw terminal output.]\n`) : ''}${safeText(logText)}</pre>
    </div>
  `;
}

export function renderApprovalRows(lane) {
  const pending = (lane.pendingApprovals || []).filter((entry) => entry.status === 'pending');
  if (!pending.length) return '';
  return `<div class="approval-list">${pending.map((entry) => `
    <div class="approval-item">
      <div class="approval-detail">
        <span class="tag warn">approval</span> <strong>${safeText(entry.kind)}</strong>
        <div class="tiny">${safeText(entry.detail || '')}</div>
      </div>
      <div class="lane-row">
        <button data-action="approveApproval" data-lane-id="${safeAttr(lane.id)}" data-approval-id="${safeAttr(entry.id)}" type="button">Approve</button>
        <button class="danger" data-action="denyApproval" data-lane-id="${safeAttr(lane.id)}" data-approval-id="${safeAttr(entry.id)}" type="button">Deny</button>
      </div>
    </div>`).join('')}</div>`;
}

export function renderSessionApprovals(session) {
  const lanes = (shell.lanes || []).filter((lane) =>
    lane.sessionId === session.id && (lane.pendingApprovals || []).some((entry) => entry.status === 'pending'));
  if (!lanes.length) return '';
  return `
    <article class="approvals-banner">
      <div class="card-kicker">Agent is asking for permission</div>
      ${lanes.map((lane) => `
        <div class="approval-lane">
          <div class="tiny muted">${safeText(lane.title || lane.id)} · ${safeText(lane.executorType || 'agent')}</div>
          ${renderApprovalRows(lane)}
        </div>`).join('')}
    </article>`;
}

export function composerAttachmentsFor(sessionId) {
  shell.composerAttachments = shell.composerAttachments || {};
  if (!Array.isArray(shell.composerAttachments[sessionId])) shell.composerAttachments[sessionId] = [];
  return shell.composerAttachments[sessionId];
}

export function renderComposerAttachmentChips(sessionId) {
  const list = composerAttachmentsFor(sessionId);
  if (!list.length) return '';
  return list.map((entry) => `
    <span class="attach-chip">${safeText(entry.name)}<button data-action="removeAttachment" data-session-id="${safeAttr(sessionId)}" data-attachment-id="${safeAttr(entry.id)}" type="button" aria-label="Remove ${safeAttr(entry.name)}">×</button></span>
  `).join('');
}

export function refreshComposerAttachments(sessionId) {
  const el = document.getElementById(`composer-attachments-${sessionId}`);
  if (el) writeHtml(el, renderComposerAttachmentChips(sessionId));
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export async function uploadComposerFiles(sessionId, fileList) {
  const files = [...(fileList || [])].slice(0, 10);
  if (!files.length) return;
  for (const file of files) {
    if (file.size > 12 * 1024 * 1024) { renderAlert(`${file.name} exceeds the 12MB limit.`, 'bad'); continue; }
    try {
      const dataBase64 = await readFileAsBase64(file);
      const response = await api(`/api/sessions/${sessionId}/attachments`, {
        method: 'POST',
        body: { actor: 'dashboard', name: file.name, contentType: file.type || '', dataBase64 },
      });
      if (response.ok && response.data) {
        composerAttachmentsFor(sessionId).push({ id: response.data.id, name: response.data.name, url: response.data.url });
      } else {
        renderAlert(response.data?.error || `Could not attach ${file.name}.`, 'bad');
      }
    } catch {
      renderAlert(`Could not read ${file.name}.`, 'bad');
    }
  }
  refreshComposerAttachments(sessionId);
}

export function renderOrchestratorConsole(session) {
  const project = shell.projects.find((value) => value.id === session.projectId) || currentActiveProject();
  const thread = session.orchestratorThread || {};
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const activeLane = activeOrchestratorLaneForSession(session);
  const messageRows = messages.slice(-12).map((message) => {
    const role = String(message.role || 'system').toLowerCase();
    const lane = message.laneId ? shell.lanes.find((item) => item.id === message.laneId) : null;
    return `
      <div class="orchestrator-message ${safeAttr(role)}">
        <div class="tiny muted">${safeText(role)}${lane ? ` · ${safeText(lane.state)}` : ''}</div>
        <div>${safeText(message.content || '')}</div>
      </div>
    `;
  }).join('');
  const selectedExecutor = thread.executorType || session.leader || 'codex';
  const selectedModel = activeLane?.model || '';
  const selectedRunMode = activeLane?.permissionsProfile || 'plan';
  const selectedIntelligence = activeLane?.intelligenceProfile || 'high';
  return `
    <article class="orchestrator-console">
      <div class="orchestrator-header">
        <div>
          <h2>Orchestrator</h2>
        </div>
        <div class="lane-row">
          <span class="tiny muted">${safeText(messages.length)} messages</span>
          ${activeLane ? stateBadge(activeLane.state) : '<span class="tag">Idle</span>'}
        </div>
      </div>
      <details class="disclosure orchestrator-plan"${session.goal || session.plan ? ' open' : ''}>
        <summary><span>Goal &amp; plan</span><small>${session.goal ? safeText(String(session.goal).slice(0, 60)) : 'not set'}</small></summary>
        <div class="disclosure-body">
          <form id="session-plan-form" data-session-id="${safeAttr(session.id)}">
            <label>Goal
              <input name="goal" value="${safeAttr(session.goal || '')}" placeholder="What are we trying to achieve?" />
            </label>
            <label>Plan
              <textarea name="plan" rows="4" placeholder="Steps / approach">${safeText(session.plan || '')}</textarea>
            </label>
            <button class="secondary" data-action="saveSessionPlan" type="button">Save goal &amp; plan</button>
          </form>
        </div>
      </details>
      ${renderSessionApprovals(session)}
      <div class="orchestrator-feed">
        ${messageRows || '<div class="muted">No orchestration messages yet.</div>'}
      </div>
      ${renderOrchestratorTerminal(project, session, activeLane)}
      ${renderExecutorCapabilities(activeLane?.executorCapabilities || executorCapabilitiesFor(selectedExecutor))}
      <form id="orchestrator-message-form" data-session-id="${safeAttr(session.id)}" class="orchestrator-form composer-shell">
        <div id="composer-attachments-${safeAttr(session.id)}" class="composer-attachments">${renderComposerAttachmentChips(session.id)}</div>
        <textarea name="message" rows="4" placeholder="Ask the orchestrator… (drop or paste files/screenshots to attach)"></textarea>
        <input type="file" id="composer-file-input" data-session-id="${safeAttr(session.id)}" multiple hidden />
        <div class="composer-bar">
          <button class="secondary composer-attach" data-action="pickAttachment" data-session-id="${safeAttr(session.id)}" type="button" title="Attach screenshot or document" aria-label="Attach file">📎</button>
          <select name="executorType" aria-label="Agent">
            ${cliExecutorOptions(selectedExecutor)}
            ${apiProviderOptions()}
            <option value="mock"${normalizeExecutorType(selectedExecutor) === 'mock' ? ' selected' : ''}>mock</option>
          </select>
          <select name="modelPreset" aria-label="Model">
            ${modelControlOptions(selectedModel)}
          </select>
          <input name="model" aria-label="Custom model" placeholder="custom model" />
          <select name="intelligenceProfile" aria-label="Intelligence">
            ${intelligenceOptions(selectedIntelligence)}
          </select>
          <select name="permissionsProfile" aria-label="Mode">
            ${runModeOptions(selectedRunMode)}
          </select>
          <button class="send-button" type="submit" aria-label="Send">Send</button>
        </div>
      </form>
    </article>
  `;
}

export function renderExecutorLanePanelItem(lane) {
  const stopButton = isLiveLaneState(lane.state)
    ? `<button data-action="stopLane" data-lane-id="${safeAttr(lane.id)}" type="button">Stop</button>` : '';
  const restartButton = (isLiveLaneState(lane.state) || isRestartableLaneState(lane.state))
    ? `<button class="secondary" data-action="restartLane" data-lane-id="${safeAttr(lane.id)}" type="button">Restart</button>` : '';
  const latestEvents = renderAgentEventTimeline(lane, { limit: 16, compact: true });
  return `
    <article class="executor-panel-lane">
      <div class="executor-panel-lane-head">
        <div>
          <strong>${safeText(lane.title || lane.executorType)}</strong>
          <div class="tiny muted">${safeText(lane.executorType)} / ${safeText(lane.owner)} / ${safeText(formatRelative(lane.updatedAt || lane.startedAt))}</div>
        </div>
        ${stateBadge(lane.state)}
      </div>
      <form class="lane-controls-form" data-lane-id="${safeAttr(lane.id)}">
        <input name="model" value="${safeAttr(lane.model || '')}" placeholder="model" aria-label="Model" />
        <select name="intelligenceProfile" aria-label="Intelligence">
          ${intelligenceOptions(lane.intelligenceProfile || 'high')}
        </select>
        <select name="permissionsProfile" aria-label="Mode">
          ${runModeOptions(lane.permissionsProfile || 'plan')}
        </select>
        <button type="submit">Save</button>
      </form>
      ${renderExecutorCapabilities(lane.executorCapabilities || executorCapabilitiesFor(lane.executorType), { compact: true })}
      <div class="lane-row">
        ${stopButton}
        ${restartButton}
        <a class="secondary" href="${safeAttr(lane.route || '#')}">Open</a>
      </div>
      <details class="disclosure compact-disclosure">
        <summary>Activity</summary>
        ${latestEvents}
      </details>
    </article>
  `;
}

export function renderExecutorSidePanel(session) {
  const executorLanes = shell.lanes
    .filter((lane) => lane.sessionId === session.id && lane.owner !== 'orchestrator')
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  return `
    <aside class="executor-side-panel" aria-label="Executor lanes">
      <div class="executor-panel-titlebar">
        <div>
          <strong>Executors</strong>
          <div class="tiny muted">${safeText(executorLanes.length)} lane${executorLanes.length === 1 ? '' : 's'}</div>
        </div>
        <button class="secondary" data-action="toggleExecutorPanel" type="button">Hide</button>
      </div>
      <div class="executor-panel-list">
        ${executorLanes.map(renderExecutorLanePanelItem).join('') || '<div class="muted">No executor lanes yet.</div>'}
      </div>
    </aside>
  `;
}

export function renderSession(project, session) {
  const laneList = shell.lanes.filter((lane) => lane.sessionId === session.id).map((lane) => renderLaneCard(lane)).join('');
  const pendingAudits = pendingAuditsForSession(session.id);
  const pendingAuditSummary = pendingAudits.length
    ? `<p>Pending audit events: ${pendingAudits.length}</p>`
    : '<p>No pending audit events.</p>';
  refs.content.innerHTML = `
    <section class="session-shell ${shell.executorPanelOpen ? 'executor-panel-open' : 'executor-panel-closed'}">
      <div class="session-toolbar">
        <div class="tiny muted">${safeText(project.name)} · ${safeText(session.leader)} led</div>
        <button class="secondary" data-action="toggleExecutorPanel" type="button">${shell.executorPanelOpen ? 'Hide executors' : 'Show executors'}</button>
      </div>
      <div class="session-workbench">
        <div class="session-main-column">
          ${renderOrchestratorConsole(session)}
          <div class="grid-2 session-controls">
            <article class="card control-card" id="create-session">
              <details class="disclosure">
                <summary>
                  <span>Create lane</span>
                  <small>Queue Codex, Claude, API, CLI, or mock work</small>
                </summary>
                <div class="disclosure-body">
              <form id="create-lane-form" data-session-id="${session.id}">
            <label>Title
              <input name="title" required />
            </label>
            <label>Task description
              <textarea name="taskDescription" rows="3"></textarea>
            </label>
            <label>Command (for local CLI/Codex/Claude lanes)
              <input name="command" placeholder="e.g., codex run --help" />
            </label>
            <div id="lane-command-guidance" class="tiny muted"></div>
            <label>Command args
              <input name="commandArgs" placeholder="quoted optional args or tokenized words" />
            </label>
            <label>Executor binary override
              <input name="executorBinary" placeholder="e.g., codex, claude, node, ./scripts/run.sh" />
            </label>
            <label>Working directory
              <input name="workdir" placeholder="optional workspace-relative or absolute path" />
            </label>
            <label>Executor
              <select name="executorType">
                <option value="mock">mock</option>
                ${cliExecutorOptions()}
                ${shell.executorProfiles?.cli ? '<option value="cli">cli</option>' : ''}
                ${apiProviderOptions()}
              </select>
            </label>
            <label>Task prompt (drives Codex/Claude/API requests when no explicit command)
              <textarea name="taskPrompt" rows="3" placeholder="e.g., Plan the cleanup ramp"></textarea>
            </label>
            <label>Model / profile
              <input name="model" placeholder="e.g., gpt-5 or claude-opus-4-7" />
            </label>
            <label>Intelligence
              <select name="intelligenceProfile">
                ${intelligenceOptions('high')}
              </select>
            </label>
            <label>Permissions profile
              <select name="permissionsProfile">
                ${runModeOptions('plan')}
              </select>
            </label>
            <div class="tiny muted">Orca snapshots the selected executor's detected capabilities when the lane is queued.</div>
            <label>Target URL
              <input name="targetUrl" placeholder="https://localhost:5173" />
            </label>
            <label>Branch (for worktree lanes)
              <input name="branch" placeholder="feature/auth-cleanup" />
            </label>
            <label>Verification command
              <input name="verificationCommand" placeholder="e.g., npm run smoke" />
            </label>
            <label>MCP tools
              <select name="mcpToolIds" multiple size="4" data-mcp-picker="1"></select>
              <span class="tiny muted">Tap to select; long-press on phone to multi-select. IDs are also accepted comma-separated.</span>
            </label>
            <input type="hidden" name="mcpToolIdsRaw" />
            <button type="submit">Queue lane</button>
              </form>
                </div>
              </details>
            </article>
            <article class="card control-card">
              <details class="disclosure">
                <summary>
                  <span>Session tools</span>
                  <small>${pendingAudits.length} pending audits</small>
                </summary>
                <div class="disclosure-body">
                  ${pendingAuditSummary}
                  <div class="lane-row">
                    <button class="secondary" data-action="auditDone" data-session-id="${session.id}" type="button">Audit done lanes</button>
                    <button class="secondary" data-action="refresh" type="button">Refresh</button>
                  </div>
                </div>
              </details>
            </article>
          </div>
          <section class="lane-queue">
            <div class="card-grid">${laneList || '<div class="muted">No lanes yet.</div>'}</div>
          </section>
        </div>
        ${shell.executorPanelOpen ? renderExecutorSidePanel(session) : ''}
      </div>
    </section>
  `;
  renderLaneExecutorGuidance(document.getElementById('create-lane-form'));
}

export function renderLane(project, session, lane) {
  if (!lane) {
    return `
      <section>
        <div class="card">
          <h3>Lane not found</h3>
          <p>The selected lane is not in this session yet.</p>
          <a class="secondary" href="${safeHref(session.route)}">Back to session</a>
        </div>
      </section>
    `;
  }

  const stopButton = ['running', 'starting', 'queued'].includes(lane.state)
    ? `<button data-action="stopLane" data-lane-id="${safeAttr(lane.id)}" type="button">Stop lane</button>` : '';
  const retryButton = ['failed', 'stopped'].includes(lane.state)
    ? `<button class="secondary" data-action="retryLane" data-lane-id="${safeAttr(lane.id)}" type="button">Retry lane</button>` : '';
  const artifactUrl = `/api/lanes/${lane.id}/artifacts`;
  const evidenceUrl = `/api/lanes/${lane.id}/evidence`;
  const evidenceLatestUrl = `/api/lanes/${lane.id}/evidence/latest`;
  const pendingAudits = pendingAuditsForLane(lane.id);
  const pendingAuditRows = pendingAudits.length
    ? pendingAudits.map((event) => `<div>${safeText(event.type)} (${safeText(event.id.slice(0, 8))})</div>`).join('')
    : '<div>None</div>';
  const auditLabel = pendingAudits.length ? 'Refresh audit queue' : 'Audit now';
  const laneLogs = Array.isArray(lane.logs) ? lane.logs.slice(-8) : [];
  const executorMonitorNote = lane.owner !== 'orchestrator'
    ? '<div class="alert">Executor monitor is read-only. Use Stop to interrupt the process; send new direction through the orchestrator chat.</div>'
    : '';

  const laneApprovals = (lane.pendingApprovals || []).some((entry) => entry.status === 'pending')
    ? `<article class="approvals-banner"><div class="card-kicker">Agent is asking for permission</div>${renderApprovalRows(lane)}</article>`
    : '';

  return `
    <section class="lane-detail-shell">
      ${executorMonitorNote}
      ${laneApprovals}
      ${(lane.warnings || []).map((warning) => `
        <div class="alert bad"><strong>Warning:</strong> ${safeText(warning.message || warning.kind)}</div>
      `).join('')}
      <div class="card lane-detail-card">
        <p><a href="${safeHref(session.route)}" class="secondary">Back</a></p>
        <h3>${safeText(lane.title)}</h3>
        <p>${safeText(lane.taskDescription || 'No task description')}</p>
        ${lane.taskPrompt ? `<div class="tiny"><strong>Task prompt:</strong> ${safeText(lane.taskPrompt)}</div>` : ''}
        ${lane.targetUrl ? `<div class="tiny"><strong>Target URL:</strong> <a class="secondary" href="${safeHref(lane.targetUrl)}" target="_blank" rel="noopener noreferrer">${safeText(lane.targetUrl)}</a></div>` : ''}
        <div class="tiny">Owner: ${safeText(lane.owner)} / Executor: ${safeText(lane.executorType)} / State: <span class="tag ${stateTagClass(lane.state)}">${safeText(lane.state)}</span></div>
      </div>
      <div class="card">
        <div class="lane-row">
          ${stopButton}
          ${retryButton}
          <button class="secondary" data-action="captureEvidence" data-lane-id="${lane.id}" type="button">Capture evidence</button>
          <button class="secondary" data-action="auditLane" data-lane-id="${lane.id}" type="button">${auditLabel}</button>
        </div>
      </div>
      <details class="disclosure card">
        <summary>
          <span>Details</span>
          <small>metadata, APIs, worktree</small>
        </summary>
        <div class="disclosure-body">
          <div class="tiny muted">MCP tools: ${(lane.mcpTools || []).map((item) => safeText(item.name)).join(', ') || 'none'}</div>
          <div class="tiny muted">Route: ${safeText(laneDetailRoute(project, session, lane))}</div>
          ${lane.model || lane.permissionsProfile || lane.intelligenceProfile || lane.branch ? `<div class="tiny">Model: ${safeText(lane.model || '—')} / Mode: ${safeText(lane.permissionsProfile || '—')} / Intelligence: ${safeText(lane.intelligenceProfile || '—')} / Branch: ${safeText(lane.branch || '—')}</div>` : ''}
          ${renderExecutorCapabilities(lane.executorCapabilities || executorCapabilitiesFor(lane.executorType))}
          ${lane.workdir ? `<div class="tiny">Workdir: ${safeText(lane.workdir)}</div>` : ''}
          ${lane.processMeta && lane.processMeta.pid !== null ? `<div class="tiny">Process: PID ${safeText(String(lane.processMeta.pid))} / exit ${safeText(String(lane.processMeta.exitCode ?? '—'))} / signal ${safeText(String(lane.processMeta.signal ?? '—'))}${lane.processMeta.stopRequestedBy ? ' / stopped by ' + safeText(lane.processMeta.stopRequestedBy) : ''}</div>` : ''}
          <div class="tiny">Pending audits: ${pendingAudits.length}</div>
          <div class="tiny">Pending events: ${pendingAuditRows}</div>
          <div class="tiny">Created: ${formatMeta(lane.createdAt)} / Started: ${formatMeta(lane.startedAt)} / Completed: ${formatMeta(lane.completedAt)}</div>
          <div class="lane-row">
            <button class="secondary" data-action="clearEvidence" data-lane-id="${lane.id}" type="button">Clear evidence</button>
            <button class="secondary" data-action="showArtifacts" data-lane-id="${lane.id}" type="button">Artifacts</button>
            ${lane.worktreePath && lane.repoRoot ? `<button class="secondary" data-action="removeWorktree" data-lane-id="${lane.id}" type="button">Remove worktree</button>` : ''}
            <a class="secondary" href="${artifactUrl}" target="_blank" rel="noopener noreferrer">Artifacts API</a>
            <a class="secondary" href="${evidenceUrl}" target="_blank" rel="noopener noreferrer">Evidence API</a>
            <a class="secondary" href="${evidenceLatestUrl}" target="_blank" rel="noopener noreferrer">Latest evidence API</a>
          </div>
        </div>
      </details>
      <details class="disclosure card">
        <summary>
          <span>Agent activity</span>
          <small>${safeText(String((lane.agentEvents || []).length))} events</small>
        </summary>
        <div class="disclosure-body">
          ${renderAgentEventTimeline(lane, { limit: 120, compact: true })}
        </div>
      </details>
      <details class="disclosure card">
        <summary>
          <span>Recent logs</span>
          <small>${safeText(laneLogs.length)} entries</small>
        </summary>
        <pre>${safeText(JSON.stringify(laneLogs, null, 2))}</pre>
      </details>
      <div class="card">
        <h4>Last evidence</h4>
        <div class="tiny muted">Captured: ${safeText(lane.lastEvidenceCaptureAt || 'never')}</div>
        <div class="tiny muted">Result: ${safeText(lane.lastEvidence?.status || 'not captured')}</div>
      </div>
      <div class="card">
        <h4>Evidence gallery</h4>
        <div id="evidence-gallery-${lane.id}" class="tiny muted">Loading latest evidence...</div>
      </div>
      <div id="lane-artifacts-${lane.id}" class="card tiny"></div>
    </section>
  `;
}

export function renderAuditLog() {
  if (activeHomePanel() !== 'audit') return;
  const events = Array.isArray(shell.pendingAuditEvents) ? shell.pendingAuditEvents : [];
  if (!events.length) {
    refs.actions.innerHTML = `
      <section class="home-hero">
        <div>
          <div class="card-kicker">Audit queue</div>
          <h2>No pending audits.</h2>
          <p class="muted">Finished lanes that need review will show up here.</p>
        </div>
        <a class="nav-tile" href="#projects">Back to projects</a>
      </section>
    `;
    return;
  }
  const rows = events.map((event) => {
    const project = shell.projects.find((value) => value.id === event.projectId);
    const laneRoute = project && event.sessionId && event.laneId
      ? `${project.route}/sessions/${event.sessionId}/lanes/${event.laneId}`
      : '';
    return `
      <article class="card">
        <p><strong>${safeText(event.summary || event.type || 'Audit event')}</strong></p>
        <div class="tiny">Type: ${safeText(event.type || 'unknown')}</div>
        <div class="tiny">Project: ${safeText(event.projectId || 'unknown')}</div>
        <div class="tiny">Lane: ${safeText(event.laneId || 'n/a')}</div>
        ${laneRoute ? `<a class="secondary" href="${safeHref(laneRoute)}">Open lane</a>` : ''}
        <div class="lane-row" style="margin-top:0.75rem">
          <button class="secondary" data-action="ackAuditEvent" data-event-id="${safeAttr(event.id)}" type="button">Mark reviewed</button>
        </div>
      </article>
    `;
  }).join('');
  refs.actions.innerHTML = `<div class="card"><h3>Open audit queue</h3><div class="card-grid">${rows}</div></div>`;
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
  const executorTags = ['codex', 'claude'].map((type) => {
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
  const renderSidebarProject = (project) => {
    const projectSessions = orderItems(
      (shell.sessions || []).filter((session) => session.projectId === project.id),
      storedOrder.sessions[project.id] || [],
    );
    const lanes = (shell.lanes || []).filter((lane) => lane.projectId === project.id);
    const active = lanes.filter((lane) => ['running', 'starting', 'queued'].includes(lane.state)).length;
    const sessionRows = projectSessions.slice(0, 4).map((session) => {
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
            <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
              <path d="M3.2 6.5h13.6"></path>
              <path d="M5 6.5v9.2c0 .8.6 1.4 1.4 1.4h7.2c.8 0 1.4-.6 1.4-1.4V6.5"></path>
              <path d="M7.2 3.3h5.6l.8 3.2H6.4l.8-3.2Z"></path>
              <path d="M8 10h4"></path>
            </svg>
          </button>
        </div>
      `;
    }).join('');
    return `
      <div class="sidebar-project-group" draggable="true" data-reorder-kind="project" data-project-id="${safeAttr(project.id)}">
        <div class="sidebar-project-line">
          <a class="sidebar-link" href="${safeAttr(project.route)}" data-route-project="${safeAttr(project.slug)}">
            ${FOLDER_ICON}
            <span>${safeText(project.name)}</span>
            ${active ? `<span class="pill" title="${active} active lanes">${active}</span>` : ''}
          </a>
          <a class="sidebar-compose" href="${safeAttr(project.route)}#create-session" aria-label="Create session in ${safeAttr(project.name)}">${COMPOSE_ICON}</a>
          <button class="sidebar-project-rename" data-action="renameProject" data-project-id="${safeAttr(project.id)}" data-project-name="${safeAttr(project.name)}" type="button" aria-label="Rename ${safeAttr(project.name)} project" title="Rename project">
            ${PENCIL_ICON}
          </button>
          <button class="sidebar-project-archive" data-action="archiveProject" data-project-id="${safeAttr(project.id)}" data-project-name="${safeAttr(project.name)}" type="button" aria-label="Archive ${safeAttr(project.name)} project">
            <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
              <path d="M3.2 6.5h13.6"></path>
              <path d="M5 6.5v9.2c0 .8.6 1.4 1.4 1.4h7.2c.8 0 1.4-.6 1.4-1.4V6.5"></path>
              <path d="M7.2 3.3h5.6l.8 3.2H6.4l.8-3.2Z"></path>
              <path d="M8 10h4"></path>
            </svg>
          </button>
        </div>
        ${sessionRows || '<div class="tiny muted sidebar-empty">No sessions yet.</div>'}
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

export async function loadEvidenceGallery(laneId) {
  const target = document.getElementById(`evidence-gallery-${laneId}`);
  if (!target) return;
  try {
    const [latest, presets] = await Promise.all([
      api(`/api/lanes/${laneId}/evidence/latest`),
      api(`/api/lanes/${laneId}/evidence/presets`),
    ]);
    const files = latest.data?.files || {};
    const presetList = presets.data?.presets || [];
    const tiles = ['screenshot', 'video', 'trace', 'log'].map((mode) => {
      const item = files[mode];
      if (!item) return `<div class="card"><strong>${mode}</strong><div class="tiny muted">none yet</div></div>`;
      const link = `<a class="secondary" href="${safeHref(item.url)}" target="_blank" rel="noopener noreferrer">Open</a>`;
      const preview = mode === 'screenshot'
        ? `<img src="${safeHref(item.url)}" alt="${safeAttr(mode)}" style="max-width:100%;border-radius:8px;margin-top:0.4rem" loading="lazy" />`
        : '';
      return `<div class="card"><strong>${mode}</strong><div class="tiny">${safeText(item.name)} · ${safeText(item.at)}</div>${preview}<div style="margin-top:0.4rem">${link}</div></div>`;
    }).join('');
    const presetsRow = presetList.length
      ? `<div class="lane-row" style="margin-top:0.4rem">${presetList.map((preset) => `<button class="secondary" data-action="captureEvidencePreset" data-lane-id="${safeAttr(laneId)}" data-preset-id="${safeAttr(preset.id)}" data-preset-label="${safeAttr(preset.label || preset.url)}" type="button">${safeText(preset.label || preset.url)}</button>`).join('')}</div>`
      : '<div class="tiny muted">No presets — set a lane target URL or project quick links to populate.</div>';
    target.innerHTML = `${presetsRow}<div class="card-grid" style="margin-top:0.5rem">${tiles}</div>`;
  } catch {
    target.textContent = 'Could not load evidence gallery.';
  }
}

export function renderMobileManifest() {
  api('/api/mobile/manifest')
    .then(({ data }) => {
      if (!data) return;
      shell.mobileManifest = data;
    })
    .catch(() => {});
}
