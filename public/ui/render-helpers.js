// Small shared render helpers (state badges, policy/approval checks, pending-audit
// lookups, breadcrumb/topbar writers, agent-event labels, lane-state predicates).
// Extracted from app.js.

import { shell, refs } from './state.js';

export function laneDetailRoute(project, session, lane) {
  if (!project || !session || !lane) return '';
  return lane.route || `/projects/${project.slug}/sessions/${session.id}/lanes/${lane.id}`;
}

export function isVerificationProject(project) {
  const slug = String(project?.slug || '').toLowerCase();
  const name = String(project?.name || '').toLowerCase();
  return slug.startsWith('smoke-') || name.startsWith('smoke ');
}

export function activeHomePanel() {
  const panel = String(window.location.hash || '').replace(/^#/, '').toLowerCase();
  const allowed = new Set(['projects', 'setup', 'create', 'system', 'mcp', 'audit', 'cleanup', 'token', 'private-access', 'providers', 'effective-settings', 'notifications', 'backup', 'pair']);
  return allowed.has(panel) ? panel : 'overview';
}

export function stateTagClass(state) {
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

export function getActionPolicy(actionKey) {
  return shell.policy?.[actionKey] || { requiresApproval: false, risk: 'low', message: '' };
}

export function needsApproval(actionKey) {
  return Boolean(getActionPolicy(actionKey).requiresApproval);
}

export function confirmHighRiskAction(message, actionKey) {
  const policy = getActionPolicy(actionKey);
  if (!policy.requiresApproval) return true;
  const policyMessage = policy.message || 'This action requires explicit approval.';
  return window.confirm(`${message}\n${policyMessage}`);
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

export function isLiveLaneState(state) {
  return ['queued', 'starting', 'running'].includes(String(state || '').toLowerCase());
}

export function isRestartableLaneState(state) {
  return ['failed', 'stopped', 'fix_requested'].includes(String(state || '').toLowerCase());
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
