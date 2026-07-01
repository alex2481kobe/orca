// Split from handlers.js.

import { buildApprovedActionBody, toObj } from './handlers-config.js';
import { composerAttachmentsFor } from './render-session-parts.js';
import { renderAlert, safeNavigate } from './dom.js';
import { normalizeExecutorType } from './executor.js';
import { api } from './api.js';
import { refresh } from './controller.js';
import { shell } from './state.js';
import { isLiveLaneState } from './render-helpers.js';
import { ensureRealSession } from './handlers-create.js';

export function resolveOrchestratorExecutorType({ payload = {}, form = null, sessionId = '', fallback = '' } = {}) {
  const controlValue = form?.querySelector?.('select[name="executorType"]')?.value || '';
  const session = shell.sessions.find((item) => String(item.id) === String(sessionId));
  return normalizeExecutorType(
    payload.executorType
    || controlValue
    || fallback
    || session?.orchestratorThread?.executorType
    || session?.leader
    || 'codex',
  );
}

export async function handleOrchestratorMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  let sessionId = form.dataset.sessionId;
  const payload = toObj(form);
  const message = String(payload.message || '').trim();
  const attachments = composerAttachmentsFor(sessionId).map((entry) => ({ name: entry.name, url: entry.url }));
  if (!message && !attachments.length) {
    renderAlert('Message or attachment is required.', 'bad');
    return;
  }
  const selectedExecutorBeforePromote = resolveOrchestratorExecutorType({ payload, form, sessionId });
  // If this is a draft "New chat", create the real session now (first send) and
  // switch to it, so an untouched chat never persists but a sent one does.
  if (String(sessionId).startsWith('draft-')) {
    const draftTerminalOpen = Boolean(shell.chatTerminalOpenBySession?.[sessionId]);
    // Stash the draft text under the (about-to-exist) real id so the migration in
    // ensureRealSession carries it across, then promote.
    shell.composerDrafts[sessionId] = message;
    const realId = await ensureRealSession(sessionId, { leader: selectedExecutorBeforePromote });
    if (!realId || realId === sessionId) return; // creation failed (alert already shown)
    if (draftTerminalOpen) {
      shell.chatTerminalOpenBySession = shell.chatTerminalOpenBySession || {};
      shell.chatTerminalOpenBySession[realId] = true;
      delete shell.chatTerminalOpenBySession[sessionId];
    }
    sessionId = realId;
    const realSession = shell.sessions.find((s) => s.id === realId);
    if (realSession?.route) safeNavigate(realSession.route);
  }
  const executorType = resolveOrchestratorExecutorType({ payload, form, sessionId, fallback: selectedExecutorBeforePromote });
  const model = String(payload.model || '').trim() || String(payload.modelPreset || '').trim() || null;
  const intelligenceProfile = String(payload.intelligenceProfile || '').trim() || 'high';
  const permissionsProfile = String(payload.permissionsProfile || '').trim() || 'auto-edit';
  const speed = String(payload.speed || '').trim() || 'standard';
  const branch = String(payload.branch || '').trim();
  const executionMode = shell.chatTerminalOpenBySession?.[sessionId] ? 'terminal' : 'chat';
  // Sending your own chat message IS the approval — a real chat doesn't pop a
  // confirm modal on every message. The composer already shows mode/model, so the
  // operator's send is the explicit, informed action.
  // Optimistically clear the box immediately (and the draft store) so it feels
  // like a normal chat; restore on failure.
  const draft = message;
  shell.composerDrafts[sessionId] = '';
  const messageField = form.querySelector('textarea[name="message"]');
  if (messageField) messageField.value = '';
  const restoreDraft = () => {
    shell.composerDrafts[sessionId] = draft;
    if (messageField) messageField.value = draft;
  };
  let response;
  try {
    response = await api(`/api/sessions/${sessionId}/orchestrator/messages`, {
      method: 'POST',
      body: {
        message,
        executorType,
        model,
        permissionsProfile,
        intelligenceProfile,
        speed,
        branch,
        executionMode,
        attachments,
        actor: 'dashboard',
        approved: true,
      },
    });
  } catch {
    // Network error before any response — never lose the user's typed message.
    restoreDraft();
    renderAlert('Could not send message — check your connection and try again.', 'bad');
    return;
  }
  if (response.ok) {
    composerAttachmentsFor(sessionId).length = 0; // clear attached files after send
    await refresh();
  } else {
    // Put the draft back so nothing is lost on error.
    restoreDraft();
    renderAlert(response.data?.error || 'Could not send message.', 'bad');
  }
}

export async function handleLaneControlsUpdate(event) {
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
  const approval = await buildApprovedActionBody(
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

export async function handleAuditEventAction(event) {
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
