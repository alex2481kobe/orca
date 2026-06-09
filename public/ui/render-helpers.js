// Small shared render helpers (state badges, policy/approval checks, pending-audit
// lookups, breadcrumb/topbar writers, agent-event labels, lane-state predicates).
// Extracted from app.js.

import { shell, refs } from './state.js';
import { confirmDialog } from './dialog.js';
import { safeText, formatMeta } from './format.js';

export function laneDetailRoute(project, session, lane) {
  if (!project || !session || !lane) return '';
  return lane.route || `/projects/${project.slug}/sessions/${session.id}/lanes/${lane.id}`;
}

// --- Unread / "done, take a look" session indicator (the blue dot) -------------
// Per-device record of when each session was last opened. A session shows the dot
// when its latest activity (session.updatedAt or any of its lanes' updatedAt) is
// newer than that, AND no lane is currently live — so the dot means "the agent
// finished and you haven't looked", not "still working" (which the project's (N)
// count already shows). Opening a session clears it.
const SESSION_SEEN_KEY = 'orca.sessionSeen:v1';
function readSessionSeen() {
  try { return JSON.parse(window.localStorage.getItem(SESSION_SEEN_KEY) || '{}') || {}; } catch { return {}; }
}
function writeSessionSeen(map) {
  try { window.localStorage.setItem(SESSION_SEEN_KEY, JSON.stringify(map)); } catch { /* storage unavailable */ }
}
const parseTs = (value) => { const n = Date.parse(value || ''); return Number.isNaN(n) ? 0 : n; };

export function computeUnreadSessions(sessions = [], lanes = [], openSessionId = null) {
  const seen = readSessionSeen();
  const unread = new Set();
  let changed = false;
  const activityBySession = new Map();
  const liveBySession = new Set();
  for (const lane of lanes) {
    const sid = lane && lane.sessionId;
    if (!sid) continue;
    activityBySession.set(sid, Math.max(activityBySession.get(sid) || 0, parseTs(lane.updatedAt)));
    if (isLiveLaneState(lane.state)) liveBySession.add(sid);
  }
  for (const session of sessions) {
    if (!session || !session.id) continue;
    const lastActivity = Math.max(parseTs(session.updatedAt), parseTs(session.createdAt), activityBySession.get(session.id) || 0);
    const isOpen = session.id === openSessionId;
    // Opening a session, or first-observing one (so existing chats don't all light
    // up on first load), baselines it as seen up to its current activity.
    if (isOpen || !(session.id in seen)) {
      const stamp = new Date(lastActivity || Date.now()).toISOString();
      if (seen[session.id] !== stamp) { seen[session.id] = stamp; changed = true; }
      continue;
    }
    if (!liveBySession.has(session.id) && lastActivity > parseTs(seen[session.id])) {
      unread.add(session.id);
    }
  }
  if (changed) writeSessionSeen(seen);
  return unread;
}

export function isVerificationProject(project) {
  const slug = String(project?.slug || '').toLowerCase();
  const name = String(project?.name || '').toLowerCase();
  return slug.startsWith('smoke-') || name.startsWith('smoke ');
}

export function activeHomePanel() {
  const panel = String(window.location.hash || '').replace(/^#/, '').toLowerCase();
  const allowed = new Set(['projects', 'setup', 'system', 'mcp', 'audit', 'cleanup', 'token', 'private-access', 'providers', 'effective-settings', 'notifications', 'backup', 'pair']);
  return allowed.has(panel) ? panel : 'overview';
}

export function getActionPolicy(actionKey) {
  return shell.policy?.[actionKey] || { requiresApproval: false, risk: 'low', message: '' };
}

export async function confirmHighRiskAction(message, actionKey) {
  const policy = getActionPolicy(actionKey);
  if (!policy.requiresApproval) return true;
  const policyMessage = policy.message || 'This action requires explicit approval.';
  return confirmDialog(`${message}\n${policyMessage}`, { confirmLabel: 'Continue' });
}

export function pendingAuditsForLane(laneId) {
  if (!Array.isArray(shell.pendingAuditEvents)) return [];
  const target = String(laneId || '');
  if (!target) return [];
  return shell.pendingAuditEvents.filter((event) => String(event.laneId || '') === target);
}

export function pendingAuditsForSession(sessionId) {
  if (!Array.isArray(shell.pendingAuditEvents)) return [];
  const target = String(sessionId || '');
  if (!target) return [];
  return shell.pendingAuditEvents.filter((event) => String(event.sessionId || '') === target);
}

export function renderBreadcrumbs(project, session) {
  refs.breadcrumbs.innerHTML = '';
}

export function renderTopbarTitle(project, session, lane) {
  if (!refs.topbarTitle) return;
  refs.topbarTitle.textContent = 'Orca';
}

// Canonical client-side lane-lifecycle subsets. These are the single source of
// truth for "which states count as X" on the client — every view filters through
// the predicates below rather than re-spelling the arrays inline (the divergence
// the cleanup removed). (The server has its own copy under src/ because the
// public/ bundle can't import from src/worker-contract.js across that boundary.)
const LIVE_LANE_STATES = ['queued', 'starting', 'running'];
const RUNNING_LANE_STATES = ['running', 'starting'];
const RESTARTABLE_LANE_STATES = ['failed', 'stopped', 'fix_requested', 'blocked'];

export function isLiveLaneState(state) {
  return LIVE_LANE_STATES.includes(String(state || '').toLowerCase());
}

// "Live" minus queued — a lane whose process is actually up (used for the
// at-a-glance "N running" tile, distinct from the broader live/active count).
export function isRunningLaneState(state) {
  return RUNNING_LANE_STATES.includes(String(state || '').toLowerCase());
}

export function isRestartableLaneState(state) {
  return RESTARTABLE_LANE_STATES.includes(String(state || '').toLowerCase());
}

export function agentEventTone(type) {
  const normalized = String(type || '').toLowerCase();
  if (normalized.includes('failed') || normalized === 'error') return 'bad';
  if (normalized.includes('done') || normalized.includes('completed')) return 'ok';
  if (normalized.includes('stopped') || normalized.includes('queued') || normalized.includes('started')) return 'warn';
  return '';
}

export function agentEventLabel(type) {
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

export function executorCapabilitiesFor(type) {
  const info = shell.executorCliInfo || {};
  return info[String(type || '').trim()]?.capabilities || null;
}

export function capabilityList(value, fallback = 'none') {
  const list = Array.isArray(value) ? value.filter(Boolean) : [];
  return list.length ? list.join(', ') : fallback;
}

export function renderExecutorCapabilities(capabilities, { compact = false } = {}) {
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
