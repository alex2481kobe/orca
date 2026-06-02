import { qrSvgForText } from './ui/qr.js';
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
  authSessions: null,
  lastPairing: null,
  executorPanelOpen: true,
};

let refreshRequestId = 0;
let refreshInFlight = false;
let lastRefreshAt = 0;
const MOBILE_NAV_BREAKPOINT = 880;

const API_PROVIDER_EXECUTOR_TYPES = ['api', 'openai-compatible', 'gemini', 'kimi', 'deepseek', 'openrouter', 'composer'];
const FIRST_CLASS_CLI_EXECUTOR_TYPES = ['codex', 'claude', 'gemini-cli', 'composer-cli'];
const CLI_EXECUTOR_TARGET_ALIASES = {
  codex: ['codex'],
  claude: ['claude'],
  'gemini-cli': ['gemini', 'gemini-cli'],
  'composer-cli': ['cursor-agent', 'composer-cli'],
};
const MCP_TOOL_SCOPE_ALLOWLIST = [
  'all',
  'mock',
  'codex',
  'claude',
  'gemini-cli',
  'composer-cli',
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
const API_TOKEN_STORAGE_KEY = 'orcaApiToken';
const SIDEBAR_ORDER_STORAGE_KEY = 'orcaSidebarOrder:v1';
const NOTIFICATION_SEEN_STORAGE_KEY = 'orcaNotificationsSeen:v1';
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
const PENCIL_ICON = `
  <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
    <path d="m12.4 4.6 3 3"></path>
    <path d="M13.6 3.4a1.7 1.7 0 0 1 2.4 2.4l-8.5 8.5-3.2.8.8-3.2 8.5-8.5Z"></path>
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
  if (!window.location.search) return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has('apiToken') && !params.has('token')) return;
  const cleaned = new URLSearchParams(window.location.search);
  cleaned.delete('apiToken');
  cleaned.delete('token');
  const next = cleaned.toString();
  const query = next ? `?${next}` : '';
  const url = `${window.location.pathname}${query}${window.location.hash || ''}`;
  window.history.replaceState({}, '', url);
}

function isTrustedAdminClientHost() {
  const hostname = String(window.location.hostname || '').toLowerCase();
  return isLocalHostName(hostname) || hostname.endsWith('.local');
}

function browserAccessBlocked() {
  return Boolean(
    (shell.authStatus?.apiTokenRequired
      && !shell.authStatus?.apiTokenAuthenticated
      && !shell.authStatus?.browserSessionAuthenticated)
    || (!shell.authStatus?.apiTokenRequired
      && !isTrustedAdminClientHost()
      && !shell.authStatus?.browserSessionAuthenticated),
  );
}

// After any tap/click, drop focus from the activated control so it never stays
// visually "stuck" highlighted on touch (the dominant cause of lingering
// highlight). Covers every interactive surface except text-entry fields, which
// must keep focus for the keyboard.
const STICKY_INTERACTIVE_SELECTOR = [
  'button',
  'a',
  'summary',
  '[data-action]',
  '[data-href]',
  '[data-route]',
  '.click-card',
  '.simple-row',
  '.nav-tile',
  '.sidebar-link',
  '.sidebar-thread',
  '.sidebar-compose',
  '.sidebar-archive',
  '.sidebar-project-archive',
  '.sidebar-project-rename',
  '.sidebar-rename',
  '.sidebar-project-group',
  '.sidebar-project-line',
  '.sidebar-session-line',
  '.sidebar-create-project',
  '.settings-row',
  '.shell-toggle',
].join(', ');

function clearStickyInteractiveState(eventTarget) {
  const interactive = eventTarget?.closest?.(STICKY_INTERACTIVE_SELECTOR);
  if (interactive && typeof interactive.blur === 'function') {
    window.setTimeout(() => {
      interactive.blur();
    }, 0);
  }
}

function hideMobileSidebar() {
  if (!isMobileLayout()) return;
  document.body.classList.remove('nav-open');
  sidebarLongPressIgnoreUntil = 0;
  sidebarLongPressOpened = false;
  closeSidebarActionMenus();
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

function clientUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, window.location.origin);
    if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
      parsed.protocol = window.location.protocol;
      parsed.hostname = window.location.hostname;
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

// Attribute-safe href/src value. Only same-page anchors, root-relative paths,
// and http(s) URLs are allowed; anything else (e.g. javascript:) becomes '#'.
function safeHref(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') || raw.startsWith('#')) return safeAttr(raw);
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return safeAttr(parsed.toString());
    }
  } catch {
    /* fall through to safe no-op */
  }
  return '#';
}

// Only navigate to safe destinations (blocks javascript:/data: from server data).
function safeNavigate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return;
  if (raw.startsWith('/') || raw.startsWith('#')) {
    window.location.href = raw;
    return;
  }
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      window.location.href = parsed.toString();
    }
  } catch {
    /* refuse unsafe navigation */
  }
}

function authRequiredMessage() {
  return 'This browser is not authenticated. Pair it from the trusted workstation or unlock the workstation with the API token.';
}

function isLocalHostName(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').toLowerCase());
}

function clearProtectedWorkspaceState() {
  shell.projects = [];
  shell.sessions = [];
  shell.lanes = [];
  shell.policy = {};
  shell.alerts = [];
  shell.pendingAuditEvents = [];
  shell.mcpTools = [];
  shell.providerCatalog = null;
  shell.notifications = null;
  shell.authSessions = null;
  shell.executorProfiles = null;
  shell.executorCliInfo = {};
}

function lockClientAuthState() {
  shell.authStatus = {
    ...(shell.authStatus || {}),
    apiTokenRequired: shell.authStatus?.apiTokenRequired || true,
    apiTokenAuthenticated: false,
    browserSessionAuthenticated: false,
  };
  clearProtectedWorkspaceState();
}

function maybeLockFromResponse(response) {
  if (!response || response.status !== 401) return false;
  if (!browserAccessBlocked()) {
    lockClientAuthState();
  }
  return true;
}

function abortRefreshFromUnauthorized(response, requestId, uiState) {
  if (!response || response.status !== 401) return false;
  if (requestId !== refreshRequestId) return true;
  if (maybeLockFromResponse(response)) {
    render(uiState || null);
  }
  return true;
}

// Cache the MediaQueryList and track its value so pointer/click handlers don't
// re-run matchMedia() several times per gesture.
let _mobileMql = null;
let _isMobileCached = false;
function isMobileLayout() {
  if (!_mobileMql) {
    _mobileMql = window.matchMedia(`(max-width: ${MOBILE_NAV_BREAKPOINT}px)`);
    _isMobileCached = _mobileMql.matches;
    const onChange = (event) => { _isMobileCached = event.matches; };
    if (typeof _mobileMql.addEventListener === 'function') _mobileMql.addEventListener('change', onChange);
    else if (typeof _mobileMql.addListener === 'function') _mobileMql.addListener(onChange);
  }
  return _isMobileCached;
}

// Assign innerHTML only when it actually changed, so the per-refresh poll does
// not destroy/recreate identical DOM (avoids needless layout/paint churn).
function writeHtml(el, html) {
  if (!el) return;
  if (el.__lastHtml === html) return;
  el.__lastHtml = html;
  el.innerHTML = html;
}

function closeMobileNavPanel() {
  document.body.classList.remove('nav-open');
}

function openMobileNavPanel() {
  if (!isMobileLayout()) return;
  document.body.classList.add('nav-open');
}

function accessModeLabel(mode) {
  if (mode === 'tailnet-https-serve') return 'Tailscale HTTPS Serve';
  if (mode === 'tailnet-http') return 'Tailscale HTTP';
  if (mode === 'local') return 'Local only';
  return 'Auto-detect';
}

function effectiveAccessMode(privateSettings = {}, tailnet = {}) {
  const preferredMode = String(privateSettings.preferredMode || 'auto').toLowerCase();
  if (preferredMode === 'local' || preferredMode === 'tailnet-http' || preferredMode === 'tailnet-https-serve') {
    return preferredMode;
  }
  if (tailnet.serveMode === 'tailnet-https-serve') return 'tailnet-https-serve';
  if (tailnet.serveMode === 'tailnet-http') return 'tailnet-http';
  return 'tailnet-http';
}

function exactUrlForAccessMode(target, mode) {
  if (!target) return '';
  if (mode === 'local') return target.localUrl || '';
  if (mode === 'tailnet-https-serve') return target.httpsServeUrl || '';
  if (mode === 'tailnet-http') return target.tailnetHttpUrl || '';
  return target.tailnetHttpUrl || target.httpsServeUrl || target.localUrl || '';
}

function fallbackUrlForAccessMode(target, mode) {
  if (!target) return '';
  if (mode === 'local') return target.localUrl || '';
  if (mode === 'tailnet-https-serve') return target.httpsServeUrl || target.tailnetHttpUrl || target.localUrl || '';
  if (mode === 'tailnet-http') return target.tailnetHttpUrl || target.httpsServeUrl || target.localUrl || '';
  return target.tailnetHttpUrl || target.httpsServeUrl || target.localUrl || '';
}

function effectiveProjectQuickLinkUrl(quick, mode = 'auto') {
  if (!quick) return '';
  if (mode === 'local') return quick.localUrl || quick.url || '';
  if (mode === 'tailnet-http') return quick.tailnetHttpUrl || quick.httpsServeUrl || quick.localUrl || quick.url || '';
  if (mode === 'tailnet-https-serve') return quick.httpsServeUrl || quick.tailnetHttpUrl || quick.localUrl || quick.url || '';
  return quick.url || quick.tailnetHttpUrl || quick.httpsServeUrl || quick.localUrl || '';
}

function quickLinkHealthLabel(status) {
  if (status === 'reachable') return 'Reachable';
  if (status === 'unreachable') return 'Unreachable';
  if (status === 'not_checkable') return 'Dashboard link';
  return 'Unchecked';
}

function preferredPhoneUrl(privateTargets = [], privateSettings = {}, tailnet = {}) {
  if (!isLocalHostName(window.location.hostname)) return window.location.origin;
  const targets = privateTargets.filter((item) => !item.hidden);
  const mode = effectiveAccessMode(privateSettings, tailnet);
  const target = targets.find((item) => item.favorite && exactUrlForAccessMode(item, mode)) ||
    targets.find((item) => item.mode === mode && exactUrlForAccessMode(item, mode)) ||
    targets.find((item) => exactUrlForAccessMode(item, mode)) ||
    targets.find((item) => item.favorite && fallbackUrlForAccessMode(item, mode)) ||
    targets.find((item) => fallbackUrlForAccessMode(item, mode));
  const url = exactUrlForAccessMode(target, mode) || fallbackUrlForAccessMode(target, mode);
  return url ? clientUrl(url) : window.location.origin;
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
  const first = String(commandParts[0]).toLowerCase();
  const aliases = CLI_EXECUTOR_TARGET_ALIASES[normalizedType] || [normalizedType];
  return aliases.some((alias) => first.includes(alias));
}

function executorTargetsBinary(executorType, binary) {
  const normalizedType = normalizeExecutorType(executorType);
  if (!normalizedType) return true;
  const normalizedBinary = String(binary || '').trim().toLowerCase();
  const binaryName = normalizedBinary.split('/').pop();
  const aliases = CLI_EXECUTOR_TARGET_ALIASES[normalizedType] || [normalizedType];
  return aliases.some((alias) => binaryName.includes(alias));
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

function cliExecutorOptions(selected = '') {
  const profiles = shell.executorProfiles || {};
  return FIRST_CLASS_CLI_EXECUTOR_TYPES
    .filter((id) => profiles[id])
    .map((id) => {
      const selectedAttr = normalizeExecutorType(selected) === id ? ' selected' : '';
      return `<option value="${safeAttr(id)}"${selectedAttr}>${safeText(id)}</option>`;
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
  const allowed = new Set(['projects', 'setup', 'create', 'system', 'mcp', 'audit', 'cleanup', 'token', 'private-access', 'providers', 'effective-settings', 'notifications', 'backup', 'pair']);
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
    const notice = new window.Notification(item.title || 'Orca update', {
      body: item.body || item.severity || 'Status changed',
      tag: item.id,
      renotify: false,
    });
    if (item.href) {
      notice.onclick = () => {
        window.focus();
        safeNavigate(item.href);
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
    headers['x-orca-token'] = shell.apiToken;
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
  const normalizedResponse = { ok: resp.ok, status: resp.status, data: bodyJson };
  if (normalizedResponse.status === 401 && !browserAccessBlocked()) {
    maybeLockFromResponse(normalizedResponse);
  }
  return normalizedResponse;
}

function renderBreadcrumbs(project, session) {
  refs.breadcrumbs.innerHTML = '';
}

function renderTopbarTitle(project, session, lane) {
  if (!refs.topbarTitle) return;
  refs.topbarTitle.textContent = 'Orca';
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
  const selected = (actual, expected) => String(actual || '') === String(expected || '') ? 'selected' : '';
  const checked = (value) => value ? 'checked' : '';
  const accessMode = effectiveAccessMode(privateSettings, tailnet);
  const preferredAccessMode = privateSettings.preferredMode || 'auto';
  const accessModeSummary = preferredAccessMode === 'auto'
    ? `auto -> ${accessModeLabel(accessMode)}`
    : accessModeLabel(accessMode);
  const accessModeOptions = `
    <option value="auto" ${selected(preferredAccessMode, 'auto')}>Auto-detect</option>
    <option value="tailnet-http" ${selected(preferredAccessMode, 'tailnet-http')}>Tailscale HTTP</option>
    <option value="tailnet-https-serve" ${selected(preferredAccessMode, 'tailnet-https-serve')}>Tailscale HTTPS Serve</option>
    <option value="local" ${selected(preferredAccessMode, 'local')}>Local only</option>
  `;
  const phoneUrl = preferredPhoneUrl(privateTargets, privateSettings, tailnet);
  const phoneQr = qrSvgForText(phoneUrl);
  const notificationState = shell.notifications || {};
  const notificationSettings = notificationState.settings || {};
  const notificationItems = Array.isArray(notificationState.notifications) ? notificationState.notifications : [];
  const unreadNotifications = Number.parseInt(notificationState.unreadCount, 10) || 0;
  const browserPermission = browserNotificationPermission();
  const setupCommands = Array.isArray(privateAccess.setupPlan?.commands) ? privateAccess.setupPlan.commands : [];
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
    const targetUrl = fallbackUrlForAccessMode(target, target.mode);
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
        <strong>${safeText(notification.title || 'Orca update')}</strong>
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
    const envKey = typeUpper ? `ORCA_${typeUpper}` : null;
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
        ${renderExecutorCapabilities(executorCapabilitiesFor(profile.type), { compact: true })}
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
          ${renderExecutorCapabilities(info?.capabilities, { compact: true })}
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
    const quickLinks = (Array.isArray(project.quickLinks) ? project.quickLinks : [])
      .filter((quick) => !quick.hidden)
      .map((quick) => {
        const url = clientUrl(effectiveProjectQuickLinkUrl(quick));
        return `<div><a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.label)}</a></div>`;
      }).join('');
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
          <a class="button-secondary" href="${safeHref(project.route)}">Open project</a>
        </div>
      </article>
    `;
  };
  const primaryProjectCards = shell.projects.filter((project) => !isVerificationProject(project)).map(renderProjectCard).join('');
  const verificationProjects = shell.projects.filter(isVerificationProject);
  const verificationProjectCards = verificationProjects.map(renderProjectCard).join('');
  const authSessionRows = (Array.isArray(shell.authSessions) ? shell.authSessions : []).map((session) => `
    <div class="provider-row">
      <div>
        <strong>${safeText(session.label || 'Paired browser')}</strong>
        <div class="tiny muted">${session.active ? 'active' : 'inactive'} · created ${safeText(formatRelative(session.createdAt))} · expires ${safeText(formatRelative(session.expiresAt))}</div>
        ${session.userAgent ? `<div class="tiny muted">${safeText(session.userAgent)}</div>` : ''}
      </div>
      <button class="secondary" data-action="revokeBrowserSession" data-session-id="${safeAttr(session.id)}" type="button" ${session.active ? '' : 'disabled'}>Revoke</button>
    </div>
  `).join('');
  const desktopBootstrap = shell.lastDesktopBootstrap || null;
  const desktopBootstrapMarkup = desktopBootstrap ? `
    <div class="pair-step">
      <strong>Generated orchestrator config</strong>
      <div class="tiny muted">Scoped orchestrator lease (expires ${safeText(formatRelative(desktopBootstrap.lease?.expiresAt))}). Paste into your desktop app and restart it. This grants Orca's orchestrator tools — never the API token.</div>
      <div class="lane-row">
        <button class="secondary" data-action="copyDesktopConfig" data-client="claudeDesktop" type="button">Copy Claude Desktop JSON</button>
        <button class="secondary" data-action="copyDesktopConfig" data-client="codex" type="button">Copy Codex TOML</button>
      </div>
      <div class="tiny muted">Claude Desktop: ${safeText(desktopBootstrap.bootstrap?.clients?.claudeDesktop?.configPath || '')} · Codex: ${safeText(desktopBootstrap.bootstrap?.clients?.codex?.configPath || '')}</div>
    </div>
  ` : '<div class="tiny muted">Generates a scoped orchestrator MCP config you paste into Codex app or Claude Desktop. Those apps then drive Orca as the orchestrator with full tooling. You can still use Orca\'s own chats for full control.</div>';
  const primaryProjects = shell.projects.filter((project) => !isVerificationProject(project));
  const projectRows = primaryProjects.map((project) => `
    <a class="simple-row" href="${safeAttr(project.route)}">
      <span class="row-icon">▱</span>
      <span>${safeText(project.name)}</span>
    </a>
  `).join('');
  const showMainHome = panel === 'overview' || panel === 'projects';

  const captureStatus = shell.captureStatus || null;
  const captureReady = Boolean(captureStatus?.videoReady);
  const captureScreens = Boolean(captureStatus?.screenshotsReady);
  const captureSummary = !captureStatus
    ? 'Status unavailable'
    : captureReady ? 'Ready (screenshots + video)' : captureScreens ? 'Screenshots only' : 'Not set up';
  const captureBackends = captureStatus
    ? (Object.entries(captureStatus.backends || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none')
    : 'unknown';
  const captureDetail = captureStatus
    ? `Active backends: ${captureBackends}.${captureStatus.systemChrome?.present ? ' System Chrome detected, so no large download is needed.' : ''}${captureReady ? ' Screenshot, video, and trace capture are available.' : ' Enable capture to take screenshots and video of project URLs.'}`
    : 'Capture status is unavailable.';

  refs.content.innerHTML = `
    <section class="simple-section ${showMainHome ? '' : 'is-hidden'}">
      <article class="card onboarding-card">
        <div>
          <div class="card-kicker">Phone and laptop setup</div>
          <h3>Open Orca from another device</h3>
          <p class="muted">Use a device on the same tailnet, open this private URL, then enter a one-time pairing code from this workstation. API tokens stay on trusted admin browsers.</p>
          <code class="copy-url">${safeText(phoneUrl)}</code>
          <div class="lane-row">
            <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy link</button>
            <button class="secondary" data-action="createPairingCode" type="button">Create pairing code</button>
            <a class="secondary" href="#setup">Setup wizard</a>
            <a class="secondary" href="#private-access">Tailscale setup</a>
          </div>
          <div class="tiny muted">Access preference: ${safeText(accessModeSummary)}</div>
          <details class="disclosure compact-disclosure">
            <summary><span>Add to Home Screen</span><small>iPhone/iPad</small></summary>
            <div class="disclosure-body tiny muted">Open the private URL in Safari, tap Share, then tap Add to Home Screen. HTTPS Serve gives the best PWA behavior; HTTP over Tailscale is private but may show browser warnings.</div>
          </details>
        </div>
        <div class="qr-wrap">${phoneQr}<span>Scan from phone</span></div>
      </article>
      <h3>Projects</h3>
      <a class="simple-row" href="#setup">
        <span class="row-icon">◎</span>
        <span>Phone setup wizard</span>
      </a>
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
      <article class="card control-card pair-panel" id="section-pair" data-panel-card="pair">
        <div class="card-kicker">Pair a device</div>
        <h3>Pair with remote device</h3>
        <p class="muted">Open Orca on a laptop or phone, then connect it to this workstation. Scan the QR code or open the private URL on the other device, then enter a one-time pairing code. The code grants workflow access without ever exposing the API token.</p>
        <div class="onboarding-card">
          <div>
            <strong>1. Open this URL on the other device</strong>
            <code class="copy-url">${safeText(phoneUrl)}</code>
            <div class="lane-row">
              <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy link</button>
              <a class="secondary" href="#private-access">Tailscale setup</a>
            </div>
            <div class="tiny muted">Access preference: ${safeText(accessModeSummary)}. On the same tailnet use the private URL; on the same LAN the local URL works without Tailscale.</div>
          </div>
          <div class="qr-wrap">${phoneQr}<span>Scan from phone or laptop</span></div>
        </div>
        <div class="pair-step">
          <strong>2. Create a one-time pairing code</strong>
          <div class="lane-row">
            <button data-action="createPairingCode" type="button">Create pairing code</button>
          </div>
          ${shell.lastPairing ? `
            <div class="pairing-code-box">
              <div class="tiny muted">One-time pairing code. Do not screenshot or paste into URLs.</div>
              <strong>${safeText(shell.lastPairing.code)}</strong>
              <span>Expires ${safeText(formatRelative(shell.lastPairing.expiresAt))}</span>
            </div>
          ` : '<div class="tiny muted">Create a code here, then type it into the access screen on the other device. Codes are single-use and expire quickly.</div>'}
        </div>
        <div class="pair-step">
          <strong>3. Enter the code on the other device</strong>
          <div class="tiny muted">On the laptop/phone access screen, paste the code to pair that browser. Paired devices get workflow access; API tokens stay on trusted admin browsers only.</div>
        </div>
        <details class="disclosure compact-disclosure">
          <summary><span>Paired devices</span><small>${safeText((shell.authSessions || []).length)} session${(shell.authSessions || []).length === 1 ? '' : 's'}</small></summary>
          <div class="disclosure-body">${authSessionRows || '<div class="muted">No paired browser sessions yet.</div>'}</div>
        </details>
        <div class="lane-row">
          <a class="secondary" href="#setup">Full setup wizard</a>
          <a class="secondary" href="#system">Access &amp; token settings</a>
        </div>
      </article>
      <article class="card control-card desktop-control-card" id="section-desktop-control" data-panel-card="desktop-control">
        <div class="card-kicker">Desktop app control</div>
        <h3>Drive Orca from Codex app or Claude Desktop</h3>
        <p class="muted">Two complementary ways to control this dashboard from a desktop AI app:</p>
        <div class="pair-step">
          <strong>A. In-app browser (visual)</strong>
          <div class="tiny muted">Open this dashboard URL in the desktop app's built-in browser to use Orca's UI and chats directly.</div>
          <code class="copy-url">${safeText(phoneUrl)}</code>
          <div class="lane-row">
            <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy dashboard URL</button>
          </div>
        </div>
        <div class="pair-step">
          <strong>B. MCP tooling (programmatic)</strong>
          <div class="tiny muted">Generate a scoped orchestrator MCP config. The desktop agent then acts as the Orca orchestrator with full tooling (spawn/stop lanes, tasks, approvals, mode/permission/goal/plan, evidence, audit).</div>
          <div class="lane-row">
            <button data-action="connectDesktopApp" type="button">Generate desktop-app config</button>
          </div>
          ${desktopBootstrapMarkup}
        </div>
      </article>
      <article class="card control-card setup-wizard" id="section-setup" data-panel-card="setup">
        <div class="card-kicker">First-run wizard</div>
        <h3>Connect phone or PWA</h3>
        <p class="muted">The secure flow is tailnet access first, then Orca pairing. Tailnet membership alone is not enough to control the dashboard.</p>
        <div class="setup-steps">
          <div class="setup-step ${tailnet.binaryAvailable ? 'ok' : 'warn'}">
            <span>1</span>
            <div><strong>Tailscale installed</strong><small>${tailnet.binaryAvailable ? 'Detected on this workstation.' : 'Install and sign in to Tailscale on this workstation.'}</small></div>
          </div>
          <div class="setup-step ${tailnet.loggedIn ? 'ok' : 'warn'}">
            <span>2</span>
            <div><strong>Tailnet session</strong><small>${tailnet.loggedIn ? 'This workstation is signed in.' : 'Sign in, then refresh Orca.'}</small></div>
          </div>
          <div class="setup-step ${phoneUrl.startsWith('http') ? 'ok' : 'warn'}">
            <span>3</span>
            <div><strong>Private URL</strong><small>${safeText(phoneUrl)}</small></div>
          </div>
          <div class="setup-step ${browserPaired || tokenConfigured ? 'ok' : 'warn'}">
            <span>4</span>
            <div><strong>Browser access</strong><small>${browserPaired ? 'This browser is paired.' : tokenConfigured ? 'API token is set in this tab.' : 'Pair remote devices with one-time codes; keep API token fallback on trusted browsers.'}</small></div>
          </div>
        </div>
        <div class="onboarding-card mini">
          <div>
            <strong>Scan or open this from your phone or laptop</strong>
            <code class="copy-url">${safeText(phoneUrl)}</code>
            <div class="lane-row">
              <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy link</button>
              <button class="secondary" data-action="createPairingCode" type="button">Create one-time code</button>
            </div>
            ${shell.lastPairing ? `
              <div class="pairing-code-box">
                <div class="tiny muted">One-time pairing code. Do not screenshot or paste into URLs.</div>
                <strong>${safeText(shell.lastPairing.code)}</strong>
                <span>Expires ${safeText(formatRelative(shell.lastPairing.expiresAt))}</span>
              </div>
            ` : '<div class="tiny muted">Create a pairing code from the trusted workstation browser, then enter it on the phone access screen.</div>'}
          </div>
          <div class="qr-wrap">${phoneQr}<span>Scan from trusted device</span></div>
        </div>
        <details class="disclosure compact-disclosure" open>
          <summary><span>HTTP vs HTTPS Serve</span><small>${safeText(accessModeSummary)}</small></summary>
          <div class="disclosure-body">
            <p>HTTP over Tailscale is private inside the encrypted tailnet and avoids certificate transparency metadata. HTTPS Serve improves Safari/PWA behavior and secure-cookie semantics, but can publish the machine/tailnet DNS name in public certificate logs. Funnel remains off-limits for v1.</p>
            <form id="setup-private-access-settings-form">
              <label>Default access mode
                <select name="preferredMode">
                  ${accessModeOptions}
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
              <button type="submit">Save access settings</button>
            </form>
            <div class="lane-row">
              <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve --bg http://127.0.0.1:3000" type="button">Copy HTTP Serve</button>
              <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve --bg --https=443 http://127.0.0.1:3000" type="button">Copy HTTPS Serve</button>
              <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve reset" type="button">Copy disable Serve</button>
            </div>
          </div>
        </details>
        <details class="disclosure compact-disclosure" open>
          <summary><span>Paired devices</span><small>${safeText((shell.authSessions || []).length)} session${(shell.authSessions || []).length === 1 ? '' : 's'}</small></summary>
          <div class="disclosure-body">${authSessionRows || '<div class="muted">No paired browser sessions yet.</div>'}</div>
        </details>
        <details class="disclosure compact-disclosure" open>
          <summary><span>Add to Home Screen</span><small>PWA</small></summary>
          <div class="disclosure-body">
            <ol class="setup-list">
              <li>Open the private URL in Safari on iPhone or Chrome on Android.</li>
              <li>Pair the browser once with a one-time code from this workstation.</li>
              <li>iPhone: tap Share, then Add to Home Screen. Android: tap browser menu, then Install app or Add to Home screen.</li>
              <li>Later opens reuse the paired browser session until it expires or is revoked.</li>
            </ol>
          </div>
        </details>
      </article>
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
        <details class="disclosure compact-disclosure" open>
          <summary><span>Paired devices</span><small>${safeText((shell.authSessions || []).length)} session${(shell.authSessions || []).length === 1 ? '' : 's'}</small></summary>
          <div class="disclosure-body">${authSessionRows || '<div class="muted">No paired browser sessions yet.</div>'}</div>
        </details>
        <details class="disclosure compact-disclosure">
          <summary><span>Packaged app credential storage</span><small>Tauri scope</small></summary>
          <div class="disclosure-body tiny muted">In the future desktop app, the server API token should be generated on first run and stored in the OS credential store by the app shell. Browser/PWA users should use pairing; API tokens are for automation and emergency manual setup.</div>
        </details>
        <details class="disclosure">
          <summary><span>Pair this browser</span><small>one-time code</small></summary>
          <div class="disclosure-body">
            <label>Pairing code
              <input id="pairing-code-input" placeholder="ABCD-1234-EF56" autocomplete="one-time-code" />
            </label>
            <label>Device label
              <input id="pairing-label-input" placeholder="My phone" />
            </label>
            <button class="secondary" data-action="pairBrowserSession" type="button">Pair browser</button>
          </div>
        </details>
      </article>
      <article class="card control-card" id="section-settings-access" data-panel-card="system">
        <details class="disclosure" open>
          <summary>
            <span>Access and paired devices</span>
            <small>${safeText(accessModeSummary)}</small>
          </summary>
          <div class="disclosure-body">
            <p class="muted">Settings is the trusted workstation surface for HTTP/HTTPS preference, one-time pairing, browser session revocation, and token rotation. Unpaired phone and laptop browsers only see the pairing screen.</p>
            <form id="settings-private-access-settings-form">
              <label>Default access mode
                <select name="preferredMode">
                  ${accessModeOptions}
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
              <button type="submit">Save access settings</button>
            </form>
            <div class="onboarding-card mini">
              <div>
                <strong>Pair a phone or laptop</strong>
                <div class="tiny muted">Create a fresh code only from this authenticated workstation, then enter it on the unpaired device. Codes are one-time use and expire quickly.</div>
                <div class="lane-row">
                  <button class="secondary" data-action="createPairingCode" type="button">Create one-time code</button>
                  <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy private URL</button>
                </div>
                ${shell.lastPairing ? `
                  <div class="pairing-code-box">
                    <div class="tiny muted">One-time pairing code. Do not screenshot or paste into URLs.</div>
                    <strong>${safeText(shell.lastPairing.code)}</strong>
                    <span>Expires ${safeText(formatRelative(shell.lastPairing.expiresAt))}</span>
                  </div>
                ` : ''}
              </div>
              <div class="qr-wrap">${phoneQr}<span>Trusted setup QR</span></div>
            </div>
            <details class="disclosure compact-disclosure" open>
              <summary><span>Paired devices</span><small>${safeText((shell.authSessions || []).length)} active</small></summary>
              <div class="disclosure-body">
                <p class="tiny muted">Rotate session state by revoking old devices, clearing this browser token if needed, then creating a new one-time pairing code.</p>
                ${authSessionRows || '<div class="muted">No paired browser sessions yet.</div>'}
              </div>
            </details>
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
            <span>Evidence capture backend</span>
            <small>${safeText(captureSummary)}</small>
          </summary>
          <div class="disclosure-body">
            <div class="tiny muted">${safeText(captureDetail)}</div>
            <div class="lane-row">
              <button class="secondary" data-action="setupCapture" type="button">${captureReady ? 'Reconfigure capture' : 'Enable screenshots &amp; video'}</button>
            </div>
            <div class="tiny muted">Setup is governed: it runs a dry-run first, then installs only after you confirm. The desktop app can also capture screenshots natively (no download) on macOS.</div>
          </div>
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
            <small>${safeText(accessModeSummary)} · ${safeText(tailnet.setupStatus || 'setup_pending')}</small>
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
                  ${accessModeOptions}
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
            <details class="disclosure compact-disclosure" open>
              <summary>
                <span>Phone URL and HTTPS wizard</span>
                <small>Serve, not Funnel</small>
              </summary>
              <div class="disclosure-body">
                <div class="access-command">
                  <div>
                    <strong>Current phone URL</strong>
                    <div class="tiny muted">Use this from a device on the same tailnet.</div>
                    <code>${safeText(phoneUrl)}</code>
                  </div>
                  <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy</button>
                </div>
                <div class="card">
                  <h3>HTTPS Serve decision</h3>
                  <p>HTTPS Serve improves Safari/PWA behavior and secure-cookie semantics. It can publish the machine/tailnet DNS name in certificate transparency logs. Rotate or rename the host first if hostname privacy matters.</p>
                  <div class="lane-row">
                    <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve --bg --https=443 http://127.0.0.1:3000" type="button">Copy HTTPS Serve command</button>
                    <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve reset" type="button">Copy disable command</button>
                  </div>
                </div>
                <div class="card">
                  <h3>Rotate or rename hostname</h3>
                  <p>Rename the device in Tailscale admin before enabling HTTPS certs if you do not want the current Mac name in certificate metadata. Tailnet DNS suffix rotation is an admin-level Tailscale setting and may break existing links.</p>
                  <div class="tiny muted">Orca does not run these changes automatically. Make the change in Tailscale, then update the private access target URL here.</div>
                </div>
              </div>
            </details>
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
                <b>${safeText(effectiveSummary.privateAccess?.preferredMode || 'auto')}</b>
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
                <textarea id="app-import-json" rows="8" placeholder='{"schemaVersion":1,"kind":"orca.app-export"}'></textarea>
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
      renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not mark notification read.'), 'bad');
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
      renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not mark notifications read.'), 'bad');
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

function renderAccessGate() {
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

function isLiveLaneState(state) {
  return ['queued', 'starting', 'running'].includes(String(state || '').toLowerCase());
}

function isRestartableLaneState(state) {
  return ['failed', 'stopped', 'fix_requested'].includes(String(state || '').toLowerCase());
}

function activeOrchestratorLaneForSession(session) {
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

function agentEventTone(type) {
  const normalized = String(type || '').toLowerCase();
  if (normalized.includes('failed') || normalized === 'error') return 'bad';
  if (normalized.includes('done') || normalized.includes('completed')) return 'ok';
  if (normalized.includes('stopped') || normalized.includes('queued') || normalized.includes('started')) return 'warn';
  return '';
}

function agentEventLabel(type) {
  const map = {
    'agent.queued': 'Queued',
    'agent.started': 'Started',
    'agent.done': 'Done',
    'agent.failed': 'Failed',
    'agent.stopped': 'Stopped',
    'agent.needs_critique': 'Needs check',
    'message.user': 'User',
    'message.assistant.delta': 'Assistant',
    'message.assistant.final': 'Final',
    'tool.started': 'Tool',
    'tool.completed': 'Tool done',
    'command.started': 'Command',
    'command.output': 'Output',
    'file.changed': 'Files',
    error: 'Error',
  };
  return map[type] || String(type || 'Event').replaceAll('.', ' ');
}

function renderAgentEventTimeline(lane, { limit = 80, compact = false } = {}) {
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

function modelPresetOptions(selected = '') {
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

function intelligenceOptions(selected = 'high') {
  const normalized = String(selected || 'high').trim().toLowerCase();
  return [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
    ['max', 'Max'],
  ].map(([value, label]) => `<option value="${safeAttr(value)}"${normalized === value ? ' selected' : ''}>${safeText(label)}</option>`).join('');
}

function runModeOptions(selected = 'plan') {
  const normalized = String(selected || 'plan').trim();
  return [
    ['plan', 'Plan'],
    ['read-only', 'Read only'],
    ['auto-edit', 'Auto edit'],
    ['acceptEdits', 'Accept edits'],
    ['bypassPermissions', 'Bypass permissions'],
  ].map(([value, label]) => `<option value="${safeAttr(value)}"${normalized === value ? ' selected' : ''}>${safeText(label)}</option>`).join('');
}

function modelControlOptions(selected = '') {
  return modelPresetOptions(selected || '');
}

function executorCapabilitiesFor(type) {
  const info = shell.executorCliInfo || {};
  return info[String(type || '').trim()]?.capabilities || null;
}

function capabilityList(value, fallback = 'none') {
  const list = Array.isArray(value) ? value.filter(Boolean) : [];
  return list.length ? list.join(', ') : fallback;
}

function renderExecutorCapabilities(capabilities, { compact = false } = {}) {
  if (!capabilities) return '<div class="tiny muted">Capabilities: not detected yet.</div>';
  const controls = capabilities.controls || {};
  const invocation = capabilities.invocation || {};
  const details = [
    `roles ${capabilityList(capabilities.roles)}`,
    `model ${controls.model?.supported ? 'yes' : 'no'}`,
    `modes ${capabilityList(controls.permissions?.values)}`,
    `intelligence ${controls.intelligence?.supported ? capabilityList(controls.intelligence?.values) : 'metadata only'}`,
    `MCP ${controls.mcpConfig?.supported ? 'native' : capabilityList(capabilities.mcpScopes)}`,
    `events ${invocation.structuredAgentEvents ? 'structured' : (invocation.rawTerminalArtifacts ? 'raw logs' : 'provider response')}`,
    controls.backgroundAgents?.supported ? 'background agents yes' : 'background agents no',
  ];
  const version = capabilities.version ? ` · ${capabilities.version}` : '';
  const title = `${capabilities.displayName || capabilities.type || 'executor'}${version}`;
  if (compact) {
    return `<div class="tiny muted">Capabilities: ${safeText(details.join(' · '))}</div>`;
  }
  return `
    <details class="disclosure compact-disclosure">
      <summary>Capabilities: ${safeText(title)}</summary>
      <div class="tiny muted">${safeText(details.join(' · '))}</div>
      <div class="tiny muted">output: ${safeText(capabilityList(controls.structuredOutput?.formats))}</div>
      <div class="tiny muted">detected: ${safeText(capabilities.detection?.source || 'unknown')} ${capabilities.detection?.checkedAt ? `· ${safeText(formatMeta(capabilities.detection.checkedAt))}` : ''}</div>
    </details>
  `;
}

function renderOrchestratorTerminal(project, session, lane) {
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

function renderApprovalRows(lane) {
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

function renderSessionApprovals(session) {
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

function composerAttachmentsFor(sessionId) {
  shell.composerAttachments = shell.composerAttachments || {};
  if (!Array.isArray(shell.composerAttachments[sessionId])) shell.composerAttachments[sessionId] = [];
  return shell.composerAttachments[sessionId];
}

function renderComposerAttachmentChips(sessionId) {
  const list = composerAttachmentsFor(sessionId);
  if (!list.length) return '';
  return list.map((entry) => `
    <span class="attach-chip">${safeText(entry.name)}<button data-action="removeAttachment" data-session-id="${safeAttr(sessionId)}" data-attachment-id="${safeAttr(entry.id)}" type="button" aria-label="Remove ${safeAttr(entry.name)}">×</button></span>
  `).join('');
}

function refreshComposerAttachments(sessionId) {
  const el = document.getElementById(`composer-attachments-${sessionId}`);
  if (el) writeHtml(el, renderComposerAttachmentChips(sessionId));
}

function readFileAsBase64(file) {
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

async function uploadComposerFiles(sessionId, fileList) {
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

function renderOrchestratorConsole(session) {
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

function renderExecutorLanePanelItem(lane) {
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

function renderExecutorSidePanel(session) {
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

function renderSession(project, session) {
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

function renderLane(project, session, lane) {
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
        ${laneRoute ? `<a class="secondary" href="${safeHref(laneRoute)}">Open lane</a>` : ''}
        <div class="lane-row" style="margin-top:0.75rem">
          <button class="secondary" data-action="ackAuditEvent" data-event-id="${safeAttr(event.id)}" type="button">Mark reviewed</button>
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
  writeHtml(refs.statusStrip, [
    tokenTag,
    executorTags,
    schedTag,
    `<span class="tag" data-status="lanes">${running} running · ${failed} failed</span>`,
    `<span class="tag ${auditCount > 0 ? 'warn' : ''}" data-status="audit">${auditCount} pending audits</span>`,
    blockerCount ? `<span class="tag bad" data-status="blockers">${blockerCount} blockers</span>` : '',
  ].filter(Boolean).join(''));
}

function renderBlockers() {
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

function renderSidebarProjects(activeProject) {
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

function renderMobileManifest() {
  api('/api/mobile/manifest')
    .then(({ data }) => {
      if (!data) return;
      shell.mobileManifest = data;
    })
    .catch(() => {});
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  lastRefreshAt = Date.now();
  const requestId = ++refreshRequestId;
  const uiState = captureContentUiState();
  try {
    shell.route = parseRoute();
    shell.alerts = [];
    const abortFromAuth = (response) => abortRefreshFromUnauthorized(response, requestId, uiState);
    const authResp = await api('/api/auth/status');
    if (abortFromAuth(authResp)) return;
    if (authResp.ok && authResp.data) {
      shell.authStatus = authResp.data;
    }
    if (browserAccessBlocked()) {
      clearProtectedWorkspaceState();
      render(captureContentUiState());
      return;
    }
    const policyResp = await api('/api/policy');
    if (abortFromAuth(policyResp)) return;
    if (policyResp.ok && policyResp.data) {
      shell.policy = policyResp.data.policies;
    }
    const effectiveSettingsResp = await api('/api/settings/effective');
    if (abortFromAuth(effectiveSettingsResp)) return;
    if (effectiveSettingsResp.ok && effectiveSettingsResp.data) {
      shell.effectiveSettings = effectiveSettingsResp.data;
    }
    const notificationsResp = await api('/api/notifications');
    if (abortFromAuth(notificationsResp)) return;
    if (notificationsResp.ok && notificationsResp.data) {
      shell.notifications = notificationsResp.data;
      maybeShowBrowserNotifications();
    }
    const blockersResp = await api('/api/system/blockers');
    if (abortFromAuth(blockersResp)) return;
    if (blockersResp.ok && Array.isArray(blockersResp.data?.blockers)) {
      shell.systemBlockers = blockersResp.data.blockers;
    }
    const privateAccessResp = await api('/api/private-access');
    if (abortFromAuth(privateAccessResp)) return;
    if (privateAccessResp.ok && privateAccessResp.data) {
      shell.privateAccess = privateAccessResp.data;
    }
    const profilesResp = await api('/api/executors/profiles');
    if (abortFromAuth(profilesResp)) return;
    if (profilesResp.ok && profilesResp.data?.profiles) {
      shell.executorProfiles = profilesResp.data.profiles;
    }
    const captureStatusResp = await api('/api/capture/status');
    if (abortFromAuth(captureStatusResp)) return;
    if (captureStatusResp.ok && captureStatusResp.data) {
      shell.captureStatus = captureStatusResp.data;
    }
    const providerCatalogResp = await api('/api/providers');
    if (abortFromAuth(providerCatalogResp)) return;
    if (providerCatalogResp.ok && providerCatalogResp.data) {
      shell.providerCatalog = providerCatalogResp.data;
    }
    const authSessionsResp = await api('/api/auth/sessions');
    if (abortFromAuth(authSessionsResp)) return;
    if (authSessionsResp.ok && Array.isArray(authSessionsResp.data?.sessions)) {
      shell.authSessions = authSessionsResp.data.sessions;
    }

    if (shell.executorProfiles && typeof shell.executorProfiles === 'object') {
      const cliInfo = {};
      for (const executorType of Object.keys(shell.executorProfiles)) {
        const response = await api(`/api/executors/${encodeURIComponent(executorType)}/cli`);
        if (abortFromAuth(response)) return;
        if (response.ok && response.data) {
          cliInfo[executorType] = response.data;
        }
      }
      shell.executorCliInfo = cliInfo;
    }

    const cleanupScheduleResp = await api('/api/artifacts/cleanup/schedule');
    if (abortFromAuth(cleanupScheduleResp)) return;
    if (cleanupScheduleResp.ok && cleanupScheduleResp.data?.schedule) {
      shell.cleanupSchedule = cleanupScheduleResp.data.schedule;
    }
    const mcpToolsResp = await api('/api/mcp/tools');
    if (abortFromAuth(mcpToolsResp)) return;
    if (mcpToolsResp.ok && Array.isArray(mcpToolsResp.data)) {
      shell.mcpTools = mcpToolsResp.data;
    }

    const pendingAuditResp = await api('/api/audit/events?status=pending');
    if (abortFromAuth(pendingAuditResp)) return;
    if (requestId !== refreshRequestId) return;
    if (pendingAuditResp.ok && Array.isArray(pendingAuditResp.data)) {
      shell.pendingAuditEvents = pendingAuditResp.data;
    }

    const projectsResp = await api('/api/projects');
    if (abortFromAuth(projectsResp)) return;
    if (requestId !== refreshRequestId) return;
    if (projectsResp.ok && Array.isArray(projectsResp.data)) {
      const nextProjects = projectsResp.data;
      const allSessions = [];
      let sessionsComplete = true;
      for (const project of nextProjects) {
        const sessionsResp = await api(`/api/projects/${project.id}/sessions`);
        if (requestId !== refreshRequestId) return;
        if (abortFromAuth(sessionsResp)) return;
        if (sessionsResp.ok && Array.isArray(sessionsResp.data)) {
          allSessions.push(...sessionsResp.data);
        } else {
          sessionsComplete = false;
        }
      }

      let allLanes = shell.lanes;
      let lanesComplete = false;
      if (sessionsComplete) {
        const allLaneResponses = await Promise.all(allSessions.map((session) => api(`/api/sessions/${session.id}/lanes`)));
        if (requestId !== refreshRequestId) return;
        const unauthorizedLanes = allLaneResponses.find((response) => response.status === 401);
        if (abortFromAuth(unauthorizedLanes)) return;
        lanesComplete = allLaneResponses.every((response) => response.ok && Array.isArray(response.data));
        if (lanesComplete) {
          allLanes = allLaneResponses.flatMap((response) => response.data);
        }
      }

      shell.projects = nextProjects;
      if (sessionsComplete && lanesComplete) {
        shell.sessions = allSessions;
        shell.lanes = allLanes;
      }
    }
    if (requestId !== refreshRequestId) return;
    render(uiState);
  } finally {
    refreshInFlight = false;
  }
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
  target.innerHTML = files.map((file) => `<div><a href="${safeHref(file.url)}" target="_blank" rel="noopener noreferrer">${safeText(file.name)}</a></div>`).join('');
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
  const approval = buildApprovedActionBody('updateProject', `Save live link "${label}" for ${project?.name || 'project'}?`);
  if (!approval.approved) {
    renderAlert('Quick link addition canceled.');
    return;
  }

  const port = Number.parseInt(payload.quickLinkPort || '', 10);
  const response = await api(`/api/projects/${projectId}/quick-links`, {
    method: 'POST',
    body: {
      actor: approval.actor,
      approved: approval.approved,
      label,
      url,
      kind: payload.quickLinkKind || 'vite',
      favorite: Boolean(payload.quickLinkFavorite),
      ...(Number.isFinite(port) ? { port } : {}),
      ...(payload.quickLinkLocalUrl ? { localUrl: payload.quickLinkLocalUrl } : {}),
      ...(payload.quickLinkTailnetHttpUrl ? { tailnetHttpUrl: payload.quickLinkTailnetHttpUrl } : {}),
      ...(payload.quickLinkHttpsServeUrl ? { httpsServeUrl: payload.quickLinkHttpsServeUrl } : {}),
    },
  });
  if (response.ok) {
    renderAlert('Live link saved.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not save live link.', 'bad');
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

  if (FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(executorType)) {
    if (commandParts.length > 0 && !executorTargetsCommand(executorType, commandParts)) {
      renderAlert(`Command for ${executorType} must target an approved ${executorType} binary.`, 'bad');
      return;
    }
    if (!commandParts.length && payload.executorBinary && !executorTargetsBinary(executorType, payload.executorBinary)) {
      renderAlert(`Executor binary for ${executorType} must target an approved ${executorType} binary.`, 'bad');
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
      intelligenceProfile: payload.intelligenceProfile || null,
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

async function handleOrchestratorMessage(event) {
  event.preventDefault();
  const sessionId = event.currentTarget.dataset.sessionId;
  const payload = toObj(event.currentTarget);
  const message = String(payload.message || '').trim();
  const attachments = composerAttachmentsFor(sessionId).map((entry) => ({ name: entry.name, url: entry.url }));
  if (!message && !attachments.length) {
    renderAlert('Message or attachment is required.', 'bad');
    return;
  }
  const executorType = normalizeExecutorType(payload.executorType || 'codex');
  const model = String(payload.model || '').trim() || String(payload.modelPreset || '').trim() || null;
  const intelligenceProfile = String(payload.intelligenceProfile || '').trim() || 'high';
  const permissionsProfile = String(payload.permissionsProfile || '').trim() || 'plan';
  const approval = buildApprovedActionBody(
    'createLane',
    `Start ${executorType} orchestrator?\nMode: ${permissionsProfile}\nModel: ${model || 'default'}\nIntelligence: ${intelligenceProfile}`,
  );
  if (!approval.approved) {
    renderAlert('Orchestrator message canceled.');
    return;
  }
  const response = await api(`/api/sessions/${sessionId}/orchestrator/messages`, {
    method: 'POST',
    body: {
      message,
      executorType,
      model,
      permissionsProfile,
      intelligenceProfile,
      attachments,
      actor: approval.actor,
      approved: approval.approved,
    },
  });
  if (response.ok) {
    event.currentTarget.reset();
    composerAttachmentsFor(sessionId).length = 0; // clear attached files after send
    renderAlert('Orchestrator lane started.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not start orchestrator lane.', 'bad');
  }
}

async function handleLaneControlsUpdate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const laneId = form.dataset.laneId;
  const lane = shell.lanes.find((item) => item.id === laneId);
  if (!lane) {
    renderAlert('Lane not found.', 'bad');
    return;
  }
  const payload = toObj(form);
  const model = String(payload.model || '').trim();
  const intelligenceProfile = String(payload.intelligenceProfile || '').trim();
  const permissionsProfile = String(payload.permissionsProfile || '').trim();
  const approval = buildApprovedActionBody(
    'updateLaneControls',
    `Update controls for ${lane.title}?\nMode: ${permissionsProfile || 'default'}\nModel: ${model || 'default'}\nIntelligence: ${intelligenceProfile || 'default'}`,
  );
  if (!approval.approved) {
    renderAlert('Lane control update canceled.');
    return;
  }
  const response = await api(`/api/lanes/${laneId}/controls`, {
    method: 'PATCH',
    body: {
      actor: approval.actor,
      approved: approval.approved,
      model,
      permissionsProfile,
      intelligenceProfile,
    },
  });
  if (response.ok) {
    renderAlert(isLiveLaneState(lane.state) ? 'Lane controls saved. Restart to apply to the running process.' : 'Lane controls saved.');
    await refresh();
  } else if (response.data?.requiresApproval) {
    renderAlert('Approval required for lane controls.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Could not update lane controls.', 'bad');
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
    const presetId = event.currentTarget.dataset.presetId;
    const label = event.currentTarget.dataset.presetLabel || 'saved preview';
    if (!presetId) return;
    const approved = confirmHighRiskAction(`Capture screenshot for ${label}?`, 'captureEvidence');
    const response = await api(`/api/lanes/${laneId}/evidence`, {
      method: 'POST',
      body: { approved, actor: 'dashboard', presetId, modes: ['screenshot'] },
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
  if (action === 'restartLane') {
    const lane = shell.lanes.find((item) => item.id === laneId);
    const approved = confirmHighRiskAction('Restart this agent process?', 'retryLane');
    if (!approved) {
      renderAlert('Lane restart canceled.');
      return;
    }
    if (lane && isLiveLaneState(lane.state)) {
      const stopped = await api(`/api/lanes/${laneId}/stop`, {
        method: 'POST',
        body: { approved, actor: 'dashboard' },
      });
      if (!stopped.ok) {
        renderAlert(stopped.data?.error || 'Could not stop lane before restart.', 'bad');
        return;
      }
    }
    const restarted = await api(`/api/lanes/${laneId}/retry`, {
      method: 'POST',
      body: { approved, actor: 'dashboard' },
    });
    if (restarted.ok) {
      renderAlert('Lane restarted.');
      await refresh();
    } else if (restarted.data?.requiresApproval) {
      renderAlert('Approval required. Retry with approval enabled.', 'bad');
    } else {
      renderAlert(restarted.data?.error || 'Could not restart lane.', 'bad');
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
    const modes = [];
    if (window.confirm('Capture screenshot?')) modes.push('screenshot');
    if (window.confirm('Capture trace (more expensive)?')) modes.push('trace');
    if (window.confirm('Capture video (heavier)?')) modes.push('video');
    const response = await api(endpoint.url, {
      method: endpoint.method,
      body: {
        approved,
        actor: 'dashboard',
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
  if (action === 'copyPhoneUrl') {
    const url = event.currentTarget.dataset.url || window.location.origin;
    try {
      await navigator.clipboard.writeText(url);
      renderAlert('Phone link copied.');
    } catch {
      renderAlert(url);
    }
    return;
  }
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
      shell.lastPairing = response.data?.pairing || null;
      renderAlert(`Pairing code: ${response.data?.pairing?.code || 'created'}`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not create pairing code.', 'bad');
    }
    return;
  }
  if (action === 'connectDesktopApp') {
    const response = await api('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      body: { actor: 'desktop-app' },
    });
    if (response.ok) {
      shell.lastDesktopBootstrap = response.data || null;
      renderAlert('Desktop-app orchestrator config generated. Copy it into Codex or Claude Desktop.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not generate desktop-app config.', 'bad');
    }
    return;
  }
  if (action === 'copyDesktopConfig') {
    const client = event.currentTarget.dataset.client || 'claudeDesktop';
    const snippet = shell.lastDesktopBootstrap?.bootstrap?.clients?.[client]?.snippet || '';
    try {
      await navigator.clipboard.writeText(snippet);
      renderAlert(`${client === 'codex' ? 'Codex' : 'Claude Desktop'} config copied.`);
    } catch {
      renderAlert(snippet || 'Nothing to copy.');
    }
    return;
  }
  if (action === 'pickAttachment') {
    const input = document.getElementById('composer-file-input');
    if (input) input.click();
    return;
  }
  if (action === 'removeAttachment') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const attachmentId = event.currentTarget.dataset.attachmentId;
    shell.composerAttachments = shell.composerAttachments || {};
    if (Array.isArray(shell.composerAttachments[sessionId])) {
      shell.composerAttachments[sessionId] = shell.composerAttachments[sessionId].filter((a) => a.id !== attachmentId);
      refreshComposerAttachments(sessionId);
    }
    return;
  }
  if (action === 'saveSessionPlan') {
    const form = document.getElementById('session-plan-form');
    const sessionId = form?.dataset.sessionId;
    const goal = form?.querySelector('[name="goal"]')?.value || '';
    const plan = form?.querySelector('[name="plan"]')?.value || '';
    const response = await api(`/api/sessions/${sessionId}/plan`, {
      method: 'POST',
      body: { actor: 'dashboard', goal, plan },
    });
    if (response.ok) {
      renderAlert('Goal & plan saved.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not save plan.', 'bad');
    }
    return;
  }
  if (action === 'approveApproval' || action === 'denyApproval') {
    const laneId = event.currentTarget.dataset.laneId;
    const approvalId = event.currentTarget.dataset.approvalId;
    const decision = action === 'approveApproval' ? 'approve' : 'deny';
    const response = await api(`/api/lanes/${laneId}/approvals/${approvalId}/decide`, {
      method: 'POST',
      body: { actor: 'dashboard', decision },
    });
    if (response.ok) {
      renderAlert(`Approval ${decision === 'approve' ? 'approved' : 'denied'}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not record decision.', 'bad');
    }
    return;
  }
  if (action === 'setupCapture') {
    // Dry-run first to preview the governed plan, then confirm to execute.
    const dry = await api('/api/capture/install', {
      method: 'POST',
      body: { actor: 'dashboard', approved: true, confirmed: false },
    });
    if (!dry.ok) {
      renderAlert(dry.data?.error || 'Could not plan capture setup.', 'bad');
      return;
    }
    const plan = dry.data?.plan;
    const desc = plan ? `${plan.backend} — ${plan.estimatedDownload}` : 'capture backend';
    if (!window.confirm(`Set up evidence capture: ${desc}.\n\nThis installs a browser backend on this machine. Proceed?`)) {
      return;
    }
    renderAlert('Setting up capture backend… this can take a minute.');
    const run = await api('/api/capture/install', {
      method: 'POST',
      body: { actor: 'dashboard', approved: true, confirmed: true },
    });
    if (run.ok && run.data?.ok) {
      renderAlert('Capture backend is ready.');
      await refresh();
    } else {
      renderAlert(run.data?.error || run.data?.result?.failedStep || 'Capture setup failed.', 'bad');
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
  if (action === 'revokeBrowserSession') {
    const sessionId = event.currentTarget.dataset.sessionId;
    if (!sessionId) return;
    const confirmed = window.confirm('Revoke this paired browser session?');
    if (!confirmed) {
      renderAlert('Session revoke canceled.');
      return;
    }
    const response = await api('/api/auth/logout', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        sessionId,
      },
    });
    if (response.ok) {
      renderAlert('Paired browser session revoked.');
      await refresh();
    } else {
      renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not revoke paired browser session.'), 'bad');
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
    const linkId = event.currentTarget.dataset.linkId;
    if (!projectId || !linkId) return;
    const confirmed = window.confirm('Remove this live link from the project?');
    if (!confirmed) {
      renderAlert('Live link removal canceled.');
      return;
    }
    const approval = buildApprovedActionBody('updateProject');
    if (!approval.approved) {
      renderAlert('Live link removal canceled.');
      return;
    }

    const response = await api(`/api/projects/${projectId}/quick-links/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
      body: {
        actor: approval.actor,
        approved: approval.approved,
      },
    });
    if (response.ok) {
      renderAlert('Live link removed.');
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required to remove this live link.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not remove live link.', 'bad');
    }
  }

  if (action === 'checkProjectQuickLink') {
    const projectId = event.currentTarget.dataset.projectId;
    const linkId = event.currentTarget.dataset.linkId;
    if (!projectId || !linkId) return;
    const response = await api(`/api/projects/${projectId}/quick-links/${encodeURIComponent(linkId)}/check`, {
      method: 'POST',
      body: {
        actor: 'dashboard',
        prefer: 'auto',
      },
    });
    if (response.ok) {
      renderAlert(`Live link check: ${quickLinkHealthLabel(response.data?.result?.status)}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not check live link.', 'bad');
    }
  }

  if (action === 'archiveProject') {
    const projectId = event.currentTarget.dataset.projectId;
    const projectName = event.currentTarget.dataset.projectName || 'this project';
    if (!projectId) return;
    const confirmed = window.confirm(`Archive ${projectName}? It will disappear from the default project list, but its saved state is retained.`);
    if (!confirmed) {
      renderAlert('Project archive canceled.');
      return;
    }
    const approval = buildApprovedActionBody('updateProject', `Archive ${projectName}?`);
    if (!approval.approved) {
      renderAlert('Project archive canceled.');
      return;
    }
    const response = await api(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        state: 'archived',
      },
    });
    if (response.ok) {
      renderAlert('Project archived.');
      window.location.href = '/#projects';
      return;
    }
    renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not archive project.'), 'bad');
  }

  if (action === 'renameProject') {
    const projectId = event.currentTarget.dataset.projectId;
    const projectName = event.currentTarget.dataset.projectName || 'project';
    const project = shell.projects.find((value) => value.id === projectId);
    if (!project) {
      renderAlert('Project not found.');
      return;
    }
    const nextName = window.prompt(`Rename ${projectName}`, project.name || '');
    if (nextName === null) {
      renderAlert('Project rename canceled.');
      return;
    }
    const name = String(nextName || '').trim();
    if (!name || name === project.name) {
      renderAlert('Project rename canceled.');
      return;
    }
    const approval = buildApprovedActionBody('updateProject', `Rename project ${project.name} to ${name}?`);
    if (!approval.approved) {
      renderAlert('Project rename canceled.');
      return;
    }
    const response = await api(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        name,
      },
    });
    if (response.ok) {
      renderAlert('Project renamed.');
      await refresh();
      return;
    }
    renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not rename project.'), 'bad');
  }

  if (action === 'archiveSession') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const sessionName = event.currentTarget.dataset.sessionName || 'this session';
    if (!sessionId) return;
    const confirmed = window.confirm(`Archive ${sessionName}? It will disappear from the default session list, but its saved state is retained.`);
    if (!confirmed) {
      renderAlert('Session archive canceled.');
      return;
    }
    const approval = buildApprovedActionBody('updateSession', `Archive ${sessionName}?`);
    if (!approval.approved) {
      renderAlert('Session archive canceled.');
      return;
    }
    const response = await api(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        state: 'archived',
      },
    });
    if (response.ok) {
      renderAlert('Session archived.');
      const currentSession = shell.sessions.find((value) => value.id === sessionId);
      const project = currentSession ? shell.projects.find((value) => value.id === currentSession.projectId) : null;
      if (project?.route) {
        window.location.href = project.route;
      } else {
        window.location.href = '/#projects';
      }
      return;
    }
    renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not archive session.'), 'bad');
  }

  if (action === 'renameSession') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const sessionName = event.currentTarget.dataset.sessionName || 'this session';
    const session = shell.sessions.find((value) => value.id === sessionId);
    if (!session) {
      renderAlert('Session not found.');
      return;
    }
    const nextName = window.prompt(`Rename ${sessionName}`, session.name || '');
    if (nextName === null) {
      renderAlert('Session rename canceled.');
      return;
    }
    const name = String(nextName || '').trim();
    if (!name || name === session.name) {
      renderAlert('Session rename canceled.');
      return;
    }
    const approval = buildApprovedActionBody('updateSession', `Rename session ${session.name} to ${name}?`);
    if (!approval.approved) {
      renderAlert('Session rename canceled.');
      return;
    }
    const response = await api(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        name,
      },
    });
    if (response.ok) {
      renderAlert('Session renamed.');
      await refresh();
      return;
    }
    renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not rename session.'), 'bad');
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

