const shell = {
  route: {
    projectSlug: null,
    sessionId: null,
    laneId: null,
  },
  projects: [],
  sessions: [],
  lanes: [],
  policy: {},
  alerts: [],
  mobileManifest: null,
  apiToken: '',
  cleanupSchedule: null,
  pendingAuditEvents: [],
  mcpTools: [],
  executorProfiles: null,
  executorCliInfo: {},
  systemBlockers: [],
};

const MCP_TOOL_SCOPE_ALLOWLIST = ['all', 'codex', 'claude', 'mock'];

const refs = {
  breadcrumbs: document.getElementById('breadcrumbs'),
  alerts: document.getElementById('alerts'),
  content: document.getElementById('content'),
  statusStrip: document.getElementById('status-strip'),
  blockers: document.getElementById('blockers'),
  sidebarProjects: document.getElementById('sidebar-projects'),
  topbarSubtitle: document.getElementById('topbar-subtitle'),
};
// Audit queue is rendered inside refs.content for the new operator shell.
refs.actions = refs.content;
const API_TOKEN_STORAGE_KEY = 'commandDeckApiToken';

function parseRoute() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const route = { projectSlug: null, sessionId: null, laneId: null };
  if (parts.length >= 2 && parts[0] === 'projects') {
    route.projectSlug = parts[1];
    if (parts[2] === 'sessions' && parts[3]) {
      route.sessionId = parts[3];
      if (parts[4] === 'lanes' && parts[5]) {
        route.laneId = parts[5];
      }
    }
  }
  return route;
}

function initializeApiToken() {
  const saved = window.sessionStorage.getItem(API_TOKEN_STORAGE_KEY);
  shell.apiToken = saved || '';
  const params = new URLSearchParams(window.location.search);
  const queryToken = (params.get('apiToken') || params.get('token') || '').trim();
  if (queryToken) {
    shell.apiToken = queryToken;
    window.sessionStorage.setItem(API_TOKEN_STORAGE_KEY, queryToken);
  }
}

function setApiToken(token) {
  const nextToken = (token || '').trim();
  shell.apiToken = nextToken;
  if (nextToken) {
    window.sessionStorage.setItem(API_TOKEN_STORAGE_KEY, nextToken);
  } else {
    window.sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
  }
}

function safeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function safeAttr(value) {
  return safeText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function stateBadge(state) {
  const map = {
    queued: ['Queued', 'warn'],
    starting: ['Starting', 'warn'],
    running: ['Running', 'ok'],
    done: ['Done', 'ok'],
    stopped: ['Stopped', 'bad'],
    failed: ['Failed', 'bad'],
  };
  const [label, tone] = map[state] || [state, 'warn'];
  return `<span class="tag ${tone}">${label}</span>`;
}

function normalizeExecutorType(raw) {
  return String(raw || '').toLowerCase().trim();
}

function parseCommandParts(raw) {
  return String(raw || '').trim().split(/\s+/).filter(Boolean);
}

function executorTargetsCommand(executorType, commandParts) {
  const normalizedType = normalizeExecutorType(executorType);
  if (!normalizedType) return true;
  if (!Array.isArray(commandParts) || !commandParts.length) return true;
  return String(commandParts[0]).toLowerCase().includes(normalizedType);
}

function executorTargetsBinary(executorType, binary) {
  const normalizedType = normalizeExecutorType(executorType);
  if (!normalizedType) return true;
  const normalizedBinary = String(binary || '').trim().toLowerCase();
  const binaryName = normalizedBinary.split('/').pop();
  return binaryName.includes(normalizedType);
}

function getExecutorProfile(type) {
  const profileType = normalizeExecutorType(type);
  return shell.executorProfiles && shell.executorProfiles[profileType] ? shell.executorProfiles[profileType] : null;
}

function getExecutorScopedMcpTools(executorType) {
  const normalizedType = normalizeExecutorType(executorType);
  const tools = Array.isArray(shell.mcpTools) ? shell.mcpTools : [];
  return tools.filter((tool) => {
    const scope = Array.isArray(tool.scope) && tool.scope.length
      ? tool.scope.map((value) => String(value || '').toLowerCase())
      : [];
    return tool.enabled !== false && (!scope.length || scope.includes('all') || scope.includes(normalizedType));
  });
}

function findMcpTool(locator) {
  if (!locator) return null;
  const target = String(locator).trim().toLowerCase();
  return Array.isArray(shell.mcpTools)
    ? shell.mcpTools.find((tool) => (tool.id === target || tool.name === target))
    : null;
}

function normalizeMcpToolScopes(rawScopes) {
  const scopes = Array.isArray(rawScopes)
    ? rawScopes
    : String(rawScopes || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const normalized = Array.from(new Set(scopes));
  const invalid = normalized.filter((scope) => !MCP_TOOL_SCOPE_ALLOWLIST.includes(scope));
  if (invalid.length) {
    return {
      scopes: null,
      error: `Unsupported MCP scope(s): ${invalid.join(', ')}`,
    };
  }
  return { scopes: normalized.length ? normalized : ['all'], error: null };
}

function renderLaneExecutorGuidance(form) {
  if (!form || form.id !== 'create-lane-form') return;
  const profileEl = document.getElementById('lane-command-guidance');
  if (!profileEl) return;
  const selectedType = normalizeExecutorType(form.executorType?.value || 'mock');
  const profile = getExecutorProfile(selectedType);
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

  commandInput.placeholder = 'e.g., node';
  binaryInput.placeholder = 'e.g., codex, claude, node, ./scripts/run.sh';
  profileEl.textContent = toolSummary;
}

function laneDetailRoute(project, session, lane) {
  if (!project || !session || !lane) return '';
  return lane.route || `/projects/${project.slug}/sessions/${session.id}/lanes/${lane.id}`;
}

function formatMeta(timeString) {
  if (!timeString) return 'n/a';
  return new Date(timeString).toLocaleTimeString();
}

function formatRelative(timeString) {
  if (!timeString) return 'never';
  const timestamp = new Date(timeString).getTime();
  if (!Number.isFinite(timestamp)) return 'unknown';
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function latestTimestamp(items) {
  const timestamps = (items || [])
    .map((item) => new Date(item.updatedAt || item.completedAt || item.createdAt || 0).getTime())
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function isVerificationProject(project) {
  const slug = String(project?.slug || '').toLowerCase();
  const name = String(project?.name || '').toLowerCase();
  return slug.startsWith('smoke-') || name.startsWith('smoke ');
}

function activeHomePanel() {
  const panel = String(window.location.hash || '').replace(/^#/, '').toLowerCase();
  const allowed = new Set(['projects', 'create', 'system', 'mcp', 'audit', 'cleanup', 'token']);
  return allowed.has(panel) ? panel : 'overview';
}

function stateTagClass(state) {
  switch (String(state || '').toLowerCase()) {
    case 'done': return 'ok';
    case 'running':
    case 'starting': return '';
    case 'failed': return 'bad';
    case 'stopped':
    case 'queued': return 'warn';
    default: return '';
  }
}

function getActionPolicy(actionKey) {
  return shell.policy?.[actionKey] || { requiresApproval: false, risk: 'low', message: '' };
}

function needsApproval(actionKey) {
  return Boolean(getActionPolicy(actionKey).requiresApproval);
}

function confirmHighRiskAction(message, actionKey) {
  const policy = getActionPolicy(actionKey);
  if (!policy.requiresApproval) return true;
  const policyMessage = policy.message || 'This action requires explicit approval.';
  return window.confirm(`${message}\n${policyMessage}`);
}

function pendingAuditsForLane(laneId) {
  if (!Array.isArray(shell.pendingAuditEvents)) return [];
  const target = String(laneId || '');
  if (!target) return [];
  return shell.pendingAuditEvents.filter((event) => String(event.laneId || '') === target);
}

function pendingAuditsForSession(sessionId) {
  if (!Array.isArray(shell.pendingAuditEvents)) return [];
  const target = String(sessionId || '');
  if (!target) return [];
  return shell.pendingAuditEvents.filter((event) => String(event.sessionId || '') === target);
}

function renderAlert(text, level = 'info') {
  refs.alerts.innerHTML = `<div class="card ${level}">${safeText(text)}</div>`;
  clearTimeout(renderAlert.timer);
  renderAlert.timer = setTimeout(() => {
    if (refs.alerts) refs.alerts.innerHTML = '';
  }, 3500);
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (shell.apiToken) {
    headers['x-commanddeck-token'] = shell.apiToken;
  }
  const resp = await fetch(path, {
    headers,
    ...options,
    body: options.body ? JSON.stringify(options.body) : options.body,
  });
  const bodyText = await resp.text();
  let bodyJson = null;
  if (bodyText) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      bodyJson = { raw: bodyText };
    }
  }
  return { ok: resp.ok, status: resp.status, data: bodyJson };
}

function renderBreadcrumbs(project, session) {
  const links = ['<a href="/">Home</a>'];
  if (project) {
    links.push(`<a href="${project.route}">${safeText(project.name)}</a>`);
  }
  if (session) {
    links.push(`<a href="${session.route}">${safeText(session.name)}</a>`);
  }
  refs.breadcrumbs.innerHTML = `<div>${links.join(' / ')}</div>`;
}

function renderHome() {
  const panel = activeHomePanel();
  const artifactCleanupUrl = shell.mobileManifest?.artifactCleanupUrl || '/api/artifacts/cleanup';
  const scheduleApiUrl = shell.mobileManifest?.artifactCleanupScheduleUrl || '/api/artifacts/cleanup/schedule';
  const scheduleRunApiUrl = shell.mobileManifest?.artifactCleanupNowUrl || '/api/artifacts/cleanup/run-now';
  const schedule = shell.cleanupSchedule || {};
  const tokenConfigured = Boolean(shell.apiToken);
  const cleanupNext = schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : 'not scheduled';
  const mcpTools = shell.mcpTools || [];
  const mcpOptions = mcpTools.map((tool) => `
    <div class="lane-row" style="align-items:center; justify-content:space-between;">
      <div>
        <span>${safeText(tool.name)} (${safeText(tool.command)})</span>
        <div class="tiny muted">scope: ${safeText((tool.scope || []).join(', ') || 'all')} · args: ${safeText((tool.args || []).join(' ')) || 'none'} · enabled: ${tool.enabled ? 'yes' : 'no'}</div>
      </div>
      <div class="lane-row">
        <button data-action="editMcpTool" data-tool-id="${safeText(tool.id || tool.name)}" type="button">Edit</button>
        <button class="secondary" data-action="deleteMcpTool" data-tool-id="${safeText(tool.id || tool.name)}" type="button">Delete</button>
      </div>
    </div>
  `).join('');
  const profiles = shell.executorProfiles || {};
  const profileRows = Object.values(profiles).map((profile) => {
    const typeUpper = String(profile.type || '').toUpperCase();
    const envKey = typeUpper ? `COMMAND_DECK_${typeUpper}` : null;
    const modelEnv = envKey ? `${envKey}_MODEL` : '';
    const permissionsEnv = envKey ? `${envKey}_PERMISSIONS` : '';
    return `
    <div class="lane-row">
      <div>
        <strong>${safeText(profile.type || profile.name || '')}</strong>
        <div class="tiny muted">binary: ${safeText(profile.defaultBinary || '')}</div>
        <div class="tiny muted">defaults: ${safeText((profile.defaultArgs || []).join(' ') || 'none')}</div>
        <div class="tiny muted">allowlist: ${(profile.allowedBinaries || []).slice(0, 6).join(', ') || 'default'}</div>
        <div class="tiny muted">model: per-lane (lane.model overrides). Set env ${safeText(modelEnv)} for default.</div>
        <div class="tiny muted">permissions: per-lane (lane.permissionsProfile). Suggested values: plan / restricted / full.</div>
        <div class="tiny muted">env allowlist: ${(profile.envWhitelist || []).slice(0, 6).join(', ') || 'default'}</div>
        <div class="tiny muted">workdir roots: ${(profile.workdirRoots || []).slice(0, 3).join(', ') || 'default'}</div>
      </div>
    </div>
  `;
  }).join('');
  const cliRows = Object.entries(shell.executorCliInfo || {}).map(([type, info]) => {
    const command = Array.isArray(info?.reinstall?.command)
      ? safeText(info.reinstall.command.join(' '))
      : 'not configured';
    const preferSource = info?.reinstall?.preferSource ? 'enabled' : 'disabled';
    const sourceRepos = Array.isArray(info?.reinstall?.sourceRepos)
      ? info.reinstall.sourceRepos.join(', ')
      : 'not configured';
    const sourceCommand = Array.isArray(info?.reinstall?.sourceCommand)
      ? safeText(info.reinstall.sourceCommand.join(' '))
      : 'not available';
    const hasSourceCommand = Array.isArray(info?.reinstall?.sourceCommand) && info?.reinstall?.sourceCommand.length > 0;
    const sourceButton = hasSourceCommand
      ? `<button class="secondary" data-action="reinstallExecutorCli" data-executor="${safeText(type)}" data-use-source="true" type="button">Dry-run source reinstall</button>`
      : `<button class="secondary" type="button" disabled title="No trusted source command configured">Source reinstall unavailable</button>`;
    return `
      <div class="lane-row" style="align-items:center; justify-content:space-between;">
        <div>
          <strong>${safeText(type.toUpperCase())}</strong>
          <div class="tiny muted">binary: ${safeText(info?.binary || '')}</div>
          <div class="tiny muted">version: ${safeText(info?.version || 'unknown')}</div>
          <div class="tiny muted">reinstall: ${command}</div>
        <div class="tiny muted">source-first mode: ${safeText(preferSource)}</div>
        <div class="tiny muted">source repos: ${safeText(sourceRepos)}</div>
        <div class="tiny muted">source command: ${safeText(sourceCommand)}</div>
        </div>
        <div class="lane-row">
          <button data-action="refreshExecutorCli" data-executor="${safeText(type)}" type="button">Refresh</button>
          <button class="secondary" data-action="reinstallExecutorCli" data-executor="${safeText(type)}" data-use-source="false" type="button">Dry-run reinstall</button>
          ${sourceButton}
        </div>
      </div>
    `;
  }).join('');
  const renderProjectCard = (project) => {
    const projectSessions = shell.sessions.filter((session) => session.projectId === project.id);
    const projectLanes = shell.lanes.filter((lane) => lane.projectId === project.id);
    const latestActivity = latestTimestamp([...projectSessions, ...projectLanes, project]);
    const quickLinks = project.quickLinks.map((quick) => `
      <div><a href="${safeText(quick.url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.label)}</a></div>
    `).join('');
    return `
      <article class="card click-card project-card" data-href="${safeAttr(project.route)}" tabindex="0" role="link" aria-label="Open ${safeAttr(project.name)} project">
        <div class="card-kicker">Project</div>
        <h3>${safeText(project.name)}</h3>
        <p>${safeText(project.notes?.[0] || 'Open the project board, sessions, lanes, and live links.')}</p>
        <div class="card-meta">
          <span>${safeText(projectSessions.length)} session${projectSessions.length === 1 ? '' : 's'}</span>
          <span>${safeText(projectLanes.length)} lane${projectLanes.length === 1 ? '' : 's'}</span>
          <span>active ${safeText(formatRelative(latestActivity))}</span>
        </div>
        <details class="disclosure compact-disclosure">
          <summary>Links and route</summary>
          <div class="lane-row">${quickLinks || '<div class="muted">No quick links yet.</div>'}</div>
          <div class="tiny muted">Route: <a href="${safeAttr(project.route)}">${safeText(project.route)}</a></div>
        </details>
        <div class="lane-row">
          <a class="button-secondary" href="${project.route}">Open project</a>
        </div>
      </article>
    `;
  };
  const primaryProjectCards = shell.projects.filter((project) => !isVerificationProject(project)).map(renderProjectCard).join('');
  const verificationProjects = shell.projects.filter(isVerificationProject);
  const verificationProjectCards = verificationProjects.map(renderProjectCard).join('');
  const primaryProjects = shell.projects.filter((project) => !isVerificationProject(project));
  const projectRows = primaryProjects.map((project) => `
    <a class="simple-row" href="${safeAttr(project.route)}">
      <span class="row-icon">▱</span>
      <span>${safeText(project.name)}</span>
    </a>
  `).join('');
  const recentLanes = [...(shell.lanes || [])]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .filter((lane) => {
      const project = shell.projects.find((item) => item.id === lane.projectId);
      return project && !isVerificationProject(project);
    })
    .slice(0, 5);
  const recentRows = recentLanes.map((lane) => `
    <a class="simple-row recent-row" href="${safeAttr(lane.route || '')}">
      <span>${safeText(lane.title || 'Untitled lane')}</span>
      <small>${safeText(lane.executorType)} · ${safeText(lane.state)}</small>
    </a>
  `).join('');
  const preferredSession = shell.sessions.find((session) => {
    const project = shell.projects.find((item) => item.id === session.projectId);
    return project && !isVerificationProject(project);
  });
  const chatHref = preferredSession?.route || '#projects';
  const showMainHome = panel === 'overview' || panel === 'projects';

  refs.content.innerHTML = `
    <section class="simple-home ${showMainHome ? '' : 'is-hidden'}">
      <div>
        <h2>Command Deck</h2>
        <p class="muted">Open a project, jump to a recent lane, or start a new agent conversation.</p>
      </div>
      <a class="settings-link" href="#system">Settings</a>
    </section>
    <section class="simple-section ${showMainHome ? '' : 'is-hidden'}">
      <h3>Projects</h3>
      <a class="simple-row" href="#create">
        <span class="row-icon">＋</span>
        <span>New project</span>
      </a>
      ${projectRows || '<div class="muted">No projects yet.</div>'}
    </section>
    <section class="simple-section ${showMainHome ? '' : 'is-hidden'}">
      <h3>Recents</h3>
      ${recentRows || '<div class="muted">No recent lanes yet.</div>'}
    </section>
    <section class="simple-section simple-more ${showMainHome ? '' : 'is-hidden'}">
      <h3>More</h3>
      <a class="simple-row" href="#audit">Audit queue</a>
      <a class="simple-row" href="#mcp">MCP tools</a>
      <a class="simple-row" href="#cleanup">Cleanup</a>
      <a class="simple-row" href="#token">API token</a>
    </section>
    <a class="floating-chat ${showMainHome ? '' : 'is-hidden'}" href="${safeAttr(chatHref)}">Chat</a>
    <div class="stat-grid compact-stats settings-stats is-hidden">
      <div class="stat">
        <b>${shell.projects.length}</b>
        <span>Projects</span>
      </div>
    </div>
    <section class="grid-2 home-panels" data-active-panel="${safeAttr(panel)}">
      <article class="card control-card" id="section-token" data-panel-card="token">
        <h3>API token</h3>
        <div class="tiny muted">${tokenConfigured ? 'Configured for mutating requests.' : 'No token configured.'}</div>
        <label>Token
          <input id="api-token-input" type="password" placeholder="Enter token" autocomplete="off" />
        </label>
        <div class="lane-row">
          <button class="secondary" data-action="setApiToken" type="button">Save token</button>
          <button class="secondary" data-action="clearApiToken" type="button">Clear token</button>
        </div>
      </article>
        <article class="card control-card" id="section-system" data-panel-card="system">
        <details class="disclosure" open>
          <summary>
            <span>Executor profiles</span>
            <small>Defaults, binaries, workdirs</small>
          </summary>
          <div class="disclosure-body">${profileRows || '<div class="muted">No executor profiles loaded yet.</div>'}</div>
        </details>
      </article>
      <article class="card control-card" data-panel-card="system">
        <details class="disclosure" open>
          <summary>
            <span>Executor CLI health and updates</span>
            <small>Codex, Claude, reinstall dry-runs</small>
          </summary>
          <div class="disclosure-body">${cliRows || '<div class="muted">No CLI data yet.</div>'}</div>
        </details>
      </article>
      <article class="card control-card" id="section-cleanup" data-panel-card="cleanup">
        <details class="disclosure">
          <summary>
            <span>Artifact cleanup schedule</span>
            <small>${schedule.enabled ? `Enabled · next ${safeText(cleanupNext)}` : 'Disabled'}</small>
          </summary>
          <div class="disclosure-body">
        <div class="tiny muted">Status: ${schedule.enabled ? `Enabled · next run ${cleanupNext}` : 'Disabled'}</div>
        <form id="cleanup-schedule-form" data-url="${scheduleApiUrl}" data-action-source="cleanup-schedule">
          <label><input type="checkbox" name="enabled" ${schedule.enabled ? 'checked' : ''}> Enable periodic cleanup</label>
          <label>Interval hours
            <input name="intervalHours" type="number" min="1" max="720" step="0.5" value="${safeText(schedule.intervalHours || 24)}" />
          </label>
        <label>Prune older than (days)
            <input name="olderThanDays" type="number" min="1" placeholder="default session retention" value="${safeText(schedule.olderThanDays || '')}" />
          </label>
          <label>Target session id (optional)
            <input name="sessionId" placeholder="leave blank for all sessions" value="${safeText(schedule.sessionId || '')}" />
          </label>
          <label><input type="checkbox" name="dryRun" ${schedule.dryRun ? 'checked' : ''}> Dry run mode</label>
          <button type="submit">Save cleanup schedule</button>
        </form>
        <div class="lane-row" style="margin-top:0.65rem">
          <button class="secondary" data-action="cleanupArtifactsRunNow" data-url="${scheduleRunApiUrl}" type="button">Run cleanup now</button>
        </div>
          </div>
        </details>
      </article>
      <article class="card control-card" id="section-mcp" data-panel-card="mcp">
        <details class="disclosure">
          <summary>
            <span>Custom MCP tools</span>
            <small>${safeText(mcpTools.length)} configured</small>
          </summary>
          <div class="disclosure-body">
        <div class="tiny muted">Configured tools: ${safeText(mcpTools.length)}</div>
        <div>${mcpOptions || '<div class="muted">No MCP tools yet.</div>'}</div>
        <form id="create-mcp-tool-form">
          <label>Name
            <input name="name" placeholder="eg: files" required />
          </label>
          <label>Command
            <input name="command" placeholder="single executable token, eg: node" required />
            <div class="tiny muted">Examples: node, npx, python</div>
          </label>
          <label>Args
            <input name="args" placeholder="comma separated args" />
          </label>
          <label>Scope
            <input name="scope" placeholder="all,codex,claude" />
            <div class="tiny muted">Allowed scopes: all, codex, claude, mock</div>
          </label>
          <label>Notes
            <input name="notes" />
          </label>
          <label><input type="checkbox" name="enabled" checked> enabled</label>
          <button type="submit">Add MCP tool</button>
        </form>
          </div>
        </details>
      </article>
      <div class="card control-card" data-panel-card="create">
        <details class="disclosure">
          <summary>
            <span>Create project</span>
            <small>Add a new command surface</small>
          </summary>
          <div class="disclosure-body">
        <form id="create-project-form">
          <label>Project name
            <input name="name" required placeholder="Project name" />
          </label>
          <label>Slug
            <input name="slug" placeholder="optional" />
          </label>
          <label>Local quick link
            <input name="quickLink" placeholder="http://localhost:3000" />
          </label>
          <button type="submit">Create project</button>
        </form>
          </div>
        </details>
      </div>
      <div class="card" data-panel-card="projects">
        <h3>Project list</h3>
        <div class="card-grid">${primaryProjectCards || '<div class="muted">No projects yet.</div>'}</div>
        ${verificationProjectCards ? `
          <details class="disclosure compact-disclosure">
            <summary>
              <span>Verification runs</span>
              <small>${safeText(verificationProjects.length)} smoke project${verificationProjects.length === 1 ? '' : 's'}</small>
            </summary>
            <div class="card-grid">${verificationProjectCards}</div>
          </details>
        ` : ''}
      </div>
      <article class="card" data-panel-card="cleanup">
        <h3>System actions</h3>
        <button
          class="secondary"
          data-action="cleanupArtifacts"
          data-url="${artifactCleanupUrl}"
          type="button"
        >Run artifact cleanup</button>
      </article>
    </section>
  `;
}

function renderProject(project) {
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

  refs.content.innerHTML = `
    <section>
      <div class="card">
        <h3>${safeText(project.name)} project</h3>
        <p>Quick links and dev routes can be added directly in the session lane workflows.</p>
        <div class="lane-row">
          ${project.quickLinks.map((quick) => `<a href="${safeText(quick.url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.label)}</a>`).join('') || '<span class="muted">No quick links.</span>'}
        </div>
      </div>
      <div class="grid-2">
        <article class="card control-card">
          <details class="disclosure">
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
      <article class="card control-card">
        <details class="disclosure">
          <summary>
            <span>Quick links</span>
            <small>Project URLs and phone targets</small>
          </summary>
          <div class="disclosure-body">
        <div class="card-grid">
          ${(project.quickLinks || [])
            .map((quick, index) => `
              <div class="lane-row">
                <div>
                  <div>${safeText(quick.label || 'Primary')}</div>
                  <a href="${safeText(quick.url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.url)}</a>
                </div>
                <button class="secondary" data-action="deleteProjectQuickLink" data-project-id="${project.id}" data-link-index="${index}" type="button">Remove</button>
              </div>
            `).join('') || '<div class="muted">No quick links.</div>'}
        </div>
        <form id="update-project-links-form" data-project-id="${project.id}">
          <label>Quick link label
            <input name="quickLinkLabel" placeholder="Primary" required />
          </label>
          <label>Quick link URL
            <input name="quickLinkUrl" placeholder="http://localhost:3000" required />
          </label>
          <button type="submit">Add quick link</button>
        </form>
          </div>
        </details>
      </article>
    </section>
  `;
}

function renderLaneCard(lane) {
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
    ? `<button data-action="stopLane" data-lane-id="${lane.id}" title="${getActionPolicy('stopLane').message}" type="button">Stop lane</button>` : '';
  const retryButton = ['failed', 'stopped'].includes(lane.state)
    ? `<button class="secondary" data-action="retryLane" data-lane-id="${lane.id}" title="${getActionPolicy('retryLane').message}" type="button">Retry lane</button>` : '';
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
      <details class="disclosure compact-disclosure">
        <summary>Lane metadata</summary>
        <div class="tiny">
          Started: ${formatMeta(lane.startedAt)} · Heartbeat: ${formatMeta(lane.heartbeatAt)} · Last evidence: ${safeText(lane.lastEvidenceCaptureAt || 'never')} (${safeText(lane.lastEvidence?.status || 'not captured')})
        </div>
        <div class="muted tiny">Path: ${safeText(lane.artifactPath || '')}</div>
      </details>
      ${laneAuditWarning}
      <div class="lane-row">
        ${stopButton}
        ${retryButton}
        ${laneLink}
        <button class="secondary" data-action="captureEvidence" data-lane-id="${lane.id}" type="button">Capture evidence</button>
        <button class="secondary" data-action="clearEvidence" data-lane-id="${lane.id}" type="button">Clear evidence</button>
        <button class="secondary" data-action="auditLane" data-lane-id="${lane.id}" type="button">${auditLabel}</button>
        <button class="secondary" data-action="showArtifacts" data-lane-id="${lane.id}" type="button">Artifacts</button>
        <a class="secondary" href="${artifactsLink}" target="_blank" rel="noopener noreferrer">Artifact API</a>
        <a class="secondary" href="${evidenceLatestUrl}" target="_blank" rel="noopener noreferrer">Latest evidence</a>
      </div>
      <div id="lane-artifacts-${lane.id}" class="tiny"></div>
    </article>
  `;
}

function renderSession(project, session) {
  const laneList = shell.lanes.filter((lane) => lane.sessionId === session.id).map((lane) => renderLaneCard(lane)).join('');
  const pendingAudits = pendingAuditsForSession(session.id);
  const pendingAuditSummary = pendingAudits.length
    ? `<p>Pending audit events: ${pendingAudits.length}</p>`
    : '<p>No pending audit events.</p>';
  refs.content.innerHTML = `
    <section>
      <div class="card">
        <h3>${safeText(session.name)}</h3>
        <p>Project: ${safeText(project.name)} — leader ${safeText(session.leader)}</p>
        <p>Policy profile: ${safeText(session.policyProfile || 'default')}</p>
      </div>
      <div class="grid-2">
        <article class="card control-card">
          <details class="disclosure">
            <summary>
              <span>Create lane</span>
              <small>Queue Codex, Claude, or mock work</small>
            </summary>
            <div class="disclosure-body">
          <form id="create-lane-form" data-session-id="${session.id}">
            <label>Title
              <input name="title" required />
            </label>
            <label>Task description
              <textarea name="taskDescription" rows="3"></textarea>
            </label>
            <label>Command (for codex/claude lanes)
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
                <option value="codex">codex</option>
                <option value="claude">claude</option>
              </select>
            </label>
            <label>Task prompt (drives generated codex/claude argv when no explicit command)
              <textarea name="taskPrompt" rows="3" placeholder="e.g., Plan the cleanup ramp"></textarea>
            </label>
            <label>Model / profile
              <input name="model" placeholder="e.g., gpt-5 or claude-opus-4-7" />
            </label>
            <label>Permissions profile
              <input name="permissionsProfile" placeholder="e.g., plan, restricted, full" />
            </label>
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
        <article class="card">
          <h3>Session actions</h3>
          ${pendingAuditSummary}
          <button class="secondary" data-action="auditDone" data-session-id="${session.id}" type="button">Audit all done lanes</button>
          <button data-action="refresh" type="button">Refresh</button>
        </article>
      </div>
      <section class="card">
        <h3>Lane queue</h3>
        <div class="card-grid">${laneList || '<div class="muted">No lanes yet.</div>'}</div>
      </section>
    </section>
  `;
  renderLaneExecutorGuidance(document.getElementById('create-lane-form'));
}

function renderLane(project, session, lane) {
  if (!lane) {
    return `
      <section>
        <div class="card">
          <h3>Lane not found</h3>
          <p>The selected lane is not in this session yet.</p>
          <a class="secondary" href="${session.route}">Back to session</a>
        </div>
      </section>
    `;
  }

  const stopButton = ['running', 'starting', 'queued'].includes(lane.state)
    ? `<button data-action="stopLane" data-lane-id="${lane.id}" type="button">Stop lane</button>` : '';
  const retryButton = ['failed', 'stopped'].includes(lane.state)
    ? `<button class="secondary" data-action="retryLane" data-lane-id="${lane.id}" type="button">Retry lane</button>` : '';
  const artifactUrl = `/api/lanes/${lane.id}/artifacts`;
  const evidenceUrl = `/api/lanes/${lane.id}/evidence`;
  const evidenceLatestUrl = `/api/lanes/${lane.id}/evidence/latest`;
  const pendingAudits = pendingAuditsForLane(lane.id);
  const pendingAuditRows = pendingAudits.length
    ? pendingAudits.map((event) => `<div>${safeText(event.type)} (${safeText(event.id.slice(0, 8))})</div>`).join('')
    : '<div>None</div>';
  const auditLabel = pendingAudits.length ? 'Refresh audit queue' : 'Audit now';
  const laneLogs = Array.isArray(lane.logs) ? lane.logs.slice(-8) : [];

  return `
    <section>
      ${(lane.warnings || []).map((warning) => `
        <div class="alert bad"><strong>Warning:</strong> ${safeText(warning.message || warning.kind)}</div>
      `).join('')}
      <div class="card">
        <p><a href="${session.route}" class="secondary">Back to session</a></p>
        <h3>${safeText(lane.title)} (lane)</h3>
        <p>${safeText(lane.taskDescription || 'No task description')}</p>
        ${lane.taskPrompt ? `<div class="tiny"><strong>Task prompt:</strong> ${safeText(lane.taskPrompt)}</div>` : ''}
        ${lane.targetUrl ? `<div class="tiny"><strong>Target URL:</strong> <a class="secondary" href="${safeText(lane.targetUrl)}" target="_blank" rel="noopener noreferrer">${safeText(lane.targetUrl)}</a></div>` : ''}
        <div class="tiny muted">MCP tools: ${(lane.mcpTools || []).map((item) => safeText(item.name)).join(', ') || 'none'}</div>
        <div class="tiny muted">Route: ${safeText(laneDetailRoute(project, session, lane))}</div>
        <div class="tiny">Owner: ${safeText(lane.owner)} / Executor: ${safeText(lane.executorType)} / State: <span class="tag ${stateTagClass(lane.state)}">${safeText(lane.state)}</span></div>
        ${lane.model || lane.permissionsProfile || lane.branch ? `<div class="tiny">Model: ${safeText(lane.model || '—')} / Permissions: ${safeText(lane.permissionsProfile || '—')} / Branch: ${safeText(lane.branch || '—')}</div>` : ''}
        ${lane.workdir ? `<div class="tiny">Workdir: ${safeText(lane.workdir)}</div>` : ''}
        ${lane.processMeta && lane.processMeta.pid !== null ? `<div class="tiny">Process: PID ${safeText(String(lane.processMeta.pid))} / exit ${safeText(String(lane.processMeta.exitCode ?? '—'))} / signal ${safeText(String(lane.processMeta.signal ?? '—'))}${lane.processMeta.stopRequestedBy ? ' / stopped by ' + safeText(lane.processMeta.stopRequestedBy) : ''}</div>` : ''}
        <div class="tiny">Pending audits: ${pendingAudits.length}</div>
        <div class="tiny">Pending events: ${pendingAuditRows}</div>
        <div class="tiny">Created: ${formatMeta(lane.createdAt)} / Started: ${formatMeta(lane.startedAt)} / Completed: ${formatMeta(lane.completedAt)}</div>
      </div>
      <div class="card">
        <h4>Actions</h4>
        <div class="lane-row">
          ${stopButton}
          ${retryButton}
          <button class="secondary" data-action="captureEvidence" data-lane-id="${lane.id}" type="button">Capture evidence</button>
          <button class="secondary" data-action="clearEvidence" data-lane-id="${lane.id}" type="button">Clear evidence</button>
          <button class="secondary" data-action="auditLane" data-lane-id="${lane.id}" type="button">${auditLabel}</button>
          <button class="secondary" data-action="showArtifacts" data-lane-id="${lane.id}" type="button">Artifacts</button>
          ${lane.worktreePath && lane.repoRoot ? `<button class="secondary" data-action="removeWorktree" data-lane-id="${lane.id}" type="button">Remove worktree</button>` : ''}
          <a class="secondary" href="${artifactUrl}" target="_blank" rel="noopener noreferrer">Artifacts API</a>
          <a class="secondary" href="${evidenceUrl}" target="_blank" rel="noopener noreferrer">Evidence API</a>
          <a class="secondary" href="${evidenceLatestUrl}" target="_blank" rel="noopener noreferrer">Latest evidence API</a>
        </div>
      </div>
      <div class="card">
        <h4>Recent lane logs</h4>
        <pre>${safeText(JSON.stringify(laneLogs, null, 2))}</pre>
      </div>
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

function renderAuditLog() {
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
        ${laneRoute ? `<a class="secondary" href="${laneRoute}">Open lane</a>` : ''}
        <div class="lane-row" style="margin-top:0.75rem">
          <button class="secondary" data-action="ackAuditEvent" data-event-id="${safeText(event.id)}" type="button">Mark reviewed</button>
        </div>
      </article>
    `;
  }).join('');
  refs.actions.innerHTML = `<div class="card"><h3>Open audit queue</h3><div class="card-grid">${rows}</div></div>`;
}

function render() {
  const project = shell.projects.find((value) => value.slug === shell.route.projectSlug || value.id === shell.route.projectSlug);
  const sessions = project ? shell.sessions : [];
  const session = sessions.find((value) => value.id === shell.route.sessionId);
  const lane = shell.lanes.find((value) => value.id === shell.route.laneId);

  renderBreadcrumbs(project, session);
  renderStatusStrip();
  renderBlockers();
  renderSidebarProjects(project);
  if (refs.content) refs.content.setAttribute('aria-busy', 'false');
  if (!project) {
    renderHome();
  } else if (!session) {
    renderProject(project);
  } else if (shell.route.laneId) {
    renderLane(project, session, lane);
    if (lane) loadEvidenceGallery(lane.id);
  } else {
    renderSession(project, session);
  }
  renderAuditLog();
}

function renderStatusStrip() {
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
  refs.statusStrip.innerHTML = [
    tokenTag,
    executorTags,
    schedTag,
    `<span class="tag" data-status="lanes">${running} running · ${failed} failed</span>`,
    `<span class="tag ${auditCount > 0 ? 'warn' : ''}" data-status="audit">${auditCount} pending audits</span>`,
    blockerCount ? `<span class="tag bad" data-status="blockers">${blockerCount} blockers</span>` : '',
  ].filter(Boolean).join('');
}

function renderBlockers() {
  if (!refs.blockers) return;
  const blockers = shell.systemBlockers || [];
  if (!blockers.length) {
    refs.blockers.innerHTML = '';
    return;
  }
  refs.blockers.innerHTML = blockers.map((blocker) => `
    <div class="blocker ${blocker.severity === 'warn' ? 'warn' : ''}" role="alertdialog">
      <strong>${safeText(blocker.summary)}</strong>
      <div class="tiny" style="color:inherit">${safeText(blocker.detail)}</div>
      <div class="tiny" style="color:inherit;margin-top:0.25rem">Remediation: <code>${safeText(blocker.remediation)}</code></div>
    </div>
  `).join('');
}

function renderSidebarProjects(activeProject) {
  if (!refs.sidebarProjects) return;
  const projects = shell.projects || [];
  if (!projects.length) {
    refs.sidebarProjects.innerHTML = '<div class="tiny muted">No projects yet — create one from the home view.</div>';
    return;
  }
  const renderSidebarProject = (project) => {
    const lanes = (shell.lanes || []).filter((lane) => lane.projectId === project.id);
    const active = lanes.filter((lane) => ['running', 'starting', 'queued'].includes(lane.state)).length;
    const isActive = activeProject && activeProject.id === project.id;
    return `
      <a class="sidebar-link ${isActive ? 'active' : ''}" href="${safeText(project.route)}" data-route-project="${safeText(project.slug)}">
        ${safeText(project.name)}
        <span class="pill" title="${active} active lanes">${active}</span>
      </a>
    `;
  };
  const primaryProjects = projects.filter((project) => !isVerificationProject(project));
  const verificationProjects = projects.filter(isVerificationProject);
  refs.sidebarProjects.innerHTML = [
    primaryProjects.map(renderSidebarProject).join(''),
    verificationProjects.length ? `
      <details class="sidebar-disclosure">
        <summary>Verification runs <span class="pill">${verificationProjects.length}</span></summary>
        <div class="sidebar-list">${verificationProjects.map(renderSidebarProject).join('')}</div>
      </details>
    ` : '',
  ].filter(Boolean).join('');
}

async function loadEvidenceGallery(laneId) {
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
      const link = `<a class="secondary" href="${safeText(item.url)}" target="_blank" rel="noopener noreferrer">Open</a>`;
      const preview = mode === 'screenshot'
        ? `<img src="${safeText(item.url)}" alt="${mode}" style="max-width:100%;border-radius:8px;margin-top:0.4rem" loading="lazy" />`
        : '';
      return `<div class="card"><strong>${mode}</strong><div class="tiny">${safeText(item.name)} · ${safeText(item.at)}</div>${preview}<div style="margin-top:0.4rem">${link}</div></div>`;
    }).join('');
    const presetsRow = presetList.length
      ? `<div class="lane-row" style="margin-top:0.4rem">${presetList.map((preset) => `<button class="secondary" data-action="captureEvidencePreset" data-lane-id="${safeText(laneId)}" data-url="${safeText(preset.url)}" type="button">${safeText(preset.label || preset.url)}</button>`).join('')}</div>`
      : '<div class="tiny muted">No presets — set a lane target URL or project quick links to populate.</div>';
    target.innerHTML = `${presetsRow}<div class="card-grid" style="margin-top:0.5rem">${tiles}</div>`;
  } catch {
    target.textContent = 'Could not load evidence gallery.';
  }
}

