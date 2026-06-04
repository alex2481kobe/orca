// Data/refresh orchestration controller: the poll+SSE refresh loop, route
// parsing, 401 abort, artifact viewer. Holds the refresh counters. Extracted from app.js.

import { api, browserAccessBlocked, clearProtectedWorkspaceState, maybeLockFromResponse } from './api.js';
import { activeOrchestratorLaneForSession, captureContentUiState, render } from './render-views.js';
import { shell } from './state.js';
import { maybeShowBrowserNotifications } from './notifications.js';
import { safeHref } from './dom.js';
import { safeText } from './format.js';
import { isLiveLaneState } from './render-helpers.js';

let refreshRequestId = 0;
let refreshInFlight = false;
let lastRefreshAt = 0;
let _streamRefreshTimer = null;

export function parseRoute() {
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

export function abortRefreshFromUnauthorized(response, requestId, uiState) {
  if (!response || response.status !== 401) return false;
  if (requestId !== refreshRequestId) return true;
  if (maybeLockFromResponse(response)) {
    render(uiState || null);
  }
  return true;
}

function isEditingContent() {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el) return false;
  const editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
  if (!editable) return false;
  return Boolean(el.closest && el.closest('.ops-main'));
}

export async function refresh(options = {}) {
  if (refreshInFlight) return;
  // A background poll/stream refresh must not yank focus or re-render the form a
  // user is actively editing. Values are preserved on explicit renders anyway.
  if (options.background && isEditingContent()) return;
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
      // A one-time pairing code is consumed once a new device pairs: when the
      // paired-device count grows past what it was when the code was issued, drop
      // the displayed code so a used code is never shown.
      if (shell.lastPairing && typeof shell.lastPairing.pairedCountAtCreate === 'number') {
        const pairedNow = shell.authSessions.filter((s) => s && (s.paired || s.pairedFromId)).length;
        if (pairedNow > shell.lastPairing.pairedCountAtCreate) shell.lastPairing = null;
      }
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
    const archiveResp = await api('/api/archive');
    if (archiveResp.ok && archiveResp.data) {
      shell.archive = archiveResp.data;
    }
    if (requestId !== refreshRequestId) return;
    // Capture ephemeral UI state (open disclosures/popovers, focus, in-progress
    // values) RIGHT before rendering — not the `uiState` snapshot taken at the top
    // of refresh(). The await chain above can take a second+, during which the
    // user may open a popover or start typing; restoring the stale top-of-refresh
    // snapshot would slam those shut ("opens then auto-closes").
    render(captureContentUiState());
  } finally {
    refreshInFlight = false;
  }
}

export async function showArtifacts(laneId) {
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

export function hasLiveOrchestratorConsole() {
  const session = shell.sessions.find((value) => value.id === shell.route.sessionId);
  if (!session) return false;
  const lane = activeOrchestratorLaneForSession(session);
  return Boolean(lane && isLiveLaneState(lane.state));
}

export function scheduleStreamRefresh() {
  if (_streamRefreshTimer) return;
  _streamRefreshTimer = setTimeout(() => { _streamRefreshTimer = null; refresh({ background: true }); }, 150);
}

// Live-connection + poll lifecycle state. Kept at module scope so we never open a
// second EventSource, never stack reconnect timers, and never run two poll loops.
// Both the SSE stream and the poll loop pause while the tab/PWA is backgrounded —
// otherwise a phone PWA keeps a 500ms timer + a long-lived stream alive forever,
// draining battery and stacking reconnect attempts (a real leak on mobile).
let _activeEventSource = null;
let _streamRetryTimer = null;
let _streamPausedForVisibility = false;
let _pollTimer = null;
let _visibilityWired = false;
let _reopenStream = null;

function closeEventStream() {
  if (_streamRetryTimer) { clearTimeout(_streamRetryTimer); _streamRetryTimer = null; }
  if (_activeEventSource) {
    try { _activeEventSource.close(); } catch { /* ignore */ }
    _activeEventSource = null;
  }
}

function wireVisibilityPause() {
  if (_visibilityWired || typeof document === 'undefined') return;
  _visibilityWired = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Backgrounded: stop the stream and suppress reconnects until we return.
      _streamPausedForVisibility = true;
      closeEventStream();
    } else {
      // Foregrounded: reopen the stream and refresh promptly so we aren't stale.
      _streamPausedForVisibility = false;
      if (_reopenStream) _reopenStream();
      refresh({ background: true });
    }
  });
}

export function connectEventStream() {
  if (typeof EventSource === 'undefined') return;
  let retryMs = 2000;
  const open = () => {
    if (_activeEventSource) return; // already connected — never stack streams
    if (typeof document !== 'undefined' && document.hidden) return; // don't open while hidden
    let es;
    try {
      es = new EventSource('/api/streams/events');
    } catch {
      return;
    }
    _activeEventSource = es;
    es.addEventListener('update', scheduleStreamRefresh);
    es.addEventListener('snapshot', scheduleStreamRefresh);
    es.onerror = () => {
      try { es.close(); } catch { /* ignore */ }
      if (_activeEventSource === es) _activeEventSource = null;
      if (_streamPausedForVisibility) return; // intentionally paused; visibility will reopen
      // Reconnect with backoff; the polling timer keeps the UI fresh meanwhile.
      retryMs = Math.min(retryMs * 2, 30000);
      if (_streamRetryTimer) clearTimeout(_streamRetryTimer);
      _streamRetryTimer = window.setTimeout(() => { _streamRetryTimer = null; open(); }, retryMs);
    };
    es.onopen = () => { retryMs = 2000; };
  };
  _reopenStream = open;
  wireVisibilityPause();
  open();
}

export function startPolling() {
  if (_pollTimer) return; // guard against a second poll loop
  wireVisibilityPause();
  _pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return; // pause work while backgrounded
    const cadenceMs = hasLiveOrchestratorConsole() ? 1000 : 3000;
    if (Date.now() - lastRefreshAt >= cadenceMs) {
      refresh({ background: true });
    }
  }, 500);
}
