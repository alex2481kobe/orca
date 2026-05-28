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
  privateAccess: null,
  providerCatalog: null,
  providerHealth: {},
  effectiveSettings: null,
  authStatus: null,
  notifications: null,
};

const API_PROVIDER_EXECUTOR_TYPES = ['api', 'openai-compatible', 'gemini', 'kimi', 'deepseek', 'openrouter', 'composer'];
const MCP_TOOL_SCOPE_ALLOWLIST = [
  'all',
  'mock',
  'codex',
  'claude',
  'cli',
  'custom-cli',
  ...API_PROVIDER_EXECUTOR_TYPES,
];

const refs = {
  breadcrumbs: document.getElementById('breadcrumbs'),
  alerts: document.getElementById('alerts'),
  content: document.getElementById('content'),
  statusStrip: document.getElementById('status-strip'),
  blockers: document.getElementById('blockers'),
  sidebarProjects: document.getElementById('sidebar-projects'),
  topbarSubtitle: document.getElementById('topbar-subtitle'),
  topbarTitle: document.getElementById('topbar-title'),
};
// Audit queue is rendered inside refs.content for the new operator shell.
refs.actions = refs.content;
const API_TOKEN_STORAGE_KEY = 'commandDeckApiToken';
const SIDEBAR_ORDER_STORAGE_KEY = 'commandDeckSidebarOrder:v1';
const NOTIFICATION_SEEN_STORAGE_KEY = 'commandDeckNotificationsSeen:v1';
const FOLDER_ICON = `
  <span class="sidebar-folder" aria-hidden="true">
    <svg viewBox="0 0 20 16" focusable="false">
      <path d="M1.5 4.5h6l1.4 2h9.6v7.2c0 .7-.6 1.3-1.3 1.3H2.8c-.7 0-1.3-.6-1.3-1.3V4.5Z"></path>
      <path d="M1.5 4.5V3c0-.8.6-1.4 1.4-1.4h4.4l1.5 1.8h8c.8 0 1.4.6 1.4 1.4v1.7"></path>
    </svg>
  </span>
`;
const COMPOSE_ICON = `
  <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
    <path d="M4.2 2.8h7.2a1.4 1.4 0 0 1 1.4 1.4v2.4"></path>
    <path d="M9.8 17.2H4.2a1.4 1.4 0 0 1-1.4-1.4V4.2a1.4 1.4 0 0 1 1.4-1.4"></path>
    <path d="m11.1 14.7 4.9-4.9 2.1 2.1-4.9 4.9-2.7.6.6-2.7Z"></path>
  </svg>
`;

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

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
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

function readSidebarOrder() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIDEBAR_ORDER_STORAGE_KEY) || '{}');
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    return { projects: [], sessions: {} };
  }
}

function writeSidebarOrder(order) {
  window.localStorage.setItem(SIDEBAR_ORDER_STORAGE_KEY, JSON.stringify(order));
}

function orderItems(items, ids) {
  const positions = new Map((ids || []).map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const aIndex = positions.has(a.id) ? positions.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bIndex = positions.has(b.id) ? positions.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return items.indexOf(a) - items.indexOf(b);
  });
}

function moveId(ids, sourceId, targetId) {
  const next = ids.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex === -1) {
    next.push(sourceId);
  } else {
    next.splice(targetIndex, 0, sourceId);
  }
  return next;
}