function renderMobileManifest() {
  api('/api/mobile/manifest')
    .then(({ data }) => {
      if (!data) return;
      shell.mobileManifest = data;
    })
    .catch(() => {});
}

async function refresh() {
  shell.route = parseRoute();
  shell.alerts = [];
  const policyResp = await api('/api/policy');
  if (policyResp.ok && policyResp.data) {
    shell.policy = policyResp.data.policies;
  }
  const blockersResp = await api('/api/system/blockers');
  if (blockersResp.ok && Array.isArray(blockersResp.data?.blockers)) {
    shell.systemBlockers = blockersResp.data.blockers;
  }
  const profilesResp = await api('/api/executors/profiles');
  if (profilesResp.ok && profilesResp.data?.profiles) {
    shell.executorProfiles = profilesResp.data.profiles;
  }

  if (shell.executorProfiles && typeof shell.executorProfiles === 'object') {
    const cliInfo = {};
    await Promise.all(Object.keys(shell.executorProfiles).map(async (executorType) => {
      const response = await api(`/api/executors/${encodeURIComponent(executorType)}/cli`);
      if (response.ok && response.data) {
        cliInfo[executorType] = response.data;
      }
    }));
    shell.executorCliInfo = cliInfo;
  }

  const cleanupScheduleResp = await api('/api/artifacts/cleanup/schedule');
  if (cleanupScheduleResp.ok && cleanupScheduleResp.data?.schedule) {
    shell.cleanupSchedule = cleanupScheduleResp.data.schedule;
  }
  const mcpToolsResp = await api('/api/mcp/tools');
  if (mcpToolsResp.ok && Array.isArray(mcpToolsResp.data)) {
    shell.mcpTools = mcpToolsResp.data;
  }

  const pendingAuditResp = await api('/api/audit/events?status=pending');
  shell.pendingAuditEvents = pendingAuditResp.ok && Array.isArray(pendingAuditResp.data)
    ? pendingAuditResp.data
    : [];

  const projectsResp = await api('/api/projects');
  shell.projects = projectsResp.ok && Array.isArray(projectsResp.data) ? projectsResp.data : [];
  const allSessions = [];
  for (const project of shell.projects) {
    const sessionsResp = await api(`/api/projects/${project.id}/sessions`);
    if (sessionsResp.ok && Array.isArray(sessionsResp.data)) {
      allSessions.push(...sessionsResp.data);
    }
  }
  shell.sessions = allSessions;
  const allLaneResponses = await Promise.all(allSessions.map((session) => api(`/api/sessions/${session.id}/lanes`)));
  shell.lanes = allLaneResponses
    .filter((response) => response.ok && Array.isArray(response.data))
    .flatMap((response) => response.data);

  const project = shell.projects.find((value) => value.slug === shell.route.projectSlug || value.id === shell.route.projectSlug);
  if (project) {
    const sessions = await api(`/api/projects/${project.id}/sessions`);
    if (sessions.ok && Array.isArray(sessions.data)) {
      shell.sessions = sessions.data;
      const laneResponses = await Promise.all(sessions.data.map((session) => api(`/api/sessions/${session.id}/lanes`)));
      shell.lanes = laneResponses
        .filter((response) => response.ok && Array.isArray(response.data))
        .flatMap((response) => response.data);
    }
  }
  render();
}