function delegatedSubmitEvent(event) {
  return {
    currentTarget: event.target,
    target: event.target,
    preventDefault: () => event.preventDefault(),
  };
}

document.addEventListener('submit', async (event) => {
  const formEvent = delegatedSubmitEvent(event);
  if (event.target.id === 'create-project-form') {
    await handleCreateProject(formEvent);
    return;
  }
  if (event.target.id === 'update-project-links-form') {
    await handleAddProjectQuickLink(formEvent);
    return;
  }
  if (event.target.id === 'create-session-form') {
    await handleCreateSession(formEvent);
    return;
  }
  if (event.target.id === 'create-lane-form') {
    await handleCreateLane(formEvent);
    return;
  }
  if (event.target.id === 'orchestrator-message-form') {
    await handleOrchestratorMessage(formEvent);
    return;
  }
  if (event.target.classList.contains('lane-controls-form')) {
    await handleLaneControlsUpdate(formEvent);
    return;
  }
  if (event.target.id === 'create-mcp-tool-form') {
    await handleCreateMcpTool(formEvent);
    return;
  }
  if (event.target.id === 'cleanup-schedule-form') {
    await handleCleanupSchedule(formEvent);
    return;
  }
  if (
    event.target.id === 'private-access-settings-form' ||
    event.target.id === 'setup-private-access-settings-form' ||
    event.target.id === 'settings-private-access-settings-form'
  ) {
    await handlePrivateAccessSettings(formEvent);
    return;
  }
  if (event.target.id === 'notification-settings-form') {
    await handleNotificationSettings(formEvent);
    return;
  }
  if (event.target.id === 'private-access-target-form') {
    await handleCreatePrivateAccessTarget(formEvent);
    return;
  }
});

