import { qrSvgForText } from './ui/qr.js';
import { safeText, safeAttr, stateBadge, formatMeta, formatRelative, latestTimestamp } from './ui/format.js';
import { shell, refs } from './ui/state.js';
import { MOBILE_NAV_BREAKPOINT, API_PROVIDER_EXECUTOR_TYPES, FIRST_CLASS_CLI_EXECUTOR_TYPES, CLI_EXECUTOR_TARGET_ALIASES, MCP_TOOL_SCOPE_ALLOWLIST, API_TOKEN_STORAGE_KEY, SIDEBAR_ORDER_STORAGE_KEY, NOTIFICATION_SEEN_STORAGE_KEY, FOLDER_ICON, COMPOSE_ICON, PENCIL_ICON } from './ui/constants.js';
import { clientUrl, safeHref, safeNavigate, authRequiredMessage, isLocalHostName, writeHtml, renderAlert } from './ui/dom.js';
import { browserNotificationsSupported, browserNotificationPermission, readSeenBrowserNotifications, writeSeenBrowserNotifications, requestBrowserNotificationPermission, maybeShowBrowserNotifications } from './ui/notifications.js';
import { normalizeExecutorType, parseCommandParts, executorTargetsCommand, executorTargetsBinary, getExecutorProfile, getProviderProfile, isApiExecutorType, apiProviderOptions, cliExecutorOptions, getExecutorScopedMcpTools, findMcpTool, normalizeMcpToolScopes } from './ui/executor.js';
import { accessModeLabel, effectiveAccessMode, exactUrlForAccessMode, fallbackUrlForAccessMode, effectiveProjectQuickLinkUrl, quickLinkHealthLabel, preferredPhoneUrl } from './ui/access-mode.js';
import { readSidebarOrder, writeSidebarOrder, orderItems, moveId } from './ui/sidebar.js';
import { api, initializeApiToken, isTrustedAdminClientHost, browserAccessBlocked, setApiToken, currentActiveProject, clearProtectedWorkspaceState, lockClientAuthState, maybeLockFromResponse } from './ui/api.js';
import { stateTagClass, getActionPolicy, needsApproval, confirmHighRiskAction, pendingAuditsForLane, pendingAuditsForSession, laneDetailRoute, isVerificationProject, activeHomePanel, renderBreadcrumbs, renderTopbarTitle, agentEventTone, agentEventLabel, isLiveLaneState, isRestartableLaneState, executorCapabilitiesFor, renderExecutorCapabilities, capabilityList } from './ui/render-helpers.js';
import { renderHome } from './ui/render-home.js';
import { renderLaneExecutorGuidance, captureContentUiState, restoreContentUiState, renderAccessGate, renderProject, renderLaneCard, renderAgentEventTimeline, modelPresetOptions, intelligenceOptions, runModeOptions, modelControlOptions, renderOrchestratorTerminal, renderApprovalRows, renderSessionApprovals, composerAttachmentsFor, renderComposerAttachmentChips, refreshComposerAttachments, readFileAsBase64, uploadComposerFiles, renderOrchestratorConsole, renderExecutorLanePanelItem, renderExecutorSidePanel, activeOrchestratorLaneForSession, renderSession, renderLane, renderAuditLog, loadEvidenceGallery, render, renderStatusStrip, renderBlockers, renderSidebarProjects, renderMobileManifest } from './ui/render-views.js';
import { refresh, showArtifacts, parseRoute, connectEventStream, startPolling } from './ui/controller.js';






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

function closeMobileNavPanel() {
  document.body.classList.remove('nav-open');
}

function openMobileNavPanel() {
  if (!isMobileLayout()) return;
  document.body.classList.add('nav-open');
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



// Live push: subscribe to the server event stream and refresh promptly when the
// state revision changes (agent turns, approvals, lane transitions). Works when
// the browser is paired (cookie) or on the loopback workstation; falls back to
// the polling timer above for token-in-page browsers where SSE can't authenticate.

initializeApiToken();
registerServiceWorker();
renderMobileManifest();
setupSidebarReorder();
// Connect the live SSE stream only after the initial load settles. A persistent
// SSE connection would otherwise keep the page from ever reaching "network idle"
// (used by automated checks); the polling timer covers this short window.
startPolling();
refresh().then(() => window.setTimeout(connectEventStream, 1200)).catch(() => {});
