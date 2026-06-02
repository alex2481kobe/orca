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

let refreshRequestId = 0;
let refreshInFlight = false;
let lastRefreshAt = 0;

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

function closeMobileNavPanel() {
  document.body.classList.remove('nav-open');
}

function openMobileNavPanel() {
  if (!isMobileLayout()) return;
  document.body.classList.add('nav-open');
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
