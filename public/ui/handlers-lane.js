// Split from handlers.js.

import { buildApprovedActionBody, toObj } from './handlers-config.js';
import { composerAttachmentsFor } from './render-session-parts.js';
import { renderAlert } from './dom.js';
import { normalizeExecutorType } from './executor.js';
import { api } from './api.js';
import { refresh } from './controller.js';
import { shell } from './state.js';
import { isLiveLaneState } from './render-helpers.js';

export async function handleOrchestratorMessage(event) {
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
  const permissionsProfile = String(payload.permissionsProfile || '').trim() || 'auto-edit';
  const speed = String(payload.speed || '').trim() || 'standard';
  const branch = String(payload.branch || '').trim();
  // Sending your own chat message IS the approval — a real chat doesn't pop a
  // confirm modal on every message. The composer already shows mode/model, so the
  // operator's send is the explicit, informed action.
  const form = event.currentTarget;
  // Optimistically clear the box immediately (and the draft store) so it feels
  // like a normal chat; restore on failure.
  const draft = message;
  shell.composerDrafts[sessionId] = '';
  const messageField = form.querySelector('textarea[name="message"]');
  if (messageField) messageField.value = '';
  const response = await api(`/api/sessions/${sessionId}/orchestrator/messages`, {
    method: 'POST',
    body: {
      message,
      executorType,
      model,
      permissionsProfile,
      intelligenceProfile,
      speed,
      branch,
      attachments,
      actor: 'dashboard',
      approved: true,
    },
  });
  if (response.ok) {
    composerAttachmentsFor(sessionId).length = 0; // clear attached files after send
    await refresh();
  } else {
    // Put the draft back so nothing is lost on error.
    shell.composerDrafts[sessionId] = draft;
    if (messageField) messageField.value = draft;
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