function buildCleanupScheduleBody(formData) {
  const payload = {};
  for (const [key, value] of Object.entries(formData)) {
    payload[key] = value;
  }

  payload.enabled = payload.enabled === true || payload.enabled === 'on';
  payload.dryRun = payload.dryRun === true || payload.dryRun === 'on';
  payload.actor = 'dashboard';

  payload.intervalHours = payload.intervalHours ? Number(payload.intervalHours) : 24;
  if (!payload.intervalHours || Number.isNaN(payload.intervalHours) || payload.intervalHours <= 0) {
    payload.intervalHours = 24;
  }

  if (!payload.olderThanDays) {
    payload.olderThanDays = null;
  } else {
    payload.olderThanDays = Number(payload.olderThanDays);
    if (Number.isNaN(payload.olderThanDays) || payload.olderThanDays <= 0) {
      payload.olderThanDays = null;
    }
  }

  if (!payload.sessionId || !String(payload.sessionId).trim()) {
    payload.sessionId = null;
  }

  return payload;
}

function buildMcpToolBody(formData) {
  const payload = {};
  for (const [key, value] of Object.entries(formData)) {
    payload[key] = value;
  }
  payload.actor = 'dashboard';
  payload.args = typeof payload.args === 'string'
    ? payload.args.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  const normalizedScope = normalizeMcpToolScopes(payload.scope);
  if (!normalizedScope.error) {
    payload.scope = normalizedScope.scopes;
  } else {
    payload.scope = ['all'];
  }
  return payload;
}