function currentActiveProject() {
  return shell.projects.find((value) => value.slug === shell.route.projectSlug || value.id === shell.route.projectSlug) || null;
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

function getProviderProfile(type) {
  const profileType = normalizeExecutorType(type);
  const profiles = Array.isArray(shell.providerCatalog?.profiles) ? shell.providerCatalog.profiles : [];
  return profiles.find((profile) => normalizeExecutorType(profile.id) === profileType) || null;
}

function isApiExecutorType(type) {
  return API_PROVIDER_EXECUTOR_TYPES.includes(normalizeExecutorType(type));
}

function apiProviderOptions() {
  const profiles = Array.isArray(shell.providerCatalog?.profiles) ? shell.providerCatalog.profiles : [];
  return profiles
    .filter((profile) => profile.kind === 'api')
    .map((profile) => {
      const id = safeAttr(profile.id);
      const label = safeText(profile.displayName || profile.id);
      const suffix = profile.enabled === false ? ' (setup)' : '';
      return `<option value="${id}">${label}${suffix}</option>`;
    })
    .join('');
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
  const allowed = new Set(['projects', 'create', 'system', 'mcp', 'audit', 'cleanup', 'token', 'private-access', 'providers', 'effective-settings', 'notifications', 'backup']);
  return allowed.has(panel) ? panel : 'overview';
}

function browserNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function browserNotificationPermission() {
  if (!browserNotificationsSupported()) return 'unsupported';
  return window.Notification.permission || 'default';
}

function readSeenBrowserNotifications() {
  try {
    return new Set(JSON.parse(window.sessionStorage.getItem(NOTIFICATION_SEEN_STORAGE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function writeSeenBrowserNotifications(seen) {
  window.sessionStorage.setItem(NOTIFICATION_SEEN_STORAGE_KEY, JSON.stringify([...seen].slice(-200)));
}

async function requestBrowserNotificationPermission() {
  if (!browserNotificationsSupported()) {
    renderAlert('Browser notifications are not supported here.', 'bad');
    return 'unsupported';
  }
  try {
    const permission = await window.Notification.requestPermission();
    renderAlert(permission === 'granted' ? 'Browser notifications enabled.' : `Browser notification permission: ${permission}.`);
    return permission;
  } catch {
    renderAlert('Browser notification permission request failed.', 'bad');
    return browserNotificationPermission();
  }
}

function maybeShowBrowserNotifications() {
  const notificationState = shell.notifications || {};
  const settings = notificationState.settings || {};
  if (!settings.browserEnabled || browserNotificationPermission() !== 'granted') return;
  const seen = readSeenBrowserNotifications();
  const items = Array.isArray(notificationState.notifications) ? notificationState.notifications : [];
  for (const item of items.filter((notification) => !notification.readAt).slice(0, 5)) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    const notice = new window.Notification(item.title || 'Command Deck update', {
      body: item.body || item.severity || 'Status changed',
      tag: item.id,
      renotify: false,
    });
    if (item.href) {
      notice.onclick = () => {
        window.focus();
        window.location.href = item.href;
      };
    }
  }
  writeSeenBrowserNotifications(seen);
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
    credentials: 'same-origin',
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
  refs.breadcrumbs.innerHTML = '';
}

function renderTopbarTitle(project, session, lane) {
  if (!refs.topbarTitle) return;
  refs.topbarTitle.textContent = lane?.title || session?.name || project?.name || '';
}

function captureContentUiState() {
  if (!refs.content) return null;
  return {
    detailsOpen: Array.from(refs.content.querySelectorAll('details')).map((detail) => detail.open),
    projectToolsOpen: Boolean(refs.content.querySelector('.project-shell.tools-open')),
  };
}

function restoreContentUiState(state) {
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

function renderHome() {
  const panel = activeHomePanel();
  const artifactCleanupUrl = shell.mobileManifest?.artifactCleanupUrl || '/api/artifacts/cleanup';
  const scheduleApiUrl = shell.mobileManifest?.artifactCleanupScheduleUrl || '/api/artifacts/cleanup/schedule';
  const scheduleRunApiUrl = shell.mobileManifest?.artifactCleanupNowUrl || '/api/artifacts/cleanup/run-now';
  const schedule = shell.cleanupSchedule || {};
  const tokenConfigured = Boolean(shell.apiToken);
  const browserPaired = Boolean(shell.authStatus?.browserSessionAuthenticated);
  const cleanupNext = schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : 'not scheduled';
  const privateAccess = shell.privateAccess || {};
  const privateSettings = privateAccess.settings || {};
  const privateTargets = Array.isArray(privateAccess.targets) ? privateAccess.targets : [];
  const tailnet = privateAccess.tailnet || {};
  const notificationState = shell.notifications || {};
  const notificationSettings = notificationState.settings || {};
  const notificationItems = Array.isArray(notificationState.notifications) ? notificationState.notifications : [];
  const unreadNotifications = Number.parseInt(notificationState.unreadCount, 10) || 0;
  const browserPermission = browserNotificationPermission();
  const setupCommands = Array.isArray(privateAccess.setupPlan?.commands) ? privateAccess.setupPlan.commands : [];
  const selected = (actual, expected) => String(actual || '') === String(expected || '') ? 'selected' : '';
  const checked = (value) => value ? 'checked' : '';
  const commandRows = setupCommands.map((item) => `
    <div class="access-command">
      <div>
        <strong>${safeText(item.label)}</strong>
        <div class="tiny muted">${safeText(item.note || '')}</div>
        <code>${safeText(item.copyText || 'No command needed')}</code>
      </div>
      <button class="secondary" data-action="copyPrivateAccessCommand" data-command="${safeAttr(item.copyText || '')}" type="button">Copy</button>
    </div>
  `).join('');
  const targetRows = privateTargets.map((target) => {
    const targetUrl = target.mode === 'tailnet-https-serve'
      ? (target.httpsServeUrl || target.localUrl)
      : target.mode === 'tailnet-http'
        ? (target.tailnetHttpUrl || target.localUrl)
        : target.localUrl;
    return `
      <div class="access-target">
        <div>
          <strong>${safeText(target.label)}</strong>
          <div class="tiny muted">${safeText(target.mode)} · ${safeText(target.healthStatus || 'configured_unchecked')} · ${safeText(targetUrl)}</div>
          ${target.lastHealthDetail ? `<div class="tiny muted">${safeText(target.lastHealthDetail)}</div>` : ''}
        </div>
        <div class="lane-row">
          <a class="secondary" href="${safeAttr(targetUrl)}" target="_blank" rel="noopener noreferrer">Open</a>
          <button class="secondary" data-action="checkPrivateAccessTarget" data-target-id="${safeAttr(target.id)}" type="button">Check</button>
          <button class="secondary" data-action="deletePrivateAccessTarget" data-target-id="${safeAttr(target.id)}" type="button">Remove</button>
        </div>
      </div>
    `;
  }).join('');
  const notificationRows = notificationItems.map((notification) => `
    <div class="provider-row ${notification.readAt ? '' : 'panel-elevated'}">
      <div>
        <strong>${safeText(notification.title || 'Command Deck update')}</strong>
        <div class="tiny muted">${safeText(notification.severity || 'info')} · ${safeText(formatRelative(notification.createdAt))} · ${notification.readAt ? 'read' : 'unread'}</div>
        ${notification.body ? `<div class="tiny muted">${safeText(notification.body)}</div>` : ''}
      </div>
      <div class="lane-row">
        ${notification.href ? `<a class="secondary" href="${safeAttr(notification.href)}">Open</a>` : ''}
        ${notification.readAt ? '' : `<button class="secondary" data-action="markNotificationRead" data-notification-id="${safeAttr(notification.id)}" type="button">Mark read</button>`}
      </div>
    </div>
  `).join('');
  const providerCatalog = shell.providerCatalog || {};
  const providerProfiles = Array.isArray(providerCatalog.profiles) ? providerCatalog.profiles : [];
  const effectiveSettings = shell.effectiveSettings || {};
  const effectiveSummary = effectiveSettings.settings || {};
  const effectiveSources = Array.isArray(effectiveSettings.sourcesApplied) ? effectiveSettings.sourcesApplied : [];
  const effectiveSettingsText = JSON.stringify(effectiveSummary, null, 2);
  const effectiveSourcesText = effectiveSources
    .map((source) => `${source.scope}:${source.source}${source.id ? `:${source.id}` : ''} -> ${(source.fields || []).join(', ')}`)
    .join('\n');
  const providerRows = providerProfiles.map((profile) => {
    const credential = profile.credential || {};
    const health = shell.providerHealth?.[profile.id] || {};
    const status = health.status || (profile.enabled ? 'unchecked' : 'disabled');
    return `
      <div class="provider-row">
        <div>
          <strong>${safeText(profile.displayName || profile.id)}</strong>
          <div class="tiny muted">${safeText(profile.kind)} · ${safeText(status)} · install ${safeText(profile.installPolicy)} · update ${safeText(profile.updatePolicy)}</div>
          <div class="tiny muted">secret: ${credential.present ? `present via ${safeText(credential.backend)}` : 'not present'} · ref ${safeText(profile.secretRef || profile.apiKeyEnv || 'none')}</div>
          ${profile.baseUrl ? `<div class="tiny muted">base URL: ${safeText(profile.baseUrl)}</div>` : ''}
        </div>
        <div class="lane-row">
          <button class="secondary" data-action="refreshProviderHealth" data-provider-id="${safeAttr(profile.id)}" type="button">Health</button>
          <button class="secondary" data-action="toggleProviderEnabled" data-provider-id="${safeAttr(profile.id)}" data-enabled="${profile.enabled ? 'false' : 'true'}" type="button">${profile.enabled ? 'Disable' : 'Enable'}</button>
          ${profile.secretRef ? `<button class="secondary" data-action="setProviderSecret" data-provider-id="${safeAttr(profile.id)}" type="button">Set secret</button>` : ''}
          ${profile.secretRef ? `<button class="secondary" data-action="deleteProviderSecret" data-provider-id="${safeAttr(profile.id)}" type="button">Delete secret</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
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
  const showMainHome = panel === 'overview' || panel === 'projects';

  refs.content.innerHTML = `
    <section class="simple-section ${showMainHome ? '' : 'is-hidden'}">
      <h3>Projects</h3>
      <a class="simple-row" href="#create">
        <span class="row-icon">＋</span>
        <span>New project</span>
      </a>
      ${projectRows || '<div class="muted">No projects yet.</div>'}
      <a class="simple-row" href="#private-access">
        <span class="row-icon">◌</span>
        <span>Private access</span>
      </a>
      <a class="simple-row" href="#providers">
        <span class="row-icon">◇</span>
        <span>Providers</span>
      </a>
      <a class="simple-row" href="#effective-settings">
        <span class="row-icon">✓</span>
        <span>Effective settings</span>
      </a>
      <a class="simple-row" href="#notifications">
        <span class="row-icon">•</span>
        <span>Notifications</span>
        ${unreadNotifications ? `<small>${safeText(unreadNotifications)} unread</small>` : ''}
      </a>
      <a class="simple-row" href="#backup">
        <span class="row-icon">⇄</span>
        <span>Backup and support</span>
      </a>
    </section>
    <div class="stat-grid compact-stats settings-stats is-hidden">
      <div class="stat">
        <b>${shell.projects.length}</b>
        <span>Projects</span>
      </div>
    </div>
    <section class="grid-2 home-panels" data-active-panel="${safeAttr(panel)}">
      <article class="card control-card" id="section-token" data-panel-card="token">
        <h3>API token</h3>
        <div class="tiny muted">${tokenConfigured ? 'Token configured for this tab.' : 'No raw token stored in this tab.'}</div>
        <div class="tiny">Browser session: <span class="tag ${browserPaired ? 'ok' : 'warn'}">${browserPaired ? 'paired' : 'not paired'}</span></div>
        <p class="muted">Use browser pairing for phone/PWA access when possible. It stores an HttpOnly session cookie instead of exposing the API token to page scripts.</p>
        <label>Token
          <input id="api-token-input" type="password" placeholder="Enter token" autocomplete="off" />
        </label>
        <div class="lane-row">
          <button class="secondary" data-action="setApiToken" type="button">Save token</button>
          <button class="secondary" data-action="clearApiToken" type="button">Clear token</button>
          <button class="secondary" data-action="createPairingCode" type="button">Create pairing code</button>
          ${browserPaired ? '<button class="secondary" data-action="logoutBrowserSession" type="button">Log out paired browser</button>' : ''}
        </div>
        <details class="disclosure">
          <summary><span>Pair this browser</span><small>one-time code</small></summary>
          <div class="disclosure-body">
            <label>Pairing code
              <input id="pairing-code-input" placeholder="ABCD-1234-EF56" autocomplete="one-time-code" />
            </label>
            <label>Device label
              <input id="pairing-label-input" placeholder="Alex phone" />
            </label>
            <button class="secondary" data-action="pairBrowserSession" type="button">Pair browser</button>
          </div>
        </details>
      </article>
        <article class="card control-card" id="section-system" data-panel-card="system">
        <details class="disclosure">
          <summary>
            <span>Executor profiles</span>
            <small>Defaults, binaries, workdirs</small>
          </summary>
          <div class="disclosure-body">${profileRows || '<div class="muted">No executor profiles loaded yet.</div>'}</div>
        </details>
      </article>
      <article class="card control-card" data-panel-card="system">
        <details class="disclosure">
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
      <article class="card control-card" id="section-private-access" data-panel-card="private-access">
        <details class="disclosure" open>
          <summary>
            <span>Private access</span>
            <small>${safeText(privateSettings.preferredMode || 'tailnet-http')} · ${safeText(tailnet.setupStatus || 'setup_pending')}</small>
          </summary>
          <div class="disclosure-body">
            <div class="access-summary">
              <div class="stat">
                <b>${tailnet.binaryAvailable ? 'Yes' : 'No'}</b>
                <span>Tailscale detected</span>
              </div>
              <div class="stat">
                <b>${tailnet.loggedIn ? 'Yes' : 'No'}</b>
                <span>Tailnet login</span>
              </div>
              <div class="stat">
                <b>${safeText(tailnet.serveMode || 'Pending')}</b>
                <span>Serve mode</span>
              </div>
            </div>
            <p>HTTP over Tailscale is private and encrypted by Tailscale but may not enable browser secure-context APIs. HTTPS Serve enables PWA features but can expose .ts.net hostname metadata through certificate transparency. Funnel is forbidden.</p>
            <form id="private-access-settings-form">
              <label>Default access mode
                <select name="preferredMode">
                  <option value="tailnet-http" ${selected(privateSettings.preferredMode, 'tailnet-http')}>Tailscale HTTP</option>
                  <option value="tailnet-https-serve" ${selected(privateSettings.preferredMode, 'tailnet-https-serve')}>Tailscale HTTPS Serve</option>
                  <option value="local" ${selected(privateSettings.preferredMode, 'local')}>Local only</option>
                </select>
              </label>
              <label>Open links
                <select name="openTarget">
                  <option value="external" ${selected(privateSettings.openTarget, 'external')}>External browser/tab</option>
                  <option value="in_app" ${selected(privateSettings.openTarget, 'in_app')}>In-app preview</option>
                </select>
              </label>
              <label>Notifications
                <select name="notificationMode">
                  <option value="in_app" ${selected(privateSettings.notificationMode, 'in_app')}>In-app only</option>
                  <option value="browser" ${selected(privateSettings.notificationMode, 'browser')}>Browser where supported</option>
                  <option value="off" ${selected(privateSettings.notificationMode, 'off')}>Off</option>
                </select>
              </label>
              <label><input type="checkbox" name="pwaMode" ${checked(privateSettings.pwaMode !== 'disabled')}> Enable PWA static shell</label>
              <button type="submit">Save private access settings</button>
            </form>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Dry-run setup commands</span>
                <small>No command runs from here</small>
              </summary>
              <div class="disclosure-body">${commandRows || '<div class="muted">No setup commands available.</div>'}</div>
            </details>
            <details class="disclosure compact-disclosure" open>
              <summary>
                <span>Project URLs</span>
                <small>${safeText(privateTargets.length)} target${privateTargets.length === 1 ? '' : 's'}</small>
              </summary>
              <div class="disclosure-body">
                ${targetRows || '<div class="muted">No private access targets yet.</div>'}
                <form id="private-access-target-form">
                  <label>Label
                    <input name="label" placeholder="Local dev server" required />
                  </label>
                  <label>Mode
                    <select name="mode">
                      <option value="local">Local</option>
                      <option value="tailnet-http">Tailscale HTTP</option>
                      <option value="tailnet-https-serve">Tailscale HTTPS Serve</option>
                    </select>
                  </label>
                  <label>Local URL
                    <input name="localUrl" placeholder="http://127.0.0.1:3000" required />
                  </label>
                  <label>Tailnet HTTP URL
                    <input name="tailnetHttpUrl" placeholder="http://device.tailnet.ts.net:3000" />
                  </label>
                  <label>HTTPS Serve URL
                    <input name="httpsServeUrl" placeholder="https://device.tailnet.ts.net" />
                  </label>
                  <label><input type="checkbox" name="favorite"> Favorite</label>
                  <button type="submit">Add project URL</button>
                </form>
              </div>
            </details>
          </div>
        </details>
      </article>
      <article class="card control-card" id="section-providers" data-panel-card="providers">
        <details class="disclosure" open>
          <summary>
            <span>Provider profiles</span>
            <small>${safeText(providerProfiles.length)} configured · credentials ${safeText(providerCatalog.credentialBackend || 'unknown')}</small>
          </summary>
          <div class="disclosure-body">
            <p>Profiles store non-secret config only. Dashboard secret entry stores into the server credential backend and never echoes values back. Installs and updates are plan-only by default.</p>
            <div class="provider-list">${providerRows || '<div class="muted">No provider profiles loaded.</div>'}</div>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Import/export</span>
                <small>No secrets included</small>
              </summary>
              <div class="disclosure-body">
                <div class="lane-row">
                  <button class="secondary" data-action="exportProviderProfiles" type="button">Export profiles</button>
                  <button class="secondary" data-action="dryRunProviderImport" type="button">Dry-run import</button>
                </div>
                <textarea id="provider-import-json" rows="8" placeholder='{"schemaVersion":1,"profiles":[]}'></textarea>
                <pre id="provider-export-output" aria-live="polite"></pre>
              </div>
            </details>
          </div>
        </details>
      </article>
      <article class="card control-card" id="section-effective-settings" data-panel-card="effective-settings">
        <details class="disclosure" open>
          <summary>
            <span>Effective settings</span>
            <small>global -> project -> session -> lane -> action</small>
          </summary>
          <div class="disclosure-body">
            <p class="muted">Resolved provider, spawn, critique, evidence, cleanup, notification, private-access, URL-opening, and mobile policy. Secret values are never part of this response.</p>
            <div class="access-summary">
              <div class="stat">
                <b>${safeText(effectiveSummary.spawn?.approvedCapacity ?? 2)}</b>
                <span>Approved capacity</span>
              </div>
              <div class="stat">
                <b>${safeText(effectiveSummary.critique?.mode || 'suggested')}</b>
                <span>Critique</span>
              </div>
              <div class="stat">
                <b>${safeText(effectiveSummary.privateAccess?.preferredMode || 'tailnet-http')}</b>
                <span>Private access</span>
              </div>
            </div>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Sources applied</span>
                <small>${safeText(effectiveSources.length)} source${effectiveSources.length === 1 ? '' : 's'}</small>
              </summary>
              <pre>${safeText(effectiveSourcesText || 'global:defaults')}</pre>
            </details>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Resolved JSON</span>
                <small>secret-free</small>
              </summary>
              <pre>${safeText(effectiveSettingsText)}</pre>
            </details>
          </div>
        </details>
      </article>
      <article class="card control-card" id="section-notifications" data-panel-card="notifications">
        <details class="disclosure" open>
          <summary>
            <span>Notifications</span>
            <small>${safeText(unreadNotifications)} unread · browser ${safeText(browserPermission)}</small>
          </summary>
          <div class="disclosure-body">
            <p class="muted">Notifications are short, secret-free status updates with safe deep links. Browser notifications require permission and are optional.</p>
            <form id="notification-settings-form">
              <label><input type="checkbox" name="inAppEnabled" ${checked(notificationSettings.inAppEnabled !== false)}> Enable in-app notifications</label>
              <label><input type="checkbox" name="browserEnabled" ${checked(Boolean(notificationSettings.browserEnabled))}> Enable browser notifications where supported</label>
              <label>Minimum severity
                <select name="minSeverity">
                  <option value="info" ${selected(notificationSettings.minSeverity, 'info')}>Info and up</option>
                  <option value="warning" ${selected(notificationSettings.minSeverity, 'warning')}>Warnings and errors</option>
                  <option value="error" ${selected(notificationSettings.minSeverity, 'error')}>Errors only</option>
                </select>
              </label>
              <label><input type="checkbox" name="muted" ${checked(Boolean(notificationSettings.muted))}> Mute notifications</label>
              <div class="lane-row">
                <button type="submit">Save notifications</button>
                ${browserNotificationsSupported()
                  ? '<button class="secondary" data-action="requestBrowserNotifications" type="button">Browser permission</button>'
                  : '<button class="secondary" type="button" disabled title="This browser does not support Notification API">Browser unavailable</button>'}
                ${unreadNotifications ? '<button class="secondary" data-action="markAllNotificationsRead" type="button">Mark all read</button>' : '<button class="secondary" type="button" disabled title="There are no unread notifications to mark read.">No unread notifications</button>'}
              </div>
            </form>
            <div class="provider-list">${notificationRows || '<div class="muted">No notifications yet.</div>'}</div>
          </div>
        </details>
      </article>
      <article class="card control-card" id="section-backup" data-panel-card="backup">
        <details class="disclosure" open>
          <summary>
            <span>Backup and support</span>
            <small>Local-only export · redacted support bundle</small>
          </summary>
          <div class="disclosure-body">
            <p class="muted">App exports include projects, sessions, lane metadata, provider config, private-access targets, MCP tools, cleanup schedule, and notification settings. They exclude secret values, auth sessions, pairing codes, artifacts, logs, screenshots, videos, and traces.</p>
            <div class="lane-row">
              <button class="secondary" data-action="exportAppBackup" type="button">Export app backup</button>
              <button class="secondary" data-action="exportSupportBundle" type="button">Export support bundle</button>
            </div>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Import backup</span>
                <small>dry-run before apply</small>
              </summary>
              <div class="disclosure-body">
                <textarea id="app-import-json" rows="8" placeholder='{"schemaVersion":1,"kind":"command-deck.app-export"}'></textarea>
                <div class="lane-row">
                  <button class="secondary" data-action="dryRunAppImport" type="button">Dry-run import</button>
                  <button class="danger" data-action="applyAppImport" type="button">Apply import</button>
                </div>
              </div>
            </details>
            <pre id="app-export-output" aria-live="polite"></pre>
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

async function handlePrivateAccessSettings(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const response = await api('/api/private-access/settings', {
    method: 'PATCH',
    body: {
      actor: 'dashboard',
      preferredMode: formData.get('preferredMode'),
      openTarget: formData.get('openTarget'),
      notificationMode: formData.get('notificationMode'),
      pwaMode: formData.has('pwaMode') ? 'enabled' : 'disabled',
    },
  });
  if (response.ok) {
    renderAlert('Private access settings saved.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not save private access settings.', 'bad');
  }
}

async function handleNotificationSettings(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const browserEnabled = formData.has('browserEnabled');
  if (browserEnabled && browserNotificationPermission() === 'default') {
    await requestBrowserNotificationPermission();
  }
  const approval = buildApprovedActionBody('manageNotifications', 'Update notification delivery settings?');
  if (!approval.approved) {
    renderAlert('Notification settings update canceled.');
    return;
  }
  const response = await api('/api/notifications/settings', {
    method: 'PATCH',
    body: {
      actor: approval.actor,
      approved: approval.approved,
      inAppEnabled: formData.has('inAppEnabled'),
      browserEnabled,
      minSeverity: formData.get('minSeverity'),
      muted: formData.has('muted'),
    },
  });
  if (response.ok) {
    shell.notifications = response.data;
    renderAlert('Notification settings saved.');
    maybeShowBrowserNotifications();
    await refresh();
  } else if (response.data?.requiresApproval) {
    renderAlert('Approval required to update notifications.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Could not save notification settings.', 'bad');
  }
}

async function handleNotificationAction(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'requestBrowserNotifications') {
    await requestBrowserNotificationPermission();
    return;
  }
  if (action === 'markNotificationRead') {
    const notificationId = event.currentTarget.dataset.notificationId;
    if (!notificationId) return;
    const response = await api(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
      method: 'POST',
      body: { actor: 'dashboard' },
    });
    if (response.ok) {
      renderAlert('Notification marked read.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not mark notification read.', 'bad');
    }
    return;
  }
  if (action === 'markAllNotificationsRead') {
    const response = await api('/api/notifications/read-all', {
      method: 'POST',
      body: { actor: 'dashboard' },
    });
    if (response.ok) {
      renderAlert(`Marked ${response.data?.updated || 0} notification(s) read.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not mark notifications read.', 'bad');
    }
  }
}

async function handleCreatePrivateAccessTarget(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const response = await api('/api/private-access/targets', {
    method: 'POST',
    body: {
      actor: 'dashboard',
      label: formData.get('label'),
      mode: formData.get('mode'),
      localUrl: formData.get('localUrl'),
      tailnetHttpUrl: formData.get('tailnetHttpUrl'),
      httpsServeUrl: formData.get('httpsServeUrl'),
      favorite: formData.has('favorite'),
    },
  });
  if (response.ok) {
    renderAlert('Private access target added.');
    form.reset();
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not add private access target.', 'bad');
  }
}

async function handlePrivateAccessAction(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'copyPrivateAccessCommand') {
    const command = event.currentTarget.dataset.command || '';
    if (!command) {
      renderAlert('Nothing to copy.', 'bad');
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      renderAlert('Copied private access command.');
    } catch {
      renderAlert(command);
    }
    return;
  }
  const targetId = event.currentTarget.dataset.targetId;
  if (!targetId) return;
  if (action === 'checkPrivateAccessTarget') {
    const response = await api(`/api/private-access/targets/${encodeURIComponent(targetId)}/check`, {
      method: 'POST',
      body: { actor: 'dashboard' },
    });
    if (response.ok) {
      renderAlert(`Private access target is ${response.data?.result?.status || 'checked'}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not check private access target.', 'bad');
    }
    return;
  }
  if (action === 'deletePrivateAccessTarget') {
    if (!window.confirm('Remove this private access target?')) return;
    const response = await api(`/api/private-access/targets/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
      body: { actor: 'dashboard' },
    });
    if (response.ok) {
      renderAlert('Private access target removed.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not remove private access target.', 'bad');
    }
  }
}

async function handleProviderAction(event) {
  const action = event.currentTarget.dataset.action;
  const providerId = event.currentTarget.dataset.providerId;
  if (action === 'refreshProviderHealth') {
    const response = await api(`/api/providers/${encodeURIComponent(providerId)}/health`);
    if (response.ok) {
      shell.providerHealth[providerId] = response.data;
      renderAlert(`${providerId} health: ${response.data?.status || 'checked'}.`);
      render(captureContentUiState());
    } else {
      renderAlert(response.data?.error || 'Could not refresh provider health.', 'bad');
    }
    return;
  }
  if (action === 'toggleProviderEnabled') {
    const nextEnabled = event.currentTarget.dataset.enabled === 'true';
    const approval = buildApprovedActionBody('manageExecutorCli', `${nextEnabled ? 'Enable' : 'Disable'} provider ${providerId}?`);
    if (!approval.approved) return;
    const response = await api(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        enabled: nextEnabled,
      },
    });
    if (response.ok) {
      renderAlert(`${providerId} ${nextEnabled ? 'enabled' : 'disabled'}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not update provider.', 'bad');
    }
    return;
  }
  if (action === 'setProviderSecret') {
    const secret = window.prompt(`Enter API key/secret for ${providerId}. It will be sent once and never shown again.`);
    if (!secret) return;
    const approval = buildApprovedActionBody('manageExecutorCli', `Store secret for provider ${providerId}?`);
    if (!approval.approved) return;
    const response = await api(`/api/providers/${encodeURIComponent(providerId)}/secret`, {
      method: 'POST',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        secret,
      },
    });
    if (response.ok) {
      renderAlert(`${providerId} secret stored via ${response.data?.credential?.backend || 'credential backend'}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not store provider secret.', 'bad');
    }
    return;
  }
  if (action === 'deleteProviderSecret') {
    const confirmed = window.confirm(`Delete stored secret for ${providerId}? Env fallback may still be used if configured.`);
    if (!confirmed) return;
    const approval = buildApprovedActionBody('manageExecutorCli', `Delete secret for provider ${providerId}?`);
    if (!approval.approved) return;
    const response = await api(`/api/providers/${encodeURIComponent(providerId)}/secret`, {
      method: 'DELETE',
      body: {
        actor: approval.actor,
        approved: approval.approved,
      },
    });
    if (response.ok) {
      renderAlert(`${providerId} secret delete request completed.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not delete provider secret.', 'bad');
    }
    return;
  }
  if (action === 'exportProviderProfiles') {
    const response = await api('/api/providers/export');
    const output = document.getElementById('provider-export-output');
    if (response.ok && output) {
      output.textContent = JSON.stringify(response.data, null, 2);
      renderAlert('Provider profiles exported without secrets.');
    } else {
      renderAlert(response.data?.error || 'Could not export provider profiles.', 'bad');
    }
    return;
  }
  if (action === 'dryRunProviderImport') {
    const source = document.getElementById('provider-import-json');
    const output = document.getElementById('provider-export-output');
    let parsed = null;
    try {
      parsed = JSON.parse(source?.value || '{}');
    } catch {
      renderAlert('Provider import JSON is invalid.', 'bad');
      return;
    }
    const response = await api('/api/providers/import/dry-run', {
      method: 'POST',
      body: parsed,
    });
    if (output) output.textContent = JSON.stringify(response.data, null, 2);
    renderAlert(response.ok ? 'Provider import dry-run completed.' : (response.data?.error || 'Provider import dry-run failed.'), response.ok ? 'info' : 'bad');
  }
}

async function handleAppBackupAction(event) {
  const action = event.currentTarget.dataset.action;
  const output = document.getElementById('app-export-output');
  const input = document.getElementById('app-import-json');

  if (action === 'exportAppBackup' || action === 'exportSupportBundle') {
    const route = action === 'exportAppBackup' ? '/api/app/export' : '/api/app/support-bundle';
    const response = await api(route);
    if (output) output.textContent = JSON.stringify(response.data, null, 2);
    renderAlert(response.ok
      ? (action === 'exportAppBackup' ? 'App backup exported without secrets.' : 'Support bundle exported without secrets.')
      : (response.data?.error || 'Could not export app data.'),
    response.ok ? 'info' : 'bad');
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(input?.value || '{}');
  } catch {
    renderAlert('App import JSON is invalid.', 'bad');
    return;
  }

  if (action === 'dryRunAppImport') {
    const response = await api('/api/app/import/dry-run', {
      method: 'POST',
      body: parsed,
    });
    if (output) output.textContent = JSON.stringify(response.data, null, 2);
    renderAlert(response.ok ? 'App import dry-run completed.' : (response.data?.error || 'App import dry-run failed.'), response.ok ? 'info' : 'bad');
    return;
  }

  if (action === 'applyAppImport') {
    const confirmed = window.confirm('Apply this app backup non-destructively? Existing IDs are skipped and active lanes are imported as stopped.');
    if (!confirmed) {
      renderAlert('App import canceled.');
      return;
    }
    const approval = buildApprovedActionBody('manageAppBackups', 'Approve app backup import?');
    if (!approval.approved) {
      renderAlert('App import canceled.');
      return;
    }
    const response = await api('/api/app/import/apply', {
      method: 'POST',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        payload: parsed,
      },
    });
    if (output) output.textContent = JSON.stringify(response.data, null, 2);
    if (response.ok) {
      renderAlert('App import applied non-destructively.');
      await refresh();
      return;
    }
    renderAlert(response.data?.error || 'App import apply failed.', 'bad');
  }
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
  const quickLinksMarkup = project.quickLinks.map((quick) => `<a href="${safeText(quick.url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.label)}</a>`).join('');

  refs.content.innerHTML = `
    <section class="project-shell">
      <div class="project-workspace">
        <div class="project-main">
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
        <aside class="project-side-panel" id="project-tools" aria-label="Project tools">
          <details class="disclosure">
            <summary>
              <span>Quick links</span>
              <small>Dev routes</small>
            </summary>
            <div class="disclosure-body">
              <div class="lane-row">${quickLinksMarkup || '<span class="muted">No quick links.</span>'}</div>
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
          <details class="disclosure">
            <summary>
              <span>Operations</span>
              <small>Global tools</small>
            </summary>
            <div class="disclosure-body action-list">
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

function renderSession(project, session) {
  const laneList = shell.lanes.filter((lane) => lane.sessionId === session.id).map((lane) => renderLaneCard(lane)).join('');
  const pendingAudits = pendingAuditsForSession(session.id);
  const pendingAuditSummary = pendingAudits.length
    ? `<p>Pending audit events: ${pendingAudits.length}</p>`
    : '<p>No pending audit events.</p>';
  refs.content.innerHTML = `
    <section class="session-shell">
      <div class="session-toolbar">
        <div class="tiny muted">${safeText(project.name)} · ${safeText(session.leader)} led</div>
      </div>
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
                <option value="codex">codex</option>
                <option value="claude">claude</option>
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
    <section class="lane-detail-shell">
      ${(lane.warnings || []).map((warning) => `
        <div class="alert bad"><strong>Warning:</strong> ${safeText(warning.message || warning.kind)}</div>
      `).join('')}
      <div class="card lane-detail-card">
        <p><a href="${session.route}" class="secondary">Back</a></p>
        <h3>${safeText(lane.title)}</h3>
        <p>${safeText(lane.taskDescription || 'No task description')}</p>
        ${lane.taskPrompt ? `<div class="tiny"><strong>Task prompt:</strong> ${safeText(lane.taskPrompt)}</div>` : ''}
        ${lane.targetUrl ? `<div class="tiny"><strong>Target URL:</strong> <a class="secondary" href="${safeText(lane.targetUrl)}" target="_blank" rel="noopener noreferrer">${safeText(lane.targetUrl)}</a></div>` : ''}
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
          ${lane.model || lane.permissionsProfile || lane.branch ? `<div class="tiny">Model: ${safeText(lane.model || '—')} / Permissions: ${safeText(lane.permissionsProfile || '—')} / Branch: ${safeText(lane.branch || '—')}</div>` : ''}
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

function render(uiState = null) {
  const project = shell.projects.find((value) => value.slug === shell.route.projectSlug || value.id === shell.route.projectSlug);
  const sessions = project ? shell.sessions : [];
  const session = sessions.find((value) => value.id === shell.route.sessionId);
  const lane = shell.lanes.find((value) => value.id === shell.route.laneId);

  renderBreadcrumbs(project, session);
  renderTopbarTitle(project, session, lane);
  renderStatusStrip();
  renderBlockers();
  renderSidebarProjects(project);
  if (refs.content) refs.content.setAttribute('aria-busy', 'false');
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
          <button class="sidebar-archive" type="button" aria-label="Archive ${safeAttr(session.name)} session" title="Archive session is not wired yet" aria-disabled="true" disabled>
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
        </div>
        ${sessionRows || '<div class="tiny muted sidebar-empty">No sessions yet.</div>'}
      </div>
    `;
  };
  const primaryProjects = orderItems(projects.filter((project) => !isVerificationProject(project)), storedOrder.projects);
  refs.sidebarProjects.innerHTML = primaryProjects.map(renderSidebarProject).join('');
}

function setupSidebarReorder() {
  if (!refs.sidebarProjects) return;
  let dragged = null;
  refs.sidebarProjects.addEventListener('dragstart', (event) => {
    const item = event.target?.closest?.('[data-reorder-kind]');
    if (!item) return;
    dragged = {
      kind: item.dataset.reorderKind,
      projectId: item.dataset.projectId || '',
      sessionId: item.dataset.sessionId || '',
    };
    item.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify(dragged));
  });
  refs.sidebarProjects.addEventListener('dragover', (event) => {
    if (!dragged) return;
    const target = event.target?.closest?.('[data-reorder-kind]');
    if (!target || target.dataset.reorderKind !== dragged.kind) return;
    if (dragged.kind === 'session' && target.dataset.projectId !== dragged.projectId) return;
    event.preventDefault();
    target.classList.add('is-drop-target');
    event.dataTransfer.dropEffect = 'move';
  });
  refs.sidebarProjects.addEventListener('dragleave', (event) => {
    event.target?.closest?.('[data-reorder-kind]')?.classList.remove('is-drop-target');
  });
  refs.sidebarProjects.addEventListener('drop', (event) => {
    const target = event.target?.closest?.('[data-reorder-kind]');
    refs.sidebarProjects.querySelectorAll('.is-drop-target').forEach((item) => item.classList.remove('is-drop-target'));
    if (!dragged || !target || target.dataset.reorderKind !== dragged.kind) return;
    event.preventDefault();
    const order = readSidebarOrder();
    if (dragged.kind === 'project') {
      const sourceId = dragged.projectId;
      const targetId = target.dataset.projectId;
      if (!sourceId || !targetId || sourceId === targetId) return;
      const ids = orderItems((shell.projects || []).filter((project) => !isVerificationProject(project)), order.projects).map((project) => project.id);
      order.projects = moveId(ids, sourceId, targetId);
    }
    if (dragged.kind === 'session') {
      const sourceId = dragged.sessionId;
      const targetId = target.dataset.sessionId;
      const projectId = dragged.projectId;
      if (!sourceId || !targetId || !projectId || sourceId === targetId || target.dataset.projectId !== projectId) return;
      const ids = orderItems((shell.sessions || []).filter((session) => session.projectId === projectId), order.sessions[projectId] || []).map((session) => session.id);
      order.sessions[projectId] = moveId(ids, sourceId, targetId);
    }
    writeSidebarOrder(order);
    renderSidebarProjects(currentActiveProject());
  });
  refs.sidebarProjects.addEventListener('dragend', () => {
    dragged = null;
    refs.sidebarProjects.querySelectorAll('.is-dragging, .is-drop-target').forEach((item) => item.classList.remove('is-dragging', 'is-drop-target'));
  });
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
  const authResp = await api('/api/auth/status');
  if (authResp.ok && authResp.data) {
    shell.authStatus = authResp.data;
  }
  const policyResp = await api('/api/policy');
  if (policyResp.ok && policyResp.data) {
    shell.policy = policyResp.data.policies;
  }
  const effectiveSettingsResp = await api('/api/settings/effective');
  if (effectiveSettingsResp.ok && effectiveSettingsResp.data) {
    shell.effectiveSettings = effectiveSettingsResp.data;
  }
  const notificationsResp = await api('/api/notifications');
  if (notificationsResp.ok && notificationsResp.data) {
    shell.notifications = notificationsResp.data;
    maybeShowBrowserNotifications();
  }
  const blockersResp = await api('/api/system/blockers');
  if (blockersResp.ok && Array.isArray(blockersResp.data?.blockers)) {
    shell.systemBlockers = blockersResp.data.blockers;
  }
  const privateAccessResp = await api('/api/private-access');
  if (privateAccessResp.ok && privateAccessResp.data) {
    shell.privateAccess = privateAccessResp.data;
  }
  const profilesResp = await api('/api/executors/profiles');
  if (profilesResp.ok && profilesResp.data?.profiles) {
    shell.executorProfiles = profilesResp.data.profiles;
  }
  const providerCatalogResp = await api('/api/providers');
  if (providerCatalogResp.ok && providerCatalogResp.data) {
    shell.providerCatalog = providerCatalogResp.data;
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
  render(captureContentUiState());
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
  if (action === 'createPairingCode') {
    const response = await api('/api/auth/pairing-codes', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        label: 'Phone/browser pairing',
      },
    });
    if (response.ok) {
      renderAlert(`Pairing code: ${response.data?.pairing?.code || 'created'}`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not create pairing code.', 'bad');
    }
    return;
  }
  if (action === 'pairBrowserSession') {
    const code = document.getElementById('pairing-code-input')?.value || '';
    const label = document.getElementById('pairing-label-input')?.value || 'Paired browser';
    const response = await api('/api/auth/pair', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        code,
        label,
      },
    });
    if (response.ok) {
      renderAlert('Browser paired.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not pair browser.', 'bad');
    }
    return;
  }
  if (action === 'logoutBrowserSession') {
    const response = await api('/api/auth/logout', {
      method: 'POST',
      body: {
        actor: 'dashboard',
      },
    });
    if (response.ok) {
      renderAlert('Paired browser session logged out.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not log out paired browser.', 'bad');
    }
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
  if (event.target.id === 'private-access-settings-form') {
    await handlePrivateAccessSettings(event);
    return;
  }
  if (event.target.id === 'notification-settings-form') {
    await handleNotificationSettings(event);
    return;
  }
  if (event.target.id === 'private-access-target-form') {
    await handleCreatePrivateAccessTarget(event);
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
    if (window.matchMedia('(max-width: 880px)').matches) {
      document.body.classList.toggle('nav-open');
    } else {
      document.body.classList.toggle('sidebar-collapsed');
    }
    return;
  }
  // Auto-close mobile sidebar when navigating.
  if (event.target?.closest?.('.sidebar-link, .sidebar-thread')) {
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
    'createPairingCode',
    'pairBrowserSession',
    'logoutBrowserSession',
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

  if ([
    'checkPrivateAccessTarget',
    'copyPrivateAccessCommand',
    'deletePrivateAccessTarget',
  ].includes(action)) {
    await handlePrivateAccessAction({ currentTarget: actionTarget });
    return;
  }

  if ([
    'markAllNotificationsRead',
    'markNotificationRead',
    'requestBrowserNotifications',
  ].includes(action)) {
    await handleNotificationAction({ currentTarget: actionTarget });
    return;
  }

  if ([
    'deleteProviderSecret',
    'dryRunProviderImport',
    'exportProviderProfiles',
    'refreshProviderHealth',
    'setProviderSecret',
    'toggleProviderEnabled',
  ].includes(action)) {
    await handleProviderAction({ currentTarget: actionTarget });
    return;
  }

  if ([
    'applyAppImport',
    'dryRunAppImport',
    'exportAppBackup',
    'exportSupportBundle',
  ].includes(action)) {
    await handleAppBackupAction({ currentTarget: actionTarget });
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
registerServiceWorker();
renderMobileManifest();
setupSidebarReorder();
refresh();