document.addEventListener('change', (event) => {
  if (event.target && event.target.name === 'executorType' && event.target.form && event.target.form.id === 'create-lane-form') {
    renderLaneExecutorGuidance(event.target.form);
  }
  if (event.target && event.target.id === 'composer-file-input') {
    const sessionId = event.target.dataset.sessionId;
    if (sessionId) uploadComposerFiles(sessionId, event.target.files);
    event.target.value = '';
  }
});

// Drag-drop and paste files/screenshots onto the orchestrator composer.
document.addEventListener('dragover', (event) => {
  if (event.target?.closest?.('.composer-shell')) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  const form = event.target?.closest?.('.composer-shell');
  if (form && event.dataTransfer?.files?.length) {
    event.preventDefault();
    uploadComposerFiles(form.dataset.sessionId, event.dataTransfer.files);
  }
});
document.addEventListener('paste', (event) => {
  const form = event.target?.closest?.('.composer-shell');
  if (!form) return;
  const files = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length) {
    event.preventDefault();
    uploadComposerFiles(form.dataset.sessionId, files);
  }
});

document.addEventListener('click', (event) => {
  const label = event.target?.closest?.('label');
  const checkbox = label?.querySelector?.('input[type="checkbox"]');
  if (checkbox && event.target !== checkbox) {
    event.preventDefault();
  }
}, true);