function buildApprovedActionBody(policyKey = 'manageMcpTools', message = 'This is a higher-risk action. Continue?') {
  return {
    actor: 'dashboard',
    approved: confirmHighRiskAction(message, policyKey),
  };
}

async function handleCleanupSchedule(event) {
  event.preventDefault();
  const payload = buildCleanupScheduleBody(toObj(event.currentTarget));
  const endpoint = event.currentTarget.dataset.url || '/api/artifacts/cleanup/schedule';
  const current = shell.cleanupSchedule || {};
  const scheduled = payload.enabled ? 'Enabled' : 'Disabled';
  const currentState = `${current.enabled ? 'enabled' : 'disabled'}`;
  const interval = payload.intervalHours;
  const retention = payload.olderThanDays || 'session default';
  const targetSession = payload.sessionId || 'all sessions';
  const dryRunMode = payload.dryRun ? 'Dry-run' : 'Live';
  const confirmMessage = `Update cleanup schedule?\nCurrent: ${currentState}\nNext: ${scheduled.toLowerCase()}, ${interval}h, retention ${retention}, ${targetSession}, ${dryRunMode}.`;
  const approval = buildApprovedActionBody('manageCleanupSchedule', confirmMessage);
  if (!approval.approved) {
    renderAlert('Cleanup schedule update canceled.');
    return;
  }
  const response = await api(endpoint, {
    method: 'POST',
    body: {
      ...payload,
      approved: approval.approved,
      actor: approval.actor,
    },
  });
  if (response.ok) {
    renderAlert('Artifact cleanup schedule saved.');
    await refresh();
    return;
  }
  if (response.data?.requiresApproval) {
    renderAlert('Approval required for schedule updates.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Could not save cleanup schedule.', 'bad');
  }
}

