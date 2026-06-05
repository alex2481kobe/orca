// Home/setup view renderer (phone+laptop setup, providers, executors, MCP
// tools, private access, etc.). The largest dashboard view. Extracted from app.js.

import { accessModeLabel, effectiveAccessMode, effectiveProjectQuickLinkUrl, fallbackUrlForAccessMode, preferredPhoneUrl } from './access-mode.js';
import { api, setApiToken } from './api.js';
import { clientUrl, isWorkstation, safeHref, writeHtml } from './dom.js';
import { formatRelative, latestTimestamp, safeAttr, safeText } from './format.js';
import { browserNotificationPermission, browserNotificationsSupported } from './notifications.js';
import { qrSvgForText } from './qr.js';
import { MCP_TOOL_SCOPE_ALLOWLIST } from './constants.js';
import { activeHomePanel, executorCapabilitiesFor, isVerificationProject, renderExecutorCapabilities } from './render-helpers.js';
import { refs, shell } from './state.js';
import {
  renderSimpleSection,
  renderPairPanel,
  renderDesktopControlPanel,
  renderSetupPanel,
  renderTokenPanel,
  renderAccessPanel,
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
  renderArchivePanel,
  renderAppearancePanel,
  renderProjectListPanel,
  renderSystemActionsPanel,
} from './render-home-panels.js';

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
      ${renderAppearancePanel()}
      ${workstationOnly(renderAccessPanel(ctx))}
      ${workstationOnly(renderExecutorProfilesPanel(ctx))}
      ${workstationOnly(renderCapturePanel(ctx))}
      ${workstationOnly(renderCliHealthPanel(ctx))}
      ${workstationOnly(renderCleanupPanel(ctx))}
      ${workstationOnly(renderMcpPanel(ctx))}
      ${workstationOnly(renderPrivateAccessPanel(ctx))}
      ${workstationOnly(renderProvidersPanel(ctx))}
      ${workstationOnly(renderEffectiveSettingsPanel(ctx))}
      ${renderNotificationsPanel(ctx)}
      ${renderArchivePanel()}
      ${workstationOnly(renderBackupPanel())}
      ${renderProjectListPanel(ctx)}
      ${workstationOnly(renderSystemActionsPanel(ctx))}
    </section>
  `);
}
