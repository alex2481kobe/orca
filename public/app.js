import { shell, refs } from './ui/state.js';
import { MOBILE_NAV_BREAKPOINT } from './ui/constants.js';
import { safeNavigate, appendNativeFlag, isNativeApp } from './ui/dom.js';
import { readSidebarOrder, writeSidebarOrder, orderItems, moveId, toggleProjectExpanded } from './ui/sidebar.js';
import { api, initializeApiToken, setApiToken, currentActiveProject } from './ui/api.js';
import { isVerificationProject } from './ui/render-helpers.js';
import { renderLaneExecutorGuidance, repopulateExecutorScopedControls, captureContentUiState, uploadComposerFiles, renderSession, render, renderSidebarProjects, renderMobileManifest } from './ui/render-views.js';
import { refresh, showArtifacts, parseRoute, connectEventStream, startPolling, syncAuthSessions } from './ui/controller.js';
import { handlePrivateAccessSettings, handleNotificationSettings, handleNotificationAction, handleCreatePrivateAccessTarget, handlePrivateAccessAction, handleProviderAction, handleAppBackupAction, handleCleanupSchedule, handleCreateMcpTool, handleAddProjectQuickLink, handleCreateLane, handleOrchestratorMessage, handleLaneControlsUpdate, handleAuditEventAction, handleWorkstationPicker, handleNewSession, handleNewProject, ensureRealSession } from './ui/handlers.js';
import { handleLaneActions, handleSessionActions, handleSystemActions } from './ui/handlers-actions.js';
import { initDropdowns, enhanceSelects } from './ui/dropdown.js';
import { initComposerConfig, refreshConfigLabel } from './ui/composer-config.js';
import { initComposerContext } from './ui/composer-context.js';
import { initSlashCommands } from './ui/slash-commands.js';
import { initMobileShell } from './ui/mobile-shell.js';
import { initTheme, setThemePref, appendThemeParam } from './ui/theme.js';
import { defaultModelFor } from './ui/executor.js';
import { normalizeWorkstationUrl, rememberWorkstation, setPendingWorkstationUrl, activeWorkstationUrl } from './ui/workstations.js';
import { openRowMenuFromTrigger, closeRowMenu, isRowMenuOpenFor } from './ui/row-menu.js';
import { openScopedSettingsDialog } from './ui/settings-dialog.js';
import { toggleComposerDictation, voiceSupported } from './ui/voice.js';

// Deep-link entry point for the native app: the Rust side (run_mobile) calls this
// when an `orca://connect?ws=<workstation-url>` link is opened (e.g. a QR scanned
// from the iPhone Camera). Defined at module top so it exists as early as possible
// for cold-launch delivery. Mirrors the connectWorkstation action's normalization.
window.__orcaConnect = (raw) => {
  try {
    let target = String(raw || '');
    if (/^orca:\/\//i.test(target)) {
      const query = target.split('?')[1] || '';
      const params = new URLSearchParams(query);
      target = params.get('ws') || params.get('url') || '';
    }
    target = normalizeWorkstationUrl(target);
    if (!target) return;
    rememberWorkstation(target);
    // Persist the scanned URL so the connect screen pre-fills it even if a re-render
    // beats the navigation — the user then just enters the pairing code.
    setPendingWorkstationUrl(target);
    // Fallback: if the connect screen is already showing, fill its input now.
    const fill = () => { const input = document.getElementById('workstation-url-input'); if (input) input.value = target; };
    fill();
    setTimeout(fill, 350);
    // Primary path: navigate straight to the workstation, which lands on the
    // pairing-code screen (the URL is just an address — pairing still needs a code).
    // Carry the theme (no color flash) + native-app flag (full-screen layout).
    window.location.assign(appendNativeFlag(appendThemeParam(target)));
  } catch { /* ignore malformed deep link */ }
};

function installNativeDeepLinkListener(attempt = 0) {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') {
    if (attempt < 50) window.setTimeout(() => installNativeDeepLinkListener(attempt + 1), 100);
    return;
  }
  listen('orca-deep-link', (event) => {
    window.__orcaConnect(event?.payload || '');
  }).catch(() => {});
}

