// Home/setup view renderer (phone+laptop setup, providers, executors, MCP
// tools, private access, etc.). The largest dashboard view. Extracted from app.js.

import {
  effectiveAccessMode,
  effectiveProjectQuickLinkCheckPreference,
  effectiveProjectQuickLinkUrl,
  fallbackUrlForAccessMode,
  preferredPhoneUrl,
} from './access-mode.js';
import { api } from './api.js';
import { clientUrl, isWorkstation, safeHref, writeHtml } from './dom.js';
import { formatRelative, latestTimestamp, safeAttr, safeText } from './format.js';
import { icon } from './icons.js';
import { browserNotificationPermission } from './notifications.js';
import { qrSvgForText } from './qr.js';
import { activeHomePanel, executorCapabilitiesFor, isVerificationProject, renderExecutorCapabilities } from './render-helpers.js';
import { refs, shell } from './state.js';
import {
  renderSimpleSection,
  renderPairPanel,
  renderDesktopControlPanel,
  renderSetupPanel,
  renderTokenPanel,
  renderExecutorProfilesPanel,
  renderCapturePanel,
  renderCliHealthPanel,
  renderCleanupPanel,
  renderMcpPanel,
  renderPrivateAccessPanel,
  renderProvidersPanel,
  renderEffectiveSettingsPanel,
  renderNotificationsPanel,
  renderBackupPanel,
  renderSupervisorPanel,
  renderArchivePanel,
  renderAppearancePanel,
  renderProjectListPanel,
  renderRemoteConnectionPanel,
} from './render-home-panels.js';

const INFO_ICON = icon('info', { size: 15 });
const EXECUTOR_DISPLAY_NAMES = {
  codex: 'Codex',
  claude: 'Claude',
  'gemini-cli': 'Gemini CLI',
  'composer-cli': 'Composer CLI',
};