async function handleCreateMcpTool(event) {
  event.preventDefault();
  const payload = buildMcpToolBody(toObj(event.currentTarget));
  const scopeInfo = normalizeMcpToolScopes(payload.scope);
  if (scopeInfo.error) {
    renderAlert(scopeInfo.error, 'bad');
    return;
  }
  payload.scope = scopeInfo.scopes;
  if (/\s/.test(String(payload.command || '').trim())) {
    renderAlert('MCP command must be a single executable token.', 'bad');
    return;
  }
  const approval = buildApprovedActionBody('manageMcpTools', `Create MCP tool ${safeText(payload.name || 'new tool')}?`);
  if (!approval.approved) {
    renderAlert('MCP tool creation canceled.');
    return;
  }
  payload.approved = approval.approved;
  payload.actor = approval.actor;

  const response = await api('/api/mcp/tools', {
    method: 'POST',
    body: payload,
  });
  if (response.ok) {
    renderAlert(`MCP tool ${payload.name} added.`);
    await refresh();
    return;
  }
  if (response.data?.requiresApproval) {
    renderAlert('Approval required for MCP tool changes.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Could not add MCP tool.', 'bad');
  }
}

function toObj(form) {
  const data = new FormData(form);
  const output = {};
  for (const [key, value] of data.entries()) {
    output[key] = value;
  }
  return output;
}

async function showArtifacts(laneId) {
  const response = await api(`/api/lanes/${laneId}/artifacts`);
  const target = document.getElementById(`lane-artifacts-${laneId}`);
  if (!target) return;
  if (!response.ok) {
    target.textContent = response.data?.error || 'Could not load artifacts.';
    return;
  }
  const files = response.data.files;
  if (!files.length) {
    target.textContent = 'No artifacts yet.';
    return;
  }
  target.innerHTML = files.map((file) => `<div><a href="${safeText(file.url)}" target="_blank">${safeText(file.name)}</a></div>`).join('');
}

async function handleCreateProject(event) {
  event.preventDefault();
  const payload = toObj(event.currentTarget);
  const approval = buildApprovedActionBody('createProject', `Create project ${safeText(payload.name || '').trim() || 'new project'}?`);
  if (!approval.approved) {
    renderAlert('Project creation canceled.');
    return;
  }
  const quick = (payload.quickLink || '').trim();
  const body = {
    name: payload.name,
    slug: payload.slug,
    owner: approval.actor,
    quickLinks: quick ? [{ label: 'Primary', url: quick }] : [],
    actor: approval.actor,
    approved: approval.approved,
  };
  const response = await api('/api/projects', { method: 'POST', body });
  if (response.ok) {
    renderAlert('Project created.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Project creation failed.', 'bad');
  }
}

async function handleCreateSession(event) {
  event.preventDefault();
  const projectId = event.currentTarget.dataset.projectId;
  const payload = toObj(event.currentTarget);
  const approval = buildApprovedActionBody(
    'createSession',
    `Create session "${String(payload.name || '').trim() || 'new session'}" for this project?`,
  );
  if (!approval.approved) {
    renderAlert('Session creation canceled.');
    return;
  }
  const response = await api(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    body: {
      name: payload.name,
      leader: payload.leader,
      laneConcurrencyLimit: payload.laneConcurrencyLimit ? Number(payload.laneConcurrencyLimit) : 1,
      actor: approval.actor,
      approved: approval.approved,
    },
  });
  if (response.ok) {
    renderAlert('Session created.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Session creation failed.', 'bad');
  }
}

async function handleAddProjectQuickLink(event) {
  event.preventDefault();
  const projectId = event.currentTarget.dataset.projectId;
  const payload = toObj(event.currentTarget);
  const label = String(payload.quickLinkLabel || '').trim();
  const url = String(payload.quickLinkUrl || '').trim();
  if (!label || !url) {
    renderAlert('Quick link label and URL are required.', 'bad');
    return;
  }

  const project = shell.projects.find((value) => value.id === projectId);
  const existingLinks = Array.isArray(project?.quickLinks) ? project.quickLinks : [];
  const nextLinks = existingLinks
    .filter((item) => item && String(item.url || '').trim() && String(item.label || '').trim())
    .concat([{ label, url }])
    .slice(0, 8);
  const approval = buildApprovedActionBody('updateProject', `Update quick links for ${project?.name || 'project'}?`);
  if (!approval.approved) {
    renderAlert('Quick link addition canceled.');
    return;
  }

  const response = await api(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: {
      actor: approval.actor,
      approved: approval.approved,
      quickLinks: nextLinks,
    },
  });
  if (response.ok) {
    renderAlert('Quick link added.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not add quick link.', 'bad');
  }
}

async function handleCreateLane(event) {
  event.preventDefault();
  const sessionId = event.currentTarget.dataset.sessionId;
  const payload = toObj(event.currentTarget);
  const executorType = normalizeExecutorType(payload.executorType || 'mock');
  const approval = buildApprovedActionBody(
    'createLane',
    `Queue lane "${String(payload.title || '').trim() || 'new lane'}" as ${executorType || 'mock'}-led lane?`,
  );
  if (!approval.approved) {
    renderAlert('Lane creation canceled.');
    return;
  }
  const commandParts = parseCommandParts(payload.command);
  // Accept multi-select values (FormData lists), the hidden text fallback, and legacy comma-separated.
  let mcpRaw = payload.mcpToolIds;
  if (!mcpRaw && payload.mcpToolIdsRaw) mcpRaw = payload.mcpToolIdsRaw;
  let requestedToolIds = [];
  if (Array.isArray(mcpRaw)) {
    requestedToolIds = mcpRaw.map((value) => String(value || '').trim()).filter(Boolean);
  } else if (mcpRaw) {
    requestedToolIds = String(mcpRaw).split(',').map((value) => value.trim()).filter(Boolean);
  }
  // Also collect from FormData directly in case toObj squashed array values.
  try {
    const fd = new FormData(event.currentTarget);
    const all = fd.getAll('mcpToolIds').map((value) => String(value || '').trim()).filter(Boolean);
    if (all.length) requestedToolIds = all;
  } catch { /* noop */ }
  const scopedTools = getExecutorScopedMcpTools(executorType);
  const scopedToolIds = new Set(scopedTools.map((tool) => tool.id));
  const unknownTools = [];
  const disallowedTools = [];

  if (executorType === 'codex' || executorType === 'claude') {
    if (commandParts.length > 0 && !executorTargetsCommand(executorType, commandParts)) {
      renderAlert(`Command for ${executorType} must include "${executorType}".`, 'bad');
      return;
    }
    if (!commandParts.length && payload.executorBinary && !executorTargetsBinary(executorType, payload.executorBinary)) {
      renderAlert(`Executor binary for ${executorType} must include "${executorType}".`, 'bad');
      return;
    }
  }

  for (const requestedToolId of requestedToolIds) {
    const tool = findMcpTool(requestedToolId);
    if (!tool) {
      unknownTools.push(requestedToolId);
      continue;
    }
    if (!scopedToolIds.has(tool.id)) {
      disallowedTools.push(requestedToolId);
    }
  }

  if (unknownTools.length) {
    renderAlert(`Unknown MCP tool(s): ${unknownTools.join(', ')}`, 'bad');
    return;
  }
  if (disallowedTools.length) {
    renderAlert(`Tool(s) not available for ${executorType}: ${disallowedTools.join(', ')}`, 'bad');
    return;
  }

  const response = await api(`/api/sessions/${sessionId}/lanes`, {
    method: 'POST',
    body: {
      title: payload.title,
      taskDescription: payload.taskDescription,
      executorType,
      command: payload.command || null,
      commandArgs: payload.commandArgs || null,
      executorBinary: payload.executorBinary || null,
      workdir: payload.workdir || null,
      mcpToolIds: requestedToolIds,
      owner: 'dashboard',
      approved: approval.approved,
      actor: approval.actor,
      taskPrompt: payload.taskPrompt || null,
      model: payload.model || null,
      permissionsProfile: payload.permissionsProfile || null,
      targetUrl: payload.targetUrl || null,
      branch: payload.branch || null,
      verificationCommand: payload.verificationCommand || null,
    },
  });
  if (response.ok) {
    renderAlert('Lane queued.');
    await refresh();
  } else if (response.data?.requiresApproval) {
    renderAlert('Approval required for this action.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Lane creation failed.', 'bad');
  }
}