let sidebarLongPressTimer = null;
let sidebarLongPressOpened = false;
let sidebarLongPressIgnoreUntil = 0;
let sidebarSwipeState = null;

function clearSidebarSwipeState() {
  if (sidebarLongPressTimer) {
    clearTimeout(sidebarLongPressTimer);
    sidebarLongPressTimer = null;
  }
  sidebarSwipeState = null;
}

function closeSidebarActionMenus() {
  document.querySelectorAll('.sidebar-project-group.actions-open, .sidebar-session-line.actions-open').forEach((item) => {
    item.classList.remove('actions-open');
  });
}

document.addEventListener('pointerdown', (event) => {
  if (
    isMobileLayout()
    && document.body.classList.contains('nav-open')
    && !event.target?.closest?.('.ops-sidebar')
    && !event.target?.closest?.('#mobile-nav-toggle')
    && !event.target?.closest?.('#sidebar-backdrop')
  ) {
    hideMobileSidebar();
  }

  if (!isMobileLayout()) return;
  if (event.button !== undefined && event.button !== 0) return;
  sidebarSwipeState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    navOpen: document.body.classList.contains('nav-open'),
    shouldOpen: false,
    shouldClose: false,
    moved: false,
    targetGroup: null,
  };
  const group = event.target?.closest?.('.sidebar-project-group, .sidebar-session-line');
  if (!group || event.target?.closest?.('button, a.sidebar-compose')) return;
  sidebarSwipeState.targetGroup = group;
  sidebarLongPressOpened = false;
  sidebarLongPressTimer = setTimeout(() => {
    closeSidebarActionMenus();
    group.classList.add('actions-open');
    sidebarLongPressOpened = true;
    sidebarLongPressIgnoreUntil = performance.now() + 1400;
  }, 450);
});