function toTitleLabel(value) {
  const text = String(value || '').trim();
  if (!text) return 'Unknown';
  return text
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      const upper = part.toUpperCase();
      if (upper === 'CLI' || upper === 'API' || upper === 'MCP') return upper;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function executorDisplayName(type) {
  const key = String(type || '').trim();
  return EXECUTOR_DISPLAY_NAMES[key] || toTitleLabel(key);
}

function envPrefixForExecutor(type) {
  return String(type || '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function listText(value, fallback = 'none') {
  const list = Array.isArray(value) ? value.filter(Boolean) : [];
  return list.length ? list.join(', ') : fallback;
}

function commandText(parts, fallback = 'not configured') {
  return Array.isArray(parts) && parts.length ? parts.join(' ') : fallback;
}

function settingsMeta(parts = []) {
  const rows = parts
    .filter((part) => part !== undefined && part !== null && String(part).trim())
    .map((part) => `<span>${safeText(part)}</span>`)
    .join('');
  return rows ? `<div class="settings-row-meta">${rows}</div>` : '';
}

function settingsInfoDetails(title, items = [], extraHtml = '') {
  const rows = items
    .filter((item) => item && item.label && item.value !== undefined && item.value !== null && String(item.value).trim())
    .map((item) => `
      <div>
        <strong>${safeText(item.label)}</strong>
        <span>${safeText(item.value)}</span>
      </div>
    `)
    .join('');
  if (!rows && !extraHtml) return '';
  return `
    <details class="settings-info">
      <summary aria-label="Show ${safeAttr(title)} details" title="Details">${INFO_ICON}</summary>
      <div class="settings-info-body">
        ${rows ? `<div class="settings-info-grid">${rows}</div>` : ''}
        ${extraHtml ? `<div class="settings-info-extra">${extraHtml}</div>` : ''}
      </div>
    </details>`;
}

function renderSettingsRow({ title, meta = [], detailItems = [], detailHtml = '', actions = '', className = '' }) {
  const details = settingsInfoDetails(title, detailItems, detailHtml);
  const side = `${details}${actions ? `<div class="settings-row-controls">${actions}</div>` : ''}`;
  return `
    <div class="provider-row settings-row ${className}">
      <div class="settings-row-main">
        <strong>${safeText(title)}</strong>
        ${settingsMeta(meta)}
      </div>
      ${side ? `<div class="settings-row-side">${side}</div>` : ''}
    </div>`;
}

function isSmokeMcpTool(tool) {
  const name = String(tool?.name || tool?.id || '').toLowerCase();
  return name.startsWith('smoke-tool-');
}

function mcpToolDisplayName(tool, index, test = false) {
  if (test) return `Test tool ${index + 1}`;
  return toTitleLabel(tool?.displayName || tool?.name || tool?.id || 'Custom tool');
}

export function renderHome() {
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
  // Only HTTP / HTTPS make sense over Tailscale ("local" and "auto-detect" are
  // gone). Default is HTTP. HTTPS is selectable — it requires HTTPS certificates
  // enabled in the user's Tailscale admin (DNS → HTTPS Certificates), which Orca
  // can't toggle. Legacy 'auto'/'local' settings map to HTTP.
  const httpsSelected = privateSettings.preferredMode === 'tailnet-https-serve';
  const accessModeSummary = httpsSelected ? 'Tailscale HTTPS' : 'Tailscale HTTP';
  const accessModeOptions = `
    <option value="tailnet-http" ${httpsSelected ? '' : 'selected'}>HTTP — recommended</option>
    <option value="tailnet-https-serve" ${httpsSelected ? 'selected' : ''}>HTTPS</option>
  `;
  const phoneUrl = preferredPhoneUrl(privateTargets, privateSettings, tailnet);
  const phoneQr = qrSvgForText(phoneUrl);
  // Deep-link QR: scanning this with an iPhone that has the Orca app installed
  // opens the app (via the orca:// scheme) and points it straight at this
  // workstation, instead of just opening the URL in Safari.
  const phoneDeepLinkQr = phoneUrl && /^https?:\/\//i.test(phoneUrl)
    ? qrSvgForText(`orca://connect?ws=${encodeURIComponent(phoneUrl)}`)
    : phoneQr;
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
          <a class="secondary" href="${safeHref(targetUrl)}" target="_blank" rel="noopener noreferrer">Open</a>
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
        ${notification.href ? `<a class="secondary" href="${safeHref(notification.href)}">Open</a>` : ''}
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
    const secretState = credential.present
      ? `Secret set${credential.backend ? ` in ${credential.backend}` : ''}`
      : 'Secret missing';
    const actions = `
      <button class="secondary" data-action="refreshProviderHealth" data-provider-id="${safeAttr(profile.id)}" type="button">Check</button>
      <button class="secondary" data-action="toggleProviderEnabled" data-provider-id="${safeAttr(profile.id)}" data-enabled="${profile.enabled ? 'false' : 'true'}" type="button">${profile.enabled ? 'Disable' : 'Enable'}</button>
      ${profile.secretRef ? `<button class="secondary" data-action="setProviderSecret" data-provider-id="${safeAttr(profile.id)}" type="button">Set secret</button>` : ''}
      ${profile.secretRef ? `<button class="secondary" data-action="deleteProviderSecret" data-provider-id="${safeAttr(profile.id)}" type="button">Delete secret</button>` : ''}
    `;
    return renderSettingsRow({
      title: profile.displayName || profile.id,
      meta: [
        profile.kind || 'provider',
        profile.enabled ? 'Available' : 'Disabled',
        `Health ${status}`,
        secretState,
      ],
      detailItems: [
        { label: 'Provider id', value: profile.id },
        { label: 'Install policy', value: profile.installPolicy },
        { label: 'Update policy', value: profile.updatePolicy },
        { label: 'Secret reference', value: profile.secretRef || profile.apiKeyEnv || 'none' },
        { label: 'Credential backend', value: credential.backend || providerCatalog.credentialBackend || 'unknown' },
        { label: 'Base URL', value: profile.baseUrl || '' },
      ],
      actions,
    });
  }).join('');
  const mcpTools = Array.isArray(shell.mcpTools) ? shell.mcpTools : [];
  const visibleMcpTools = mcpTools.filter((tool) => !isSmokeMcpTool(tool));
  const renderMcpToolRows = (tools, { test = false } = {}) => tools.map((tool, index) => {
    const toolId = tool.id || tool.name;
    const args = commandText(tool.args, 'none');
    const scopes = listText(tool.scope, 'all scopes');
    const actions = `
      <button class="secondary" data-action="editMcpTool" data-tool-id="${safeAttr(toolId)}" type="button">Edit</button>
      <button class="secondary" data-action="deleteMcpTool" data-tool-id="${safeAttr(toolId)}" type="button">Delete</button>
    `;
    return renderSettingsRow({
      title: mcpToolDisplayName(tool, index, test),
      meta: [
        tool.command || 'command missing',
        scopes,
        tool.enabled ? 'Available to agents' : 'Saved only',
      ],
      detailItems: [
        { label: 'Raw name', value: tool.name || tool.id || '' },
        { label: 'Command', value: tool.command || '' },
        { label: 'Arguments', value: args },
        { label: 'Scopes', value: scopes },
        { label: 'Notes', value: tool.notes || '' },
      ],
      actions,
      className: test ? 'settings-row-muted' : '',
    });
  }).join('');
  const mcpOptions = renderMcpToolRows(visibleMcpTools);
  const profiles = shell.executorProfiles || {};
  const profileRows = Object.values(profiles).map((profile) => {
    const typeUpper = envPrefixForExecutor(profile.type);
    const envKey = typeUpper ? `ORCA_${typeUpper}` : null;
    const modelEnv = envKey ? `${envKey}_MODEL` : '';
    const permissionsEnv = envKey ? `${envKey}_PERMISSIONS` : '';
    return renderSettingsRow({
      title: executorDisplayName(profile.type || profile.name),
      meta: [
        `Binary ${profile.defaultBinary || 'not configured'}`,
        'Model per lane',
        'Permissions per lane',
      ],
      detailItems: [
        { label: 'Type', value: profile.type || profile.name || '' },
        { label: 'Default args', value: listText(profile.defaultArgs) },
        { label: 'Allowed binaries', value: listText(profile.allowedBinaries, 'default') },
        { label: 'Model default env', value: modelEnv || 'none' },
        { label: 'Permissions env', value: permissionsEnv || 'none' },
        { label: 'Suggested permissions', value: 'plan, restricted, full' },
        { label: 'Env allowlist', value: listText(profile.envWhitelist, 'default') },
        { label: 'Workdir roots', value: listText(profile.workdirRoots, 'default') },
      ],
      detailHtml: renderExecutorCapabilities(executorCapabilitiesFor(profile.type), { compact: true }),
    });
  }).join('');
  const cliRows = Object.entries(shell.executorCliInfo || {}).map(([type, info]) => {
    const command = Array.isArray(info?.reinstall?.command)
      ? info.reinstall.command.join(' ')
      : 'not configured';
    const preferSource = info?.reinstall?.preferSource ? 'Source first' : 'Package plan';
    const sourceRepos = Array.isArray(info?.reinstall?.sourceRepos)
      ? info.reinstall.sourceRepos.join(', ')
      : 'not configured';
    const sourceCommand = Array.isArray(info?.reinstall?.sourceCommand)
      ? info.reinstall.sourceCommand.join(' ')
      : 'not available';
    const hasSourceCommand = Array.isArray(info?.reinstall?.sourceCommand) && info?.reinstall?.sourceCommand.length > 0;
    const sourceButton = hasSourceCommand
      ? `<button class="secondary" data-action="reinstallExecutorCli" data-executor="${safeAttr(type)}" data-use-source="true" type="button">Source plan</button>`
      : `<button class="secondary" type="button" disabled title="No trusted source command configured">No source plan</button>`;
    const actions = `
      <button class="secondary" data-action="refreshExecutorCli" data-executor="${safeAttr(type)}" type="button">Refresh</button>
      <button class="secondary" data-action="reinstallExecutorCli" data-executor="${safeAttr(type)}" data-use-source="false" type="button">Reinstall plan</button>
      ${sourceButton}
    `;
    return renderSettingsRow({
      title: executorDisplayName(type),
      meta: [
        `Binary ${info?.binary || type}`,
        info?.version ? `Version ${info.version}` : 'Version unknown',
        info?.binaryExists === false ? 'Missing from PATH' : 'Detected',
        preferSource,
      ],
      detailItems: [
        { label: 'Executor type', value: type },
        { label: 'Reinstall command', value: command },
        { label: 'Source repos', value: sourceRepos },
        { label: 'Source command', value: sourceCommand },
      ],
      detailHtml: renderExecutorCapabilities(info?.capabilities, { compact: true }),
      actions,
    });
  }).join('');
  const renderProjectCard = (project) => {
    const projectSessions = shell.sessions.filter((session) => session.projectId === project.id);
    const projectLanes = shell.lanes.filter((lane) => lane.projectId === project.id);
    const latestActivity = latestTimestamp([...projectSessions, ...projectLanes, project]);
    const quickLinks = (Array.isArray(project.quickLinks) ? project.quickLinks : [])
      .filter((quick) => !quick.hidden)
      .map((quick) => {
        const url = clientUrl(effectiveProjectQuickLinkUrl(quick));
        const checkPreference = effectiveProjectQuickLinkCheckPreference(quick);
        const health = quick.healthStatus ? `<span class="tiny muted quick-link-health">${safeText(quick.healthStatus)}</span>` : '';
        return `<div class="quick-link-row">
          <a class="quick-link-name" href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.label)}</a>
          ${health}
          <button class="quick-link-btn" data-action="copyPhoneUrl" data-url="${safeAttr(url)}" type="button" title="Copy this link" aria-label="Copy link">Copy</button>
          <button class="quick-link-btn" data-action="checkProjectQuickLink" data-project-id="${safeAttr(project.id)}" data-link-id="${safeAttr(quick.id)}" data-prefer="${safeAttr(checkPreference)}" type="button" title="Check this link" aria-label="Check link">Check</button>
          <button class="quick-link-btn" data-action="deleteProjectQuickLink" data-project-id="${safeAttr(project.id)}" data-link-id="${safeAttr(quick.id)}" type="button" title="Remove this link" aria-label="Remove link">Remove</button>
        </div>`;
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
  // Only real paired REMOTE devices appear here — the local workstation browser
  // (token bootstrap, pairedFromId null) is not a "paired device".
  const authSessionRows = (Array.isArray(shell.authSessions) ? shell.authSessions : [])
    .filter((session) => session && (session.paired || session.pairedFromId) && session.active !== false)
    .map((session) => `
    <div class="provider-row device-row">
      <div class="device-row-info">
        <strong>${safeText(session.label || 'Paired device')}</strong>
        <div class="tiny muted">${session.active ? 'active' : 'inactive'} · paired ${safeText(formatRelative(session.createdAt))} · expires ${safeText(formatRelative(session.expiresAt))}</div>
        ${session.userAgent ? `<div class="tiny muted device-row-ua">${safeText(session.userAgent)}</div>` : ''}
      </div>
      <button class="device-revoke" data-action="revokeBrowserSession" data-session-id="${safeAttr(session.id)}" type="button" ${session.active ? '' : 'disabled'}>Revoke</button>
    </div>
  `).join('');
  const desktopBootstrap = shell.lastDesktopBootstrap || null;
  const desktopBootstrapMarkup = desktopBootstrap ? `
    <div class="settings-callout">
      <div>
        <strong>Generated orchestrator config</strong>
        <span class="tiny muted">Lease expires ${safeText(formatRelative(desktopBootstrap.lease?.expiresAt))}; paste into your desktop app and restart it.</span>
      </div>
    </div>
    <div class="settings-action-list">
      <div class="settings-action-row">
        <div class="settings-action-main">
          <span class="settings-row-kicker">Copy</span>
          <strong>CLI commands and app config</strong>
          <span class="tiny muted">Scoped orchestrator tools only. The raw API token is never included.</span>
        </div>
        <div class="settings-action-controls">
        <button class="secondary" data-action="copyDesktopConfig" data-client="claudeCli" type="button">Copy claude mcp add</button>
        <button class="secondary" data-action="copyDesktopConfig" data-client="codexCli" type="button">Copy codex mcp add</button>
        <button class="secondary" data-action="copyDesktopConfig" data-client="claudeDesktop" type="button">Copy Claude Desktop JSON</button>
        <button class="secondary" data-action="copyDesktopConfig" data-client="codex" type="button">Copy Codex TOML</button>
        </div>
      </div>
    </div>
  ` : '<div class="settings-callout"><div><strong>Connect a desktop orchestrator</strong><span class="tiny muted">Generates scoped MCP config for Codex app or Claude Desktop.</span></div></div>';
  const supervisorBootstrap = shell.lastSupervisorBootstrap || null;
  const supervisorBootstrapMarkup = supervisorBootstrap ? `
    <div class="settings-callout">
      <div>
        <strong>Generated supervisor config</strong>
        <span class="tiny muted">Lease expires ${safeText(formatRelative(supervisorBootstrap.lease?.expiresAt))}; grants cross-project supervisor tools only.</span>
      </div>
    </div>
    <div class="settings-action-list">
      <div class="settings-action-row">
        <div class="settings-action-main">
          <span class="settings-row-kicker">Copy</span>
          <strong>Supervisor MCP config</strong>
          <span class="tiny muted">Use this in Codex app, Claude Desktop, or the CLI MCP registry.</span>
        </div>
        <div class="settings-action-controls">
        <button class="secondary" data-action="copySupervisorConfig" data-client="claudeCli" type="button">Copy claude mcp add</button>
        <button class="secondary" data-action="copySupervisorConfig" data-client="codexCli" type="button">Copy codex mcp add</button>
        <button class="secondary" data-action="copySupervisorConfig" data-client="claudeDesktop" type="button">Copy Claude Desktop JSON</button>
        <button class="secondary" data-action="copySupervisorConfig" data-client="codex" type="button">Copy Codex TOML</button>
        </div>
      </div>
    </div>
  ` : '<div class="settings-callout"><div><strong>Connect a supervisor agent</strong><span class="tiny muted">Generates scoped MCP config for cross-project review and audit.</span></div></div>';
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

  const ctx = {
    panel,
    showMainHome,
    phoneUrl,
    phoneQr,
    phoneDeepLinkQr,
    accessModeSummary,
    accessModeOptions,
    privateSettings,
    tailnet,
    privateTargets,
    authSessionRows,
    desktopBootstrapMarkup,
    supervisorOverview: shell.supervisorOverview || null,
    supervisorBootstrapMarkup,
    tokenConfigured,
    browserPaired,
    profileRows,
    captureSummary,
    captureDetail,
    captureReady,
    cliRows,
    schedule,
    cleanupNext,
    scheduleApiUrl,
    scheduleRunApiUrl,
    mcpTools,
    visibleMcpTools,
    mcpOptions,
    commandRows,
    targetRows,
    providerProfiles,
    providerCatalog,
    providerRows,
    effectiveSummary,
    effectiveSources,
    effectiveSourcesText,
    effectiveSettingsText,
    unreadNotifications,
    browserPermission,
    notificationSettings,
    notificationRows,
    primaryProjectCards,
    verificationProjects,
    verificationProjectCards,
    projectRows,
    artifactCleanupUrl,
  };

  // Host-management panels only make sense on the trusted workstation (they
  // configure THIS machine's CLIs, capture, providers, MCP tools, Tailscale serve,
  // backups, etc.). A paired remote device — phone or laptop — can't act on any of
  // them, so they're hidden there. Remote Settings = Access + Notifications +
  // Archive (+ Pair). Detection: the workstation is reached over localhost; remote
  // devices reach Orca over the tailnet host.
  const onWorkstation = isWorkstation();
  const workstationOnly = (markup) => (onWorkstation ? markup : '');

  writeHtml(refs.content, `
    ${renderSimpleSection(ctx)}
    <section class="grid-2 home-panels" data-active-panel="${safeAttr(panel)}">
      ${workstationOnly(renderPairPanel(ctx))}
      ${workstationOnly(renderDesktopControlPanel(ctx))}
      ${workstationOnly(renderSetupPanel(ctx))}
      ${workstationOnly(renderTokenPanel(ctx))}
      ${onWorkstation ? '' : renderRemoteConnectionPanel()}
      ${renderAppearancePanel()}
      ${workstationOnly(renderExecutorProfilesPanel(ctx))}
      ${workstationOnly(renderCapturePanel(ctx))}
      ${workstationOnly(renderCliHealthPanel(ctx))}
      ${workstationOnly(renderCleanupPanel(ctx))}
      ${workstationOnly(renderMcpPanel(ctx))}
      ${workstationOnly(renderSupervisorPanel(ctx))}
      ${workstationOnly(renderPrivateAccessPanel(ctx))}
      ${workstationOnly(renderProvidersPanel(ctx))}
      ${workstationOnly(renderEffectiveSettingsPanel(ctx))}
      ${renderNotificationsPanel(ctx)}
      ${renderArchivePanel()}
      ${workstationOnly(renderBackupPanel())}
      ${renderProjectListPanel(ctx)}
    </section>
  `);
}