async function handleLaneActions(event) {
  const action = event.currentTarget.dataset.action;
  const laneId = event.currentTarget.dataset.laneId;
  if (action === 'showArtifacts') {
    await showArtifacts(laneId);
    return;
  }
  if (action === 'captureEvidencePreset') {
    const url = event.currentTarget.dataset.url;
    if (!url) return;
    const approved = confirmHighRiskAction(`Capture screenshot for ${url}?`, 'captureEvidence');
    const response = await api(`/api/lanes/${laneId}/evidence`, {
      method: 'POST',
      body: { approved, actor: 'dashboard', url, modes: ['screenshot'] },
    });
    if (response.ok) {
      renderAlert(response.data?.captured ? 'Evidence captured.' : `Evidence attempt finished: ${response.data?.reason || 'degraded'}`);
      await loadEvidenceGallery(laneId);
    } else {
      renderAlert(response.data?.error || 'Evidence preset capture failed.', 'bad');
    }
    return;
  }
  if (action === 'removeWorktree') {
    if (!confirmHighRiskAction(`Remove the git worktree for lane ${laneId}? Branch is kept.`, 'cleanupArtifacts')) {
      renderAlert('Worktree removal canceled.');
      return;
    }
    const response = await api(`/api/lanes/${laneId}/worktree/remove`, {
      method: 'POST',
      body: { approved: true, actor: 'dashboard' },
    });
    if (response.ok) {
      renderAlert(response.data?.removed ? 'Worktree removed.' : 'Worktree was not removed.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not remove worktree.', 'bad');
    }
    return;
  }
  const routeMap = {
    stopLane: { url: `/api/lanes/${laneId}/stop`, method: 'POST' },
    retryLane: { url: `/api/lanes/${laneId}/retry`, method: 'POST' },
    auditLane: { url: `/api/lanes/${laneId}/audit`, method: 'POST' },
    captureEvidence: { url: `/api/lanes/${laneId}/evidence`, method: 'POST' },
    clearEvidence: { url: `/api/lanes/${laneId}/evidence/clear`, method: 'POST' },
  };
  if (!routeMap[action]) return;
  const endpoint = routeMap[action];
  const policyKey = {
    stopLane: 'stopLane',
    retryLane: 'retryLane',
    auditLane: 'auditLane',
    captureEvidence: 'captureEvidence',
    clearEvidence: 'clearEvidenceArtifacts',
  }[action];
  const policy = shell.policy[policyKey] || { requiresApproval: false };
  const approved = confirmHighRiskAction('This is a higher-risk action. Continue?', policyKey);

  if (action === 'captureEvidence') {
    const providedUrl = window.prompt('Target URL for evidence capture (example: http://localhost:4173)');
    if (!providedUrl) {
      renderAlert('Evidence capture canceled.');
      return;
    }
    const modes = [];
    if (window.confirm('Capture screenshot?')) modes.push('screenshot');
    if (window.confirm('Capture trace (more expensive)?')) modes.push('trace');
    if (window.confirm('Capture video (heavier)?')) modes.push('video');
    const response = await api(endpoint.url, {
      method: endpoint.method,
      body: {
        approved,
        actor: 'dashboard',
        url: providedUrl,
        modes: modes.length ? modes : ['screenshot'],
      },
    });
    if (response.ok) {
      renderAlert(response.data?.captured ? 'Evidence captured.' : `Evidence attempt finished: ${response.data?.reason || 'queued/degraded'}`);
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required. Retry with approval enabled.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Evidence capture failed.', 'bad');
    }
    return;
  }

  if (action === 'clearEvidence') {
    const confirmed = window.confirm('Clear evidence files for this lane?');
    if (!confirmed) {
      renderAlert('Evidence clear canceled.');
      return;
    }
    const response = await api(endpoint.url, {
      method: endpoint.method,
      body: {
        approved,
        actor: 'dashboard',
        confirmed: true,
      },
    });
    if (response.ok) {
      renderAlert('Evidence files cleared.');
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required. Retry with approval enabled.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not clear evidence.', 'bad');
    }
    return;
  }

  const response = await api(endpoint.url, {
    method: endpoint.method,
    body: {
        approved,
        actor: 'dashboard',
      },
    });
  if (response.ok) {
    if (action === 'auditLane' && response.data?.alreadyQueued) {
      renderAlert('Audit for this lane is already queued.');
    } else {
      renderAlert(`${action} submitted.`);
    }
    await refresh();
  } else if (response.data?.requiresApproval) {
    renderAlert('Approval required. Retry with approval enabled.', 'bad');
  } else {
    renderAlert(response.data?.error || `${action} failed.`, 'bad');
  }
}

async function handleAuditEventAction(event) {
  const eventId = event.currentTarget.dataset.eventId;
  const response = await api(`/api/audit/events/${eventId}/ack`, {
    method: 'POST',
    body: { actor: 'dashboard' },
  });
  if (response.ok) {
    renderAlert('Audit event marked reviewed.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not acknowledge audit event.', 'bad');
  }
}

async function handleSessionActions(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'refresh') {
    await refresh();
    return;
  }
  if (action === 'auditDone') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const approved = confirmHighRiskAction('Queue audit for finished lanes in this session?', 'auditDoneLanes');
    if (!approved) {
      renderAlert('Session audit request canceled.');
      return;
    }
    const response = await api(`/api/sessions/${sessionId}/audit-done-lanes`, {
      method: 'POST',
      body: { actor: 'dashboard', approved },
    });
    if (response.ok) {
      const queuedNew = response.data?.enqueuedNew ?? response.data?.enqueued ?? 0;
      const alreadyQueued = response.data?.alreadyQueued || 0;
      const message = alreadyQueued
        ? `Queued ${queuedNew} new audit(s). ${alreadyQueued} already queued.`
        : `Queued audit for ${queuedNew || response.data?.enqueued || 0} lane(s).`;
      renderAlert(message);
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not queue audit.', 'bad');
    }
  }
}