document.addEventListener('pointermove', (event) => {
  if (!sidebarSwipeState || sidebarSwipeState.pointerId !== event.pointerId) return;
  const deltaX = event.clientX - sidebarSwipeState.startX;
  const deltaY = event.clientY - sidebarSwipeState.startY;
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (!sidebarSwipeState.moved && (absX > 14 || absY > 14)) {
    sidebarSwipeState.moved = true;
    clearTimeout(sidebarLongPressTimer);
    sidebarLongPressTimer = null;
  }
  if (!sidebarSwipeState.moved || absX <= absY) return;
  if (sidebarSwipeState.navOpen && deltaX < -55) {
    sidebarSwipeState.shouldClose = true;
  }
  if (!sidebarSwipeState.navOpen && sidebarSwipeState.startX < 24 && deltaX > 55) {
    sidebarSwipeState.shouldOpen = true;
  }
});

document.addEventListener('pointerup', (event) => {
  if (!sidebarSwipeState || sidebarSwipeState.pointerId !== event.pointerId) {
    return;
  }
  if (sidebarSwipeState.shouldClose) {
    closeMobileNavPanel();
  }
  if (sidebarSwipeState.shouldOpen) {
    openMobileNavPanel();
  }
  clearSidebarSwipeState();
}, { passive: true });

