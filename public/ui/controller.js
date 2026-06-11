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
let _pairingAcceptedTimer = null;
let _lastAuthSyncAt = 0;
let _lastCliInfoAt = 0;

// Force the next refresh to re-probe CLI versions (after a manual refresh/reinstall).
export function invalidateCliInfo() { _lastCliInfoAt = 0; }
// Monotonic request ordering for auth-session fetches. Both refresh() and
// syncAuthSessions() write shell.authSessions; a SLOW refresh can hold a STALE
// snapshot (fetched before a device paired) and apply it LATE, clobbering the
// fresher list — making a valid paired device row vanish until the next sync. We
// stamp each fetch at send time and only apply a response if it's the newest sent.
let _authReqCounter = 0;
let _authAppliedReq = 0;

// A stable signature of the paired-device list. Keyed on each session's identity
// (id + active + label + expiry), NOT just the COUNT — re-pairing the SAME device
// revokes the old session and mints a new one, so the count is unchanged but the
// ids differ; a count-only check missed that and left the workstation stale until
// the slow SSE-fallback poll (the "10-20s after pairing" lag when re-testing with
// one phone). null when the list hasn't loaded yet.
function sessionsSignature(list) {
  if (!Array.isArray(list)) return null;
  return list
    .map((s) => `${s.id || ''}:${s.active !== false ? 1 : 0}:${s.label || ''}:${s.expiresAt || ''}`)
    .sort()
    .join('|');
}

// Apply a freshly fetched auth-session list to shell state + handle the one-time
// pairing-code "Device paired ✓" flash. Returns true if the device list changed
// in ANY render-affecting way (new/removed/replaced device, or the pairing code
// was just consumed), so the caller can render immediately. Pure: no fetch, no render.
function applyAuthSessions(sessions) {
  const prevSig = sessionsSignature(shell.authSessions);
  shell.authSessions = sessions;
  const nextSig = sessionsSignature(shell.authSessions);
  let consumedNow = false;
  // Show "Device paired ✓" ONLY when the specific one-time code THIS workstation
  // created has actually been consumed — i.e. an active session now exists whose
  // pairedFromId matches our code's id. That is the real signal that the phone
  // completed pairing. NEVER infer it from device-count changes: a stale baseline
  // (e.g. authSessions not loaded yet when the code was created) made it falsely
  // claim "paired" the instant a code was created, with no device involved.
  if (shell.lastPairing && shell.lastPairing.id) {
    const consumed = Array.isArray(sessions)
      && sessions.some((s) => s && s.active !== false && s.pairedFromId === shell.lastPairing.id);
    if (consumed) {
      consumedNow = true;
      shell.lastPairing = null;
      shell.pairingAccepted = { at: Date.now() };
      if (_pairingAcceptedTimer) clearTimeout(_pairingAcceptedTimer);
      _pairingAcceptedTimer = setTimeout(() => {
        _pairingAcceptedTimer = null;
        shell.pairingAccepted = null;
        render(captureContentUiState());
      }, 3500);
    }
  }
  // Render when the list actually changed OR the pairing code was just consumed
  // (the latter clears the on-screen code + shows "Device paired ✓", which must
  // paint even on a same-device re-pair where the signature is otherwise equal).
  return consumedNow || (prevSig !== null && nextSig !== prevSig);
}

