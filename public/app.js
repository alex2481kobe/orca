import { qrSvgForText } from './ui/qr.js';
import { safeText, safeAttr, stateBadge, formatMeta, formatRelative, latestTimestamp } from './ui/format.js';
import { shell, refs } from './ui/state.js';
import { MOBILE_NAV_BREAKPOINT, API_PROVIDER_EXECUTOR_TYPES, FIRST_CLASS_CLI_EXECUTOR_TYPES, CLI_EXECUTOR_TARGET_ALIASES, MCP_TOOL_SCOPE_ALLOWLIST, API_TOKEN_STORAGE_KEY, SIDEBAR_ORDER_STORAGE_KEY, NOTIFICATION_SEEN_STORAGE_KEY, FOLDER_ICON, COMPOSE_ICON, PENCIL_ICON } from './ui/constants.js';
import { clientUrl, safeHref, safeNavigate, authRequiredMessage, isLocalHostName, writeHtml, renderAlert } from './ui/dom.js';
import { browserNotificationsSupported, browserNotificationPermission, readSeenBrowserNotifications, writeSeenBrowserNotifications, requestBrowserNotificationPermission, maybeShowBrowserNotifications } from './ui/notifications.js';
import { normalizeExecutorType, parseCommandParts, executorTargetsCommand, executorTargetsBinary, getExecutorProfile, getProviderProfile, isApiExecutorType, apiProviderOptions, cliExecutorOptions, getExecutorScopedMcpTools, findMcpTool, normalizeMcpToolScopes } from './ui/executor.js';
import { accessModeLabel, effectiveAccessMode, exactUrlForAccessMode, fallbackUrlForAccessMode, effectiveProjectQuickLinkUrl, quickLinkHealthLabel, preferredPhoneUrl } from './ui/access-mode.js';
import { readSidebarOrder, writeSidebarOrder, orderItems, moveId, toggleProjectExpanded } from './ui/sidebar.js';
import { api, initializeApiToken, isTrustedAdminClientHost, browserAccessBlocked, setApiToken, currentActiveProject, clearProtectedWorkspaceState, lockClientAuthState, maybeLockFromResponse } from './ui/api.js';
import { stateTagClass, getActionPolicy, needsApproval, confirmHighRiskAction, pendingAuditsForLane, pendingAuditsForSession, laneDetailRoute, isVerificationProject, activeHomePanel, renderBreadcrumbs, renderTopbarTitle, agentEventTone, agentEventLabel, isLiveLaneState, isRestartableLaneState, executorCapabilitiesFor, renderExecutorCapabilities, capabilityList } from './ui/render-helpers.js';
import { renderHome } from './ui/render-home.js';
import { renderLaneExecutorGuidance, repopulateExecutorScopedControls, captureContentUiState, restoreContentUiState, renderAccessGate, renderProject, renderLaneCard, renderAgentEventTimeline, modelPresetOptions, intelligenceOptions, runModeOptions, modelControlOptions, renderOrchestratorTerminal, renderApprovalRows, renderSessionApprovals, composerAttachmentsFor, renderComposerAttachmentChips, refreshComposerAttachments, readFileAsBase64, uploadComposerFiles, renderOrchestratorConsole, renderExecutorLanePanelItem, renderExecutorSidePanel, activeOrchestratorLaneForSession, renderSession, renderLane, renderAuditLog, loadEvidenceGallery, render, renderStatusStrip, renderBlockers, renderSidebarProjects, renderMobileManifest } from './ui/render-views.js';
import { refresh, showArtifacts, parseRoute, connectEventStream, startPolling } from './ui/controller.js';
import { handlePrivateAccessSettings, handleNotificationSettings, handleNotificationAction, handleCreatePrivateAccessTarget, handlePrivateAccessAction, handleProviderAction, handleAppBackupAction, handleCleanupSchedule, handleCreateMcpTool, handleCreateProject, handleCreateSession, handleAddProjectQuickLink, handleCreateLane, handleOrchestratorMessage, handleLaneControlsUpdate, handleAuditEventAction, handleWorkstationPicker, buildCleanupScheduleBody, buildMcpToolBody, buildApprovedActionBody, toObj } from './ui/handlers.js';
import { handleLaneActions, handleSessionActions, handleSystemActions } from './ui/handlers-actions.js';






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
  // Orchestrator composer: switching the agent re-derives its mode/intelligence/model
  // options from that executor's detected capabilities.
  if (event.target && event.target.name === 'executorType' && event.target.form && event.target.form.id === 'orchestrator-message-form') {
    repopulateExecutorScopedControls(event.target.form);
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

  if (['browseWorkstation', 'workstationOpenDir', 'workstationUseDir', 'workstationPickerClose'].includes(action)) {
    await handleWorkstationPicker(actionTarget);
    return;
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

  // Internal links navigate via the SPA router (no full reload). A project row
  // also toggles its session accordion. External links (target set) fall through.
  const internalAnchor = !action ? event.target?.closest?.('a[href^="/"]:not([target])') : null;
  if (internalAnchor) {
    event.preventDefault();
    // A project row ONLY expands/collapses its sessions in the sidebar — it no
    // longer navigates to a project page. Sessions (and other links) navigate.
    if (internalAnchor.dataset.projectToggle && internalAnchor.dataset.projectId) {
      toggleProjectExpanded(internalAnchor.dataset.projectId, false);
      render(captureContentUiState());
      return;
    }
    closeMobileNavPanel();
    safeNavigate(internalAnchor.getAttribute('href'));
    return;
  }

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
    'restoreProject',
    'restoreSession',
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

// SPA navigation: pushState changes (from safeNavigate) re-render in place using
// already-loaded data, then refresh in the background. No full window reload.
window.addEventListener('popstate', () => {
  shell.route = parseRoute();
  render(captureContentUiState());
  refresh().catch(() => {});
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
