// Render view module (split from render-views.js).

import { formatMeta, formatRelative, safeAttr, safeText, stateBadge } from './format.js';
import { executorCapabilitiesFor, isLiveLaneState, isRestartableLaneState, laneDetailRoute, renderExecutorCapabilities } from './render-helpers.js';
import { activeOrchestratorLaneForSession, intelligenceOptions, modelControlOptions, renderAgentEventTimeline, runModeOptions } from './render-fragments.js';
import { shell } from './state.js';
import { renderAlert, writeHtml } from './dom.js';
import { api, currentActiveProject } from './api.js';
import { apiProviderOptions, cliExecutorOptions, normalizeExecutorType } from './executor.js';

export function renderOrchestratorTerminal(project, session, lane) {
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

export function renderApprovalRows(lane) {
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

export function renderSessionApprovals(session) {
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

export function composerAttachmentsFor(sessionId) {
  shell.composerAttachments = shell.composerAttachments || {};
  if (!Array.isArray(shell.composerAttachments[sessionId])) shell.composerAttachments[sessionId] = [];
  return shell.composerAttachments[sessionId];
}

export function renderComposerAttachmentChips(sessionId) {
  const list = composerAttachmentsFor(sessionId);
  if (!list.length) return '';
  return list.map((entry) => `
    <span class="attach-chip">${safeText(entry.name)}<button data-action="removeAttachment" data-session-id="${safeAttr(sessionId)}" data-attachment-id="${safeAttr(entry.id)}" type="button" aria-label="Remove ${safeAttr(entry.name)}">×</button></span>
  `).join('');
}

export function refreshComposerAttachments(sessionId) {
  const el = document.getElementById(`composer-attachments-${sessionId}`);
  if (el) writeHtml(el, renderComposerAttachmentChips(sessionId));
}

export function readFileAsBase64(file) {
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

export async function uploadComposerFiles(sessionId, fileList) {
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

export function renderOrchestratorConsole(session) {
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

export function renderExecutorLanePanelItem(lane) {
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

export function renderExecutorSidePanel(session) {
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