// Lightweight, standalone sync of JUST the paired-device list — one cheap call,
// NOT gated by refreshInFlight. Decoupled from the heavy serialized refresh() so a
// remote pairing/revocation reflects on the workstation within ~1s even while a
// slow full refresh is mid-flight (the cause of the ~7-10s pairing lag). Driven by
// SSE `update` events and a fast poll tick.
export async function syncAuthSessions() {
  // No in-flight guard: a slow/stuck fetch must NOT block the next sync (that caused
  // a paired device to not appear until a delayed earlier fetch resolved). The
  // monotonic request counter below makes concurrent fetches safe — only the
  // newest-sent result is applied, so an out-of-order/stale response is dropped.
  _lastAuthSyncAt = Date.now();
  const myReq = ++_authReqCounter;
  try {
    const resp = await api('/api/auth/sessions');
    if (!resp || !resp.ok || !Array.isArray(resp.data?.sessions)) return;
    if (myReq <= _authAppliedReq) return; // a newer fetch already applied; this is stale
    _authAppliedReq = myReq;
    if (applyAuthSessions(resp.data.sessions) && !isEditingContent()) {
      render(captureContentUiState());
    }
  } catch { /* transient; the next tick retries */ }
}

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
    const abortFromAuth = (response) => abortRefreshFromUnauthorized(response, requestId, uiState);
    const authResp = await api('/api/auth/status');
    // status 0 = the fetch itself failed (connection refused / DNS) — the Orca
    // server isn't reachable (not running, or the workstation is offline for a
    // remote device). Show a calm "not running" screen instead of a degraded shell,
    // and keep existing shell data so recovery is instant when it comes back. The
    // poll keeps ticking, so this clears automatically once the server responds.
    if (authResp.status === 0) {
      shell.serverUnreachable = true;
      render(captureContentUiState());
      return;
    }
    shell.serverUnreachable = false;
    if (abortFromAuth(authResp)) return;
    if (authResp.ok && authResp.data) {
      shell.authStatus = authResp.data;
    }
    if (browserAccessBlocked()) {
      clearProtectedWorkspaceState();
      render(captureContentUiState());
      return;
    }
    // Everything except the auth gate is fetched IN PARALLEL, and the dashboard is
    // painted as soon as projects/sessions/lanes are in. The slow CLI version checks
    // (shell-outs, seconds each) run AFTER paint. This replaced 19 SEQUENTIAL awaits
    // (with the CLI shell-outs and the projects fetch dead last) that made a
    // reconnect / pairing reflection take 15-20s.
    const firstUnauthorized = (responses) => responses.find((r) => r && r.status === 401);
    // NOTE: /api/auth/sessions is NOT fetched here — syncAuthSessions() owns it
    // (driven by SSE snapshot/update, foreground, the pairing fast-poll, and a
    // startup call) so we don't fetch it twice per cycle.
    const [policyResp, settingsResp, notificationsResp, blockersResp, privateAccessResp,
      profilesResp, captureResp, providersResp, cleanupResp, mcpResp,
      pendingAuditResp, archiveResp, supervisorResp, projectsResp] = await Promise.all([
      api('/api/policy'),
      api('/api/settings/effective'),
      api('/api/notifications'),
      api('/api/system/blockers'),
      api('/api/private-access'),
      api('/api/executors/profiles'),
      api('/api/capture/status'),
      api('/api/providers'),
      api('/api/artifacts/cleanup/schedule'),
      api('/api/mcp/tools'),
      api('/api/audit/events?status=pending'),
      api('/api/archive'),
      api('/api/supervisor/overview'),
      api('/api/projects'),
    ]);
    if (requestId !== refreshRequestId) return;
    if (abortFromAuth(firstUnauthorized([policyResp, settingsResp, notificationsResp, blockersResp,
      privateAccessResp, profilesResp, captureResp, providersResp, cleanupResp,
      mcpResp, pendingAuditResp, archiveResp, supervisorResp, projectsResp]))) return;
    if (policyResp.ok && policyResp.data) shell.policy = policyResp.data.policies;
    if (settingsResp.ok && settingsResp.data) shell.effectiveSettings = settingsResp.data;
    if (notificationsResp.ok && notificationsResp.data) { shell.notifications = notificationsResp.data; maybeShowBrowserNotifications(); }
    if (blockersResp.ok && Array.isArray(blockersResp.data?.blockers)) shell.systemBlockers = blockersResp.data.blockers;
    if (privateAccessResp.ok && privateAccessResp.data) shell.privateAccess = privateAccessResp.data;
    if (profilesResp.ok && profilesResp.data?.profiles) shell.executorProfiles = profilesResp.data.profiles;
    if (captureResp.ok && captureResp.data) shell.captureStatus = captureResp.data;
    if (providersResp.ok && providersResp.data) shell.providerCatalog = providersResp.data;
    if (cleanupResp.ok && cleanupResp.data?.schedule) shell.cleanupSchedule = cleanupResp.data.schedule;
    if (mcpResp.ok && Array.isArray(mcpResp.data)) shell.mcpTools = mcpResp.data;
    if (pendingAuditResp.ok && Array.isArray(pendingAuditResp.data)) shell.pendingAuditEvents = pendingAuditResp.data;
    if (archiveResp.ok && archiveResp.data) shell.archive = archiveResp.data;
    if (supervisorResp.ok && supervisorResp.data) shell.supervisorOverview = supervisorResp.data;
    // Projects -> sessions -> lanes (sessions per project + all lanes in parallel).
    if (projectsResp.ok && Array.isArray(projectsResp.data)) {
      const nextProjects = projectsResp.data;
      const sessionResponses = await Promise.all(nextProjects.map((project) => api(`/api/projects/${project.id}/sessions`)));
      if (requestId !== refreshRequestId) return;
      if (abortFromAuth(firstUnauthorized(sessionResponses))) return;
      const sessionsComplete = sessionResponses.every((r) => r.ok && Array.isArray(r.data));
      const allSessions = sessionResponses.flatMap((r) => (r.ok && Array.isArray(r.data) ? r.data : []));
      let allLanes = shell.lanes;
      let lanesComplete = false;
      if (sessionsComplete) {
        const laneResponses = await Promise.all(allSessions.map((session) => api(`/api/sessions/${session.id}/lanes`)));
        if (requestId !== refreshRequestId) return;
        if (abortFromAuth(firstUnauthorized(laneResponses))) return;
        lanesComplete = laneResponses.every((r) => r.ok && Array.isArray(r.data));
        if (lanesComplete) allLanes = laneResponses.flatMap((r) => r.data);
      }
      shell.projects = nextProjects;
      if (sessionsComplete && lanesComplete) {
        shell.sessions = allSessions;
        shell.lanes = allLanes;
        // The list carries only a 20-event tail (no logs). Fetch the FULL lane
        // (all logs + agentEvents) ONLY for the lane(s) the user is looking at:
        // the open lane-detail route + the open session's active orchestrator lane
        // (the live console needs the full 80-120 timeline + logs). One fetch each.
        const focusedLaneIds = new Set();
        if (shell.route.laneId) focusedLaneIds.add(shell.route.laneId);
        if (shell.route.sessionId) {
          const openSession = allSessions.find((s) => s.id === shell.route.sessionId);
          const activeLane = openSession ? activeOrchestratorLaneForSession(openSession) : null;
          if (activeLane && activeLane.id) focusedLaneIds.add(activeLane.id);
        }
        if (focusedLaneIds.size) {
          const ids = [...focusedLaneIds];
          const detailResponses = await Promise.all(ids.map((id) => api(`/api/lanes/${encodeURIComponent(id)}`)));
          if (requestId !== refreshRequestId) return;
          for (const resp of detailResponses) {
            if (resp.ok && resp.data && resp.data.id) {
              const idx = shell.lanes.findIndex((l) => l.id === resp.data.id);
              if (idx >= 0) shell.lanes[idx] = resp.data; // full lane replaces the compact one
            }
          }
        }
        // Backlog roll-up for the OPEN session only (one cheap fetch) — powers the
        // session backlog panel without scanning tasks for every session each poll.
        if (shell.route.sessionId) {
          const backlogResp = await api(`/api/sessions/${encodeURIComponent(shell.route.sessionId)}/backlog`);
          if (requestId !== refreshRequestId) return;
          if (backlogResp.ok && backlogResp.data) {
            shell.backlogs = shell.backlogs || {};
            shell.backlogs[shell.route.sessionId] = backlogResp.data;
          }
        }
      }
    }
    if (requestId !== refreshRequestId) return;
    // Paint the dashboard NOW (capture ephemeral UI state right before render).
    render(captureContentUiState());

    // Slow CLI version checks (shell-outs) run AFTER paint, in parallel — and only
    // at most once a minute, NOT every poll. CLI versions change only on (re)install,
    // so re-probing every 1-3s was pure waste (N requests + a second render each
    // cycle). A forced refresh (refreshExecutorCli action) resets _lastCliInfoAt.
    const cliStale = !shell.executorCliInfo || (Date.now() - _lastCliInfoAt) > 60000;
    if (cliStale && shell.executorProfiles && typeof shell.executorProfiles === 'object') {
      const types = Object.keys(shell.executorProfiles);
      const cliResponses = await Promise.all(types.map((t) => api(`/api/executors/${encodeURIComponent(t)}/cli`)));
      if (requestId !== refreshRequestId) return;
      if (abortFromAuth(firstUnauthorized(cliResponses))) return;
      const cliInfo = {};
      types.forEach((t, i) => { if (cliResponses[i].ok && cliResponses[i].data) cliInfo[t] = cliResponses[i].data; });
      shell.executorCliInfo = cliInfo;
      _lastCliInfoAt = Date.now();
      if (requestId !== refreshRequestId) return;
      render(captureContentUiState());
    }
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
      // Foregrounded (e.g. reopened the app): reopen the stream, sync the paired
      // list INSTANTLY (cheap, decoupled) so a device that paired/dropped while we
      // were away shows at once, and kick a full refresh for everything else.
      _streamPausedForVisibility = false;
      if (_reopenStream) _reopenStream();
      syncAuthSessions();
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
    // On any live event, sync the paired-device list IMMEDIATELY (cheap, ungated)
    // for instant pairing/revoke reflection, AND schedule the (debounced, heavier)
    // full refresh for everything else.
    const onStreamEvent = () => { syncAuthSessions(); scheduleStreamRefresh(); };
    es.addEventListener('update', onStreamEvent);
    es.addEventListener('snapshot', onStreamEvent);
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
    // While a pairing code is outstanding, sync the paired-device list fast (~1s),
    // INDEPENDENT of the heavy refresh (serialized + slow), so the workstation shows
    // the device the instant the phone pairs. Only while waiting — otherwise this
    // would hammer /api/auth/sessions every tick (load + never-idle network). The
    // SSE `update` event covers pair/revoke reflection the rest of the time.
    if (shell.lastPairing && Date.now() - _lastAuthSyncAt >= 1000) {
      syncAuthSessions();
    }
    // Cadence. When SSE is connected it PUSHES every change in real time —
    // EVERY agent event + log line + state transition bumps the stream revision
    // (appendLaneAgentEvent/appendLaneLog), which fires an `update` → refresh
    // within ~0.85s. So even a LIVE orchestrator console stays live via push; the
    // poll is only a safety net → 15s. A 1s FULL refresh here re-fetched the whole
    // project/session/lane tree every second and, after ~45s of live watching,
    // exhausted the read-rate budget (429s that froze the dashboard). Only when
    // SSE is DOWN do we poll fast (2s with a live console, 3s idle) for liveness.
    let cadenceMs;
    if (_activeEventSource) cadenceMs = 15000;
    else if (hasLiveOrchestratorConsole()) cadenceMs = 2000;
    else cadenceMs = 3000;
    if (Date.now() - lastRefreshAt >= cadenceMs) {
      refresh({ background: true });
    }
  }, 500);
}