installNativeDeepLinkListener();

// Any remote client that reaches a real workstation origin (via our connect flow,
// a QR scan, OR by typing the URL straight into a browser) records it as a known
// workstation, so it shows — checkmarked as the active one — in the switcher.
try {
  const active = activeWorkstationUrl();
  if (active) rememberWorkstation(active);
} catch { /* storage unavailable */ }

// A stable, non-secret per-device identifier. The server uses it to enforce
// "one active session per device": re-pairing the same phone/app/browser
// silently replaces its prior session instead of stacking duplicate rows. This
// is NOT a credential (the HttpOnly session cookie is) — it only labels the
// device, so localStorage is sufficient and works identically in the web app
// and inside the Tauri desktop/iOS webviews. Clearing site data = new device.
window.__orcaDeviceId = () => {
  try {
    let id = localStorage.getItem('orca.deviceId');
    if (!id) {
      id = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('orca.deviceId', id);
    }
    return id;
  } catch {
    return ''; // private mode / storage blocked: server simply skips dedup
  }
};

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
  closeRowMenu();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // The installed native app (Tauri) loads its UI from the bundle — a service
  // worker there only risks serving STALE cached UI across app updates (the
  // "I reinstalled but see no changes" bug). So in the app: never register one,
  // and actively tear down any SW + caches a previous build left behind.
  if (window.__TAURI__) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
    if (window.caches && caches.keys) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
    return;
  }
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
  if (event.target.id === 'update-project-links-form') {
    await handleAddProjectQuickLink(formEvent);
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
    const form = event.target.form;
    repopulateExecutorScopedControls(form);
    enhanceSelects(form); // refresh the custom dropdowns for the rebuilt options
    // Switching agent auto-picks that agent's default model (like the terminal)
    // and refreshes the "{model} {reasoning}" label next to send.
    const modelField = form.querySelector('input[name="model"]');
    if (modelField) modelField.value = defaultModelFor(event.target.value) || '';
    const laneAgent = document.querySelector('#create-lane-form select[name="executorType"]');
    if (laneAgent && laneAgent.value !== event.target.value) {
      laneAgent.value = event.target.value;
      renderLaneExecutorGuidance(laneAgent.form);
    }
    refreshConfigLabel(form);
  }
  if (event.target && event.target.id === 'composer-file-input') {
    const files = event.target.files;
    const rawId = event.target.dataset.sessionId;
    event.target.value = '';
    if (rawId) {
      // Attaching to a draft "New chat" promotes it to a real session first.
      Promise.resolve(ensureRealSession(rawId)).then((sid) => { if (sid) uploadComposerFiles(sid, files); });
    }
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
  if (sidebarSwipeState?.targetGroup) sidebarSwipeState.targetGroup.classList.remove('is-pressing');
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
    // A modal overlay (e.g. the New Project file picker) sits above the sidebar —
    // interacting with it must NOT hide the panel behind it. This pointerdown path
    // was the REAL cause of the picker collapsing the left panel (the click-handler
    // guard alone wasn't enough).
    && !event.target?.closest?.('.modal-overlay')
    // The row context menu is appended to <body> (outside .ops-sidebar) but is part
    // of the sidebar interaction — tapping its items must NOT close the drawer +
    // menu on pointerdown, which would destroy the menu before the click runs the
    // action (rename/archive/new-session silently did nothing on touch).
    && !event.target?.closest?.('.row-menu')
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
  // Immediate, smooth press feedback (replaces the laggy native tap highlight).
  group.classList.add('is-pressing');
  sidebarLongPressOpened = false;
  sidebarLongPressTimer = setTimeout(() => {
    closeSidebarActionMenus();
    group.classList.remove('is-pressing');
    // Long-press opens the same context menu as the 3-dot trigger, anchored at
    // the touch point so it sits under the finger.
    const trigger = group.querySelector('.sidebar-menu-btn');
    if (trigger) {
      const sx = sidebarSwipeState?.startX ?? trigger.getBoundingClientRect().right;
      const sy = sidebarSwipeState?.startY ?? trigger.getBoundingClientRect().bottom;
      openRowMenuFromTrigger(trigger, { right: sx + 6, left: sx, top: sy, bottom: sy + 4 });
    }
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
    // It's a scroll/swipe, not a press — drop the press feedback immediately.
    sidebarSwipeState.targetGroup?.classList.remove('is-pressing');
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

// Long-pressing a sidebar row should bring up ONLY our row menu — never the
// browser/iOS native callout (link preview, copy, text selection). Suppress the
// context menu on the rows; -webkit-touch-callout:none in CSS covers the iOS peek.
document.addEventListener('contextmenu', (event) => {
  if (event.target?.closest?.('.sidebar-project-line, .sidebar-session-line')) {
    event.preventDefault();
  }
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
  // A modal overlay (e.g. the custom New Project file picker) sits ABOVE everything.
  // Clicking inside it must NOT be treated as "tapped outside the nav" and collapse
  // the side panel behind it — the picker owns the interaction until dismissed.
  const inModal = event.target?.closest?.('.modal-overlay');

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

  const inRowMenu = event.target?.closest?.('.row-menu');
  if (isMobileLayout() && document.body.classList.contains('nav-open') && !inSidebar && !inTopbar && !inModal && !inRowMenu) {
    closeMobileNavPanel();
  }
  if (!inSidebar && !inModal && !inRowMenu) {
    closeSidebarActionMenus();
  }

  // Project/session 3-dot trigger → toggle the floating row context menu. A second
  // click of the same trigger closes it (rather than close-then-reopen). Its items
  // carry data-action so the existing handlers run when chosen.
  if (action === 'openProjectMenu' || action === 'openSessionMenu') {
    if (isRowMenuOpenFor(actionTarget)) closeRowMenu();
    else openRowMenuFromTrigger(actionTarget);
    return;
  }

  if (['browseWorkstation', 'workstationOpenDir', 'workstationUseDir', 'workstationPickerClose'].includes(action)) {
    await handleWorkstationPicker(actionTarget);
    return;
  }

  if (action === 'newSession') {
    await handleNewSession({ currentTarget: actionTarget });
    // Right UX: a new chat navigates to the draft, so close the mobile drawer (and
    // any row menu) — land the user on the new chat, not the project list.
    closeMobileNavPanel();
    closeRowMenu();
    return;
  }
  if (action === 'newProject') {
    await handleNewProject(actionTarget);
    return;
  }

  if (action === 'setTheme') {
    setThemePref(actionTarget?.dataset?.themeMode || 'system');
    render(captureContentUiState());
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

  if (action === 'openSettings') {
    shell.lastWorkspaceHref = `${window.location.pathname || '/'}${window.location.search || ''}${window.location.hash || ''}` || '/';
    safeNavigate('/#system');
    closeMobileNavPanel();
    return;
  }

  if (action === 'settingsBack') {
    safeNavigate(shell.lastWorkspaceHref || '/');
    closeMobileNavPanel();
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

  if (['stopLane', 'retryLane', 'restartLane', 'auditLane', 'overrideAcceptAudit', 'deleteLane', 'markCritiqueDone', 'waiveCritique', 'captureEvidence', 'clearEvidence', 'captureEvidencePreset', 'removeWorktree', 'showArtifacts'].includes(action)) {
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

  if (['auditDone', 'pauseSessionSpawning', 'stopAllLanes', 'deleteTask'].includes(action)) {
    await handleSessionActions({ currentTarget: actionTarget });
    return;
  }

  if (action === 'composerMic') {
    toggleComposerDictation(actionTarget);
    return;
  }

  if (action === 'openProjectSettings' || action === 'openSessionSettings') {
    const scope = action === 'openProjectSettings' ? 'project' : 'session';
    const id = scope === 'project' ? actionTarget.dataset.projectId : actionTarget.dataset.sessionId;
    const name = scope === 'project' ? actionTarget.dataset.projectName : actionTarget.dataset.sessionName;
    closeRowMenu();
    await openScopedSettingsDialog({ scope, id, name });
    return;
  }

  if ([
    'setApiToken',
    'clearApiToken',
    'connectWorkstation',
    'forgetWorkstation',
    'copyPhoneUrl',
    'createPairingCode',
    'deleteSessionPermanent',
    'deleteProjectPermanent',
    'connectDesktopApp',
    'connectSupervisorApp',
    'copyDesktopConfig',
    'copySupervisorConfig',
    'supervisorAudit',
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
    'archiveSession',
    'archiveProject',
    'restoreProject',
    'restoreSession',
    'renameProject',
    'renameSession',
    // These are handled in handleSystemActions but were missing from the
    // dispatch allowlist, so their buttons (incl. agent approve/deny) silently
    // did nothing. Wire them up.
    'approveApproval',
    'denyApproval',
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
    'setupTailscaleServe',
    'disableTailscaleServe',
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
});

document.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const navCard = event.target?.closest?.('[data-href]');
  if (!navCard || !navCard.dataset.href) return;
  event.preventDefault();
  safeNavigate(navCard.dataset.href);
});

// Single source of truth for the chat composer: mirror every keystroke into
// shell.composerDrafts so the draft survives ANY re-render. renderSession
// rehydrates the textarea from this map, so a poll/SSE/structural rebuild can
// never wipe what the operator is typing. (Architectural fix — drafts must not
// live only in the DOM.)
document.addEventListener('input', (event) => {
  const field = event.target;
  if (!field || field.name !== 'message') return;
  const form = field.closest?.('#orchestrator-message-form');
  const sessionId = form?.dataset?.sessionId;
  if (sessionId) shell.composerDrafts[sessionId] = field.value;
});

// Enter sends the chat message; Shift+Enter inserts a newline.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  const field = event.target;
  if (!field || field.name !== 'message') return;
  const form = field.closest?.('#orchestrator-message-form');
  if (!form) return;
  event.preventDefault();
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
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
initDropdowns();
initComposerConfig();
initComposerContext();
initSlashCommands();
initTheme();
// Tag the body for the native app (mirrors data-native set pre-paint on <html> by
// theme-init.js) so any body-scoped styling/JS can key off it too.
document.body.classList.toggle('is-native-app', isNativeApp());
// Hide the composer mic when the browser has no SpeechRecognition (e.g. Safari / iOS).
if (!voiceSupported()) document.body.classList.add('no-voice');
initMobileShell();
renderMobileManifest();
setupSidebarReorder();
// Live countdown for one-time pairing codes (ticks every second; never touched by
// the poll re-render so it stays smooth, and flips to an expired prompt at 0).
setInterval(() => {
  // Only does work while a one-time code is actually on screen — otherwise this
  // 1s tick would run a global querySelectorAll forever. Also pause when hidden.
  if (!shell.lastPairing) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  // Drop an expired one-time code so a stale code is never left on screen.
  if (shell.lastPairing?.expiresAt && new Date(shell.lastPairing.expiresAt).getTime() - Date.now() <= 0) {
    shell.lastPairing = null;
    render();
    return;
  }
  document.querySelectorAll('.pairing-countdown[data-expires]').forEach((el) => {
    const ms = new Date(el.dataset.expires).getTime() - Date.now();
    if (!Number.isFinite(ms)) return;
    if (ms <= 0) {
      el.textContent = 'Expired — create a new code';
      el.classList.add('expired');
      return;
    }
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, '0');
    el.textContent = `Expires in ${m}:${s}`;
    el.classList.toggle('soon', total <= 30);
  });
}, 1000);
// Connect the live SSE stream only after the initial load settles. A persistent
// SSE connection would otherwise keep the page from ever reaching "network idle"
// (used by automated checks); the polling timer covers this short window.
startPolling();
// refresh() no longer fetches /api/auth/sessions (syncAuthSessions owns it), so do
// one explicit sync on startup to populate the paired-device list immediately —
// the SSE snapshot (on connect) + foreground + pairing fast-poll keep it fresh after.
refresh().then(() => window.setTimeout(connectEventStream, 1200)).catch(() => {});
syncAuthSessions().catch(() => {});