async function handleSystemActions(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'setApiToken') {
    const tokenInput = document.getElementById('api-token-input');
    const token = tokenInput?.value || '';
    setApiToken(token);
    renderAlert(token ? 'API token saved for session.' : 'Token cleared (empty input).');
    await refresh();
    return;
  }
  if (action === 'clearApiToken') {
    setApiToken('');
    renderAlert('Saved API token cleared.');
    await refresh();
    return;
  }
  if (action === 'cleanupArtifacts') {
    const dryRun = window.confirm('Run cleanup as dry run first? Press Cancel to perform deletion.');
    const confirmed = !dryRun ? window.confirm('This will permanently delete archived artifacts. Continue?') : true;
    const approval = buildApprovedActionBody(
      'cleanupArtifacts',
      `Run artifact cleanup${dryRun ? ' (dry-run mode)' : ' now'}?`,
    );
    if (!confirmed) {
      renderAlert('Cleanup canceled.');
      return;
    }
    if (!approval.approved) {
      renderAlert('Cleanup canceled.');
      return;
    }
    const response = await api(event.currentTarget.dataset.url || '/api/artifacts/cleanup', {
      method: 'POST',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        dryRun,
        confirmed,
      },
    });
    if (response.ok) {
      if (dryRun) {
        renderAlert(`Artifact cleanup dry run: ${response.data?.candidates || 0} candidates.`);
      } else {
        renderAlert(`Artifact cleanup complete: removed ${response.data?.removed || 0} lanes.`);
      }
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Cleanup failed.', 'bad');
    }
    return;
  }
  if (action === 'cleanupArtifactsRunNow') {
    const schedule = shell.cleanupSchedule || {};
    const appliedSession = schedule.sessionId ? `session ${safeText(schedule.sessionId)}` : 'all sessions';
    const retention = schedule.olderThanDays ? `${safeText(schedule.olderThanDays)} day(s)` : 'session defaults';
    const defaultDryRun = schedule.dryRun ? 'on' : 'off';
    const confirmRun = window.confirm(`Run cleanup now using current schedule: ${appliedSession}, retention ${retention}, dry-run default ${defaultDryRun}?`);
    if (!confirmRun) {
      renderAlert('Cleanup run canceled.');
      return;
    }
    const approval = buildApprovedActionBody(
      'cleanupArtifacts',
      `Run cleanup now using schedule for ${appliedSession}?`,
    );
    if (!approval.approved) {
      renderAlert('Cleanup run canceled.');
      return;
    }

    const runNowBody = {
      actor: approval.actor,
      approved: approval.approved,
      sessionId: schedule.sessionId || null,
      olderThanDays: schedule.olderThanDays ?? null,
      dryRun: Boolean(schedule.dryRun),
      confirmed: false,
    };

    const runNowApi = event.currentTarget.dataset.url || '/api/artifacts/cleanup/run-now';
    const runDryFirst = window.confirm('Run cleanup as dry-run first, then optionally run deletion?');

    if (runDryFirst) {
      const dryRunResponse = await api(runNowApi, {
        method: 'POST',
        body: {
          ...runNowBody,
          dryRun: true,
        },
      });
      if (!dryRunResponse.ok) {
        if (dryRunResponse.data?.requiresApproval) {
          renderAlert('Approval required for cleanup.', 'bad');
          return;
        }
        renderAlert(dryRunResponse.data?.error || 'Cleanup dry-run failed.', 'bad');
        return;
      }
      renderAlert(`Cleanup dry run found ${dryRunResponse.data?.candidates || 0} candidate lanes (no artifacts deleted).`);

      if (!dryRunResponse.data?.candidates) {
        await refresh();
        return;
      }

      const confirmDelete = window.confirm(`Delete ${dryRunResponse.data?.candidates} candidate artifacts now?`);
      if (!confirmDelete) {
        renderAlert('Cleanup deletion canceled after dry run.');
        await refresh();
        return;
      }
      runNowBody.confirmed = true;
      runNowBody.dryRun = false;
    } else {
      const confirmed = window.confirm('Run cleanup now and permanently delete matching artifacts?');
      if (!confirmed) {
        renderAlert('Cleanup run canceled.');
        return;
      }
      runNowBody.confirmed = true;
      runNowBody.dryRun = false;
    }

    const response = await api(runNowApi, {
      method: 'POST',
      body: {
        ...runNowBody,
      },
    });
    if (response.ok) {
      if (response.data?.dryRun) {
        renderAlert(`Cleanup run (dry-run): ${response.data?.candidates || 0} candidates.`);
      } else {
        renderAlert(`Cleanup run completed: removed ${response.data?.removed || 0} lanes.`);
      }
      await refresh();
      return;
    }
    if (response.data?.requiresApproval) {
      renderAlert('Approval required.', 'bad');
      return;
    }
    renderAlert(response.data?.error || 'Cleanup run failed.', 'bad');
  }

  if (action === 'deleteMcpTool') {
    const toolId = event.currentTarget.dataset.toolId;
    if (!toolId) return;
    const confirmed = window.confirm(`Delete MCP tool ${toolId}?`);
    if (!confirmed) {
      renderAlert('Delete canceled.');
      return;
    }
    const approval = buildApprovedActionBody('manageMcpTools');
    if (!approval.approved) {
      renderAlert('Deletion canceled.');
      return;
    }
    const response = await api(`/api/mcp/tools/${toolId}`, {
      method: 'DELETE',
      body: approval,
    });
    if (response.ok) {
      renderAlert(`MCP tool ${toolId} deleted.`);
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required to delete MCP tool.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not delete MCP tool.', 'bad');
    }
  }

  if (action === 'deleteProjectQuickLink') {
    const projectId = event.currentTarget.dataset.projectId;
    const linkIndex = Number.parseInt(event.currentTarget.dataset.linkIndex, 10);
    if (!projectId || Number.isNaN(linkIndex)) return;
    const project = shell.projects.find((value) => value.id === projectId);
    const confirmed = window.confirm('Remove this quick link from the project?');
    if (!confirmed) {
      renderAlert('Quick link removal canceled.');
      return;
    }
    const existingLinks = Array.isArray(project?.quickLinks) ? project.quickLinks : [];
    const nextLinks = existingLinks.filter((_, index) => index !== linkIndex);
    const approval = buildApprovedActionBody('updateProject');
    if (!approval.approved) {
      renderAlert('Quick link removal canceled.');
      return;
    }

    const response = await api(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        quickLinks: nextLinks,
      },
    });
    if (response.ok) {
      renderAlert('Quick link removed.');
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required to remove this quick link.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not remove quick link.', 'bad');
    }
  }

  if (action === 'editMcpTool') {
    const toolId = event.currentTarget.dataset.toolId;
    if (!toolId) return;
    const tool = shell.mcpTools.find((item) => item.id === toolId || item.name === toolId);
    if (!tool) {
      renderAlert('MCP tool lookup failed. Please refresh.', 'bad');
      return;
    }

    const command = window.prompt('Update MCP command', tool.command || '');
    if (command === null) return;
    const args = window.prompt('Update MCP args (comma separated)', (tool.args || []).join(', '));
    if (args === null) return;
    const scope = window.prompt('Update scope (comma separated)', (tool.scope || ['all']).join(', '));
    if (scope === null) return;
    const normalizedScope = normalizeMcpToolScopes(scope);
    if (normalizedScope.error) {
      renderAlert(normalizedScope.error, 'bad');
      return;
    }
    const notes = window.prompt('Update notes', tool.notes || '');
    if (notes === null) return;
    const enabled = window.prompt('Enable this MCP tool? (yes/no)', tool.enabled ? 'yes' : 'no');
    if (enabled === null) return;
    const normalizedEnabled = ['yes', 'y', 'true', '1', 'on'].includes(enabled.trim().toLowerCase());
    const approval = buildApprovedActionBody('manageMcpTools');
    if (!approval.approved) {
      renderAlert('MCP tool edit canceled.');
      return;
    }

    const response = await api(`/api/mcp/tools/${toolId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        command,
        args: args.split(',').map((value) => value.trim()).filter(Boolean),
        scope: normalizedScope.scopes,
        notes,
        enabled: normalizedEnabled,
      },
    });

    if (response.ok) {
      renderAlert(`MCP tool ${toolId} updated.`);
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required to update MCP tool.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not update MCP tool.', 'bad');
    }
  }

  if (action === 'refreshExecutorCli') {
    const executorType = event.currentTarget.dataset.executor;
    if (!executorType) return;
    const response = await api(`/api/executors/${encodeURIComponent(executorType)}/cli`);
    if (response.ok) {
      if (!shell.executorCliInfo) shell.executorCliInfo = {};
      shell.executorCliInfo[executorType] = response.data;
      renderAlert(`${executorType.toUpperCase()} CLI info refreshed.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not refresh CLI health.', 'bad');
    }
    return;
  }

  if (action === 'reinstallExecutorCli') {
    const executorType = event.currentTarget.dataset.executor;
    if (!executorType) return;
    const useSource = event.currentTarget.dataset.useSource === 'true';
    const sourceMode = Boolean(useSource);
    const sourceCommand = shell.executorCliInfo?.[executorType]?.reinstall?.sourceCommand;
    if (sourceMode && !Array.isArray(sourceCommand)) {
      renderAlert(`${executorType.toUpperCase()} source command is not available.`, 'bad');
      return;
    }
    const planLabel = sourceMode ? 'source reinstall' : 'managed reinstall';
    const confirmedPlan = window.confirm(`Plan ${executorType.toUpperCase()} CLI ${planLabel} now?`);
    if (!confirmedPlan) {
      renderAlert('Executor CLI action canceled.');
      return;
    }
    const approval = buildApprovedActionBody(
      'manageExecutorCli',
      `Approve ${executorType.toUpperCase()} CLI ${planLabel}?`,
    );
    if (!approval.approved) {
      renderAlert('Executor CLI action canceled.');
      return;
    }
    const overridePrompt = `Optional custom reinstall command for ${executorType.toUpperCase()} (space-separated string):\n\nLeave blank to use ${sourceMode ? 'the trusted source-managed command' : 'the managed default command'}.`;
    const overrideCommand = sourceMode ? null : window.prompt(overridePrompt);
    if (sourceMode && overrideCommand && overrideCommand.trim()) {
      renderAlert('Source mode cannot be combined with a custom command override.', 'bad');
      return;
    }
    const parsedOverride = overrideCommand && overrideCommand.trim() ? overrideCommand.trim() : null;
    const execute = window.confirm(`${sourceMode ? 'Run source reinstall' : 'Run managed reinstall'} now (not dry-run)?\nChoose Cancel to only show the planned command.`);
    const confirmedExecute = execute;
    const response = await api(`/api/executors/${encodeURIComponent(executorType)}/cli/reinstall`, {
      method: 'POST',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        execute,
        confirmed: confirmedExecute,
        useSource: sourceMode,
        ...(parsedOverride ? { command: parsedOverride } : {}),
      },
    });
    if (response.ok) {
      if (response.data?.executed) {
        renderAlert(`CLI ${executorType} reinstall executed with status ${response.data.status}.`);
      } else {
        renderAlert(`CLI ${executorType} reinstall planned: ${safeText((response.data?.command || []).join(' '))}`);
      }
      await refresh();
      return;
    }
    if (response.data?.requiresApproval) {
      renderAlert('Approval required for CLI management.', 'bad');
      return;
    }
    renderAlert(response.data?.error || 'CLI management failed.', 'bad');
  }
}

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'create-project-form') {
    await handleCreateProject(event);
    return;
  }
  if (event.target.id === 'update-project-links-form') {
    await handleAddProjectQuickLink(event);
    return;
  }
  if (event.target.id === 'create-session-form') {
    await handleCreateSession(event);
    return;
  }
  if (event.target.id === 'create-lane-form') {
    await handleCreateLane(event);
    return;
  }
  if (event.target.id === 'create-mcp-tool-form') {
    await handleCreateMcpTool(event);
    return;
  }
  if (event.target.id === 'cleanup-schedule-form') {
    await handleCleanupSchedule(event);
    return;
  }
});

document.addEventListener('change', (event) => {
  if (event.target && event.target.name === 'executorType' && event.target.form && event.target.form.id === 'create-lane-form') {
    renderLaneExecutorGuidance(event.target.form);
  }
});

document.addEventListener('click', async (event) => {
  const actionTarget = event.target?.closest?.('[data-action]');
  const action = actionTarget?.dataset?.action;
  if (action === 'toggleNav') {
    document.body.classList.toggle('nav-open');
    return;
  }
  // Auto-close mobile sidebar when navigating.
  if (event.target?.classList?.contains('sidebar-link')) {
    document.body.classList.remove('nav-open');
  }
  if (!action) {
    const navCard = event.target?.closest?.('[data-href]');
    const interactive = event.target?.closest?.('a, button, input, select, textarea, label, summary');
    if (navCard && !interactive && navCard.dataset.href) {
      window.location.href = navCard.dataset.href;
    }
    return;
  }

  if (['stopLane', 'retryLane', 'auditLane', 'captureEvidence', 'clearEvidence', 'captureEvidencePreset', 'removeWorktree'].includes(action)) {
    await handleLaneActions({ currentTarget: actionTarget });
    return;
  }

  if (action === 'ackAuditEvent') {
    await handleAuditEventAction({ currentTarget: actionTarget });
    return;
  }

  if (['refresh', 'auditDone'].includes(action)) {
    await handleSessionActions({ currentTarget: actionTarget });
    return;
  }

  if ([
    'setApiToken',
    'clearApiToken',
    'cleanupArtifacts',
    'cleanupArtifactsRunNow',
    'deleteMcpTool',
    'editMcpTool',
    'deleteProjectQuickLink',
    'refreshExecutorCli',
    'reinstallExecutorCli',
  ].includes(action)) {
    await handleSystemActions({ currentTarget: actionTarget });
    return;
  }

  if (action === 'showArtifacts') {
    await handleLaneActions({ currentTarget: actionTarget });
  }
});

document.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const navCard = event.target?.closest?.('[data-href]');
  if (!navCard || !navCard.dataset.href) return;
  event.preventDefault();
  window.location.href = navCard.dataset.href;
});

window.addEventListener('hashchange', () => {
  render();
});

setInterval(refresh, 3000);
initializeApiToken();
renderMobileManifest();
refresh();