document.addEventListener('pointercancel', () => {
  clearSidebarSwipeState();
});

document.addEventListener('click', async (event) => {
  if (event.target?.id === 'sidebar-backdrop') {
    closeMobileNavPanel();
    return;
  }

  const navLink = event.target?.closest?.('.sidebar-link, .sidebar-thread');
  const actionTarget = event.target?.closest?.('[data-action]');
  const action = actionTarget?.dataset?.action;
  const inSidebar = event.target?.closest?.('.ops-sidebar');
  const inMainContent = event.target?.closest?.('.ops-main');
  const inTopbar = event.target?.closest?.('.app-topbar');

  if (sidebarLongPressOpened) {
    sidebarLongPressOpened = false;
    sidebarLongPressIgnoreUntil = 0;
    if (navLink) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  if (performance.now() < sidebarLongPressIgnoreUntil) {
    if (navLink || actionTarget?.closest?.('.sidebar-project-group, .sidebar-session-line')) {
      event.preventDefault();
      event.stopPropagation();
      sidebarLongPressIgnoreUntil = 0;
      return;
    }
  }

  if (isMobileLayout() && document.body.classList.contains('nav-open') && !inSidebar && !inTopbar) {
    closeMobileNavPanel();
  }
  if (!inSidebar) {
    closeSidebarActionMenus();
  }

  if (action === 'toggleNav') {
    const target = event.currentTarget || event.target;
    if (isMobileLayout()) {
      if (document.body.classList.contains('nav-open')) {
        closeMobileNavPanel();
      } else {
        openMobileNavPanel();
      }
    } else {
      document.body.classList.toggle('sidebar-collapsed');
    }
    if (target && target.blur) {
      target.blur();
    }
    return;
  }

  if (navLink) {
    closeMobileNavPanel();
  }
  // Always drop focus from any tapped control so nothing stays highlighted.
  clearStickyInteractiveState(event.target);

  if (!action) {
    const navCard = event.target?.closest?.('[data-href]');
    const interactive = event.target?.closest?.('a, button, input, select, textarea, label, summary');
    if (navCard && !interactive && navCard.dataset.href) {
      event.preventDefault();
      safeNavigate(navCard.dataset.href);
    }
    return;
  }

  if (['stopLane', 'retryLane', 'restartLane', 'auditLane', 'captureEvidence', 'clearEvidence', 'captureEvidencePreset', 'removeWorktree'].includes(action)) {
    await handleLaneActions({ currentTarget: actionTarget });
    return;
  }

  if (action === 'toggleExecutorPanel') {
    shell.executorPanelOpen = !shell.executorPanelOpen;
    render(captureContentUiState());
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
    'copyPhoneUrl',
    'createPairingCode',
    'connectDesktopApp',
    'copyDesktopConfig',
    'pairBrowserSession',
    'logoutBrowserSession',
    'revokeBrowserSession',
    'cleanupArtifacts',
    'cleanupArtifactsRunNow',
    'deleteMcpTool',
    'editMcpTool',
    'checkProjectQuickLink',
    'deleteProjectQuickLink',
    'refreshExecutorCli',
    'reinstallExecutorCli',
    'archiveProject',
    'archiveSession',
    'renameProject',
    'renameSession',
    // These are handled in handleSystemActions but were missing from the
    // dispatch allowlist, so their buttons (incl. agent approve/deny) silently
    // did nothing. Wire them up.
    'approveApproval',
    'denyApproval',
    'saveSessionPlan',
    'pickAttachment',
    'removeAttachment',
    'setupCapture',
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
  safeNavigate(navCard.dataset.href);
});

window.addEventListener('hashchange', () => {
  render();
});

function hasLiveOrchestratorConsole() {
  const session = shell.sessions.find((value) => value.id === shell.route.sessionId);
  if (!session) return false;
  const lane = activeOrchestratorLaneForSession(session);
  return Boolean(lane && isLiveLaneState(lane.state));
}

setInterval(() => {
  const cadenceMs = hasLiveOrchestratorConsole() ? 1000 : 3000;
  if (Date.now() - lastRefreshAt >= cadenceMs) {
    refresh();
  }
}, 500);

// Live push: subscribe to the server event stream and refresh promptly when the
// state revision changes (agent turns, approvals, lane transitions). Works when
// the browser is paired (cookie) or on the loopback workstation; falls back to
// the polling timer above for token-in-page browsers where SSE can't authenticate.
let _streamRefreshTimer = null;
function scheduleStreamRefresh() {
  if (_streamRefreshTimer) return;
  _streamRefreshTimer = setTimeout(() => { _streamRefreshTimer = null; refresh(); }, 150);
}
function connectEventStream() {
  if (typeof EventSource === 'undefined') return;
  let retryMs = 2000;
  const open = () => {
    let es;
    try {
      es = new EventSource('/api/streams/events');
    } catch {
      return;
    }
    es.addEventListener('update', scheduleStreamRefresh);
    es.addEventListener('snapshot', scheduleStreamRefresh);
    es.onerror = () => {
      try { es.close(); } catch { /* ignore */ }
      // Reconnect with backoff; the polling timer keeps the UI fresh meanwhile.
      retryMs = Math.min(retryMs * 2, 30000);
      window.setTimeout(open, retryMs);
    };
    es.onopen = () => { retryMs = 2000; };
  };
  open();
}

initializeApiToken();
registerServiceWorker();
renderMobileManifest();
setupSidebarReorder();
// Connect the live SSE stream only after the initial load settles. A persistent
// SSE connection would otherwise keep the page from ever reaching "network idle"
// (used by automated checks); the polling timer covers this short window.
refresh().then(() => window.setTimeout(connectEventStream, 1200)).catch(() => {});
