// Split from handlers-actions.js.

import { refresh } from './controller.js';
import { confirmHighRiskAction, isLiveLaneState } from './render-helpers.js';
import { renderAlert } from './dom.js';
import { confirmDialog } from './dialog.js';
import { shell } from './state.js';
import { api } from './api.js';

export async function handleSessionActions(event) {
  const action = event.currentTarget.dataset.action;

  // Kill switch for a runaway auto session: stop new lanes from spawning.
  if (action === 'pauseSessionSpawning') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const approved = await confirmHighRiskAction('Pause agent spawning for this session? (sets spawn policy to "never" — running lanes keep going)', 'manageCapacity');
    if (!approved) { renderAlert('Canceled.'); return; }
    const response = await api(`/api/sessions/${sessionId}`, { method: 'PATCH', body: { actor: 'dashboard', approved, spawnPolicy: 'never' } });
    renderAlert(response.ok ? 'Spawning paused (spawnPolicy: never).' : (response.data?.error || 'Could not pause spawning.'), response.ok ? 'ok' : 'bad');
    if (response.ok) await refresh();
    return;
  }

  // Stop every live lane in the session (the "stop all agents" control).
  if (action === 'stopAllLanes') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const live = (shell.lanes || []).filter((lane) => lane.sessionId === sessionId && isLiveLaneState(lane.state));
    if (!live.length) { renderAlert('No running lanes to stop.'); return; }
    const approved = await confirmHighRiskAction(`Stop all ${live.length} running lane(s) in this session?`, 'stopLane');
    if (!approved) { renderAlert('Canceled.'); return; }
    let stopped = 0;
    for (const lane of live) {
      const r = await api(`/api/lanes/${lane.id}/stop`, { method: 'POST', body: { actor: 'dashboard', approved } });
      if (r.ok) stopped += 1;
    }
    renderAlert(`Stopped ${stopped}/${live.length} lane(s).`, stopped ? 'ok' : 'bad');
    await refresh();
    return;
  }

  // Cancel/clear a backlog task.
  if (action === 'deleteTask') {
    const taskId = event.currentTarget.dataset.taskId;
    const title = event.currentTarget.dataset.taskTitle || 'this task';
    const ok = await confirmDialog(`Delete "${title}" from the backlog?`, { danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    const response = await api(`/api/tasks/${taskId}`, { method: 'DELETE', body: { actor: 'dashboard' } });
    renderAlert(response.ok ? 'Task deleted.' : (response.data?.error || 'Could not delete task.'), response.ok ? 'ok' : 'bad');
    if (response.ok) await refresh();
    return;
  }

  if (action === 'auditDone') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const approved = await confirmHighRiskAction('Audit all completed lanes in this session?', 'auditDoneLanes');
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
