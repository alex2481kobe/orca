// Render view module (split from render-views.js).

import { formatMeta, formatRelative, safeAttr, safeText, stateBadge } from './format.js';
import { executorCapabilitiesFor, isLiveLaneState, isRestartableLaneState, laneDetailRoute, renderExecutorCapabilities, pendingAuditsForSession } from './render-helpers.js';
import { activeOrchestratorLaneForSession, intelligenceOptionsFor, renderAgentEventTimeline, runModeOptionsFor } from './render-fragments.js';
import { shell } from './state.js';
import { renderAlert, writeHtml } from './dom.js';
import { api } from './api.js';
import { apiProviderOptions, cliExecutorOptions, normalizeExecutorType, defaultExecutorType, anyCliInstalled, defaultModelFor } from './executor.js';
import { renderComposerConfig } from './composer-config.js';

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

// Volatile chat content only (messages + approvals). Rendered into the stable
// #chat-thread-<id> mount so a new message updates ONLY the thread — the composer,
// info panel, sidebar, and topbar are never rebuilt by a chat update.
export function renderChatThreadInner(session) {
  const thread = session.orchestratorThread || {};
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const lane = activeOrchestratorLaneForSession(session);
  const hasActivity = Boolean(lane && ((Array.isArray(lane.agentEvents) && lane.agentEvents.length) || lane.agentEventCount));
  const messageRows = messages.slice(-50).map((message) => {
    const role = String(message.role || 'system').toLowerCase();
    const isUser = role === 'user';
    // The canned "Started … orchestrator lane" stub is superseded by the live
    // transcript rendered below, so hide it once real activity exists.
    if (!isUser && hasActivity && /orchestrator lane/i.test(message.content || '')) return '';
    return `
      <div class="msg msg-${isUser ? 'user' : 'assistant'}">
        <div class="msg-body">${safeText(message.content || '')}</div>
      </div>
    `;
  }).join('');
  // Live transcript: the orchestrator agent's actual work — the tools it runs and
  // its streamed output — updating in place as agentEvents arrive (poll/SSE), so
  // the chat shows thinking/tool-use/output like the Codex app instead of a stub.
  let activity = '';
  if (hasActivity) {
    const working = isLiveLaneState(lane.state);
    activity = `
      <div class="msg msg-assistant">
        <div class="msg-body">
          <div class="chat-activity">
            ${working ? '<div class="chat-activity-status"><span class="chat-spinner" aria-hidden="true"></span>Working…</div>' : ''}
            ${renderAgentEventTimeline(lane, { limit: 80 })}
          </div>
        </div>
      </div>`;
  }
  // Codex-style hero for a fresh chat: "What should we build in {project}?"
  const project = (shell.projects || []).find((p) => p.id === session.projectId);
  const heroName = project?.name || session.name || 'this project';
  const emptyState = `
    <div class="chat-empty">
      <h2>What should we build in ${safeText(heroName)}?</h2>
    </div>`;
  return `${messageRows || emptyState}${activity}${renderSessionApprovals(session)}`;
}

// Stable chat-column skeleton: an EMPTY thread mount + the composer. The thread is
// filled separately via writeHtml(#chat-thread-<id>) so this skeleton stays
// byte-identical across chat updates and is skipped by skip-if-identical.
export function renderOrchestratorConsole(session) {
  const thread = session.orchestratorThread || {};
  const activeLane = activeOrchestratorLaneForSession(session);
  // Default to an INSTALLED agent (the chosen leader if installed, else the first
  // installed CLI). Uninstalled agents still appear in the dropdown, greyed out.
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  // Once a session has traffic it's locked to the agent it started with; before
  // that, default to an installed agent.
  const locked = messages.length > 0;
  const selectedExecutor = locked
    ? normalizeExecutorType(thread.executorType || session.leader || 'codex')
    : defaultExecutorType(thread.executorType || session.leader);
  // Reflect the active lane's settings ONLY when that lane is the same agent;
  // otherwise show the selected agent's own defaults (fixes e.g. codex showing
  // claude's 'opus' because a prior lane used it).
  const laneMatches = activeLane && normalizeExecutorType(activeLane.executorType || '') === selectedExecutor;
  const selectedModel = (laneMatches && activeLane.model) ? activeLane.model : defaultModelFor(selectedExecutor);
  const selectedRunMode = (laneMatches && activeLane.permissionsProfile) || 'auto-edit';
  const selectedIntelligence = (laneMatches && activeLane.intelligenceProfile) || 'high';
  return `
    <article class="chat">
      <div class="chat-thread" id="chat-thread-${safeAttr(session.id)}"></div>
      <form id="orchestrator-message-form" data-session-id="${safeAttr(session.id)}" class="composer composer-shell">
        <div id="composer-attachments-${safeAttr(session.id)}" class="composer-attachments">${renderComposerAttachmentChips(session.id)}</div>
        <textarea name="message" rows="1" placeholder="Do anything"></textarea>
        <div class="slash-menu" role="listbox" hidden></div>
        <input type="file" id="composer-file-input" data-session-id="${safeAttr(session.id)}" multiple hidden />
        <input type="hidden" name="model" value="${safeAttr(selectedModel)}" />
        <input type="hidden" name="intelligenceProfile" value="${safeAttr(selectedIntelligence)}" />
        <input type="hidden" name="speed" value="standard" />
        <input type="hidden" name="branch" value="" />
        <div class="composer-bar">
          <button class="composer-attach" data-action="pickAttachment" data-session-id="${safeAttr(session.id)}" type="button" title="Attach screenshot or document" aria-label="Attach file">
            <svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4.5v11M4.5 10h11"/></svg>
          </button>
          <select name="executorType" class="composer-select" aria-label="Agent"${locked ? ' disabled' : ''}>
            ${cliExecutorOptions(selectedExecutor)}
            ${apiProviderOptions()}
            ${anyCliInstalled() ? '' : `<option value="mock"${normalizeExecutorType(selectedExecutor) === 'mock' ? ' selected' : ''}>mock</option>`}
          </select>
          <select name="permissionsProfile" class="composer-select" aria-label="Mode">
            ${runModeOptionsFor(selectedExecutor, selectedRunMode)}
          </select>
          <span class="composer-spacer"></span>
          ${renderComposerConfig(selectedExecutor, { model: selectedModel, intelligence: selectedIntelligence, speed: 'standard' })}
          <button class="composer-send" type="submit" aria-label="Send message">
            <svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15.5V5M5.5 9.5L10 5l4.5 4.5"/></svg>
          </button>
        </div>
        <div class="composer-context" id="composer-context-${safeAttr(session.id)}"></div>
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
          ${intelligenceOptionsFor(lane.executorType, lane.intelligenceProfile || 'high')}
        </select>
        <select name="permissionsProfile" aria-label="Mode">
          ${runModeOptionsFor(lane.executorType, lane.permissionsProfile || 'plan')}
        </select>
        <button type="submit">Save</button>
      </form>
      <div class="lane-row">
        ${stopButton}
        ${restartButton}
        <a class="secondary" href="${safeAttr(lane.route || '#')}">Open</a>
      </div>
      <details class="disclosure compact-disclosure" data-uikey="activity-${safeAttr(lane.id)}">
        <summary>Activity</summary>
        ${latestEvents}
      </details>
    </article>
  `;
}

// Volatile executor-lane list only (states + relative times). Rendered into the
// stable #executor-list-<id> mount so a lane-state tick updates ONLY this list,
// not the goal/plan or new-lane forms the operator may be editing.
export function executorLanesForSession(session) {
  return shell.lanes
    .filter((lane) => lane.sessionId === session.id && lane.owner !== 'orchestrator')
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

export function renderExecutorListInner(session) {
  const executorLanes = executorLanesForSession(session);
  return executorLanes.map(renderExecutorLanePanelItem).join('') || '<div class="muted tiny">No executor lanes yet.</div>';
}

export function renderExecutorSidePanel(session) {
  const executorLanes = executorLanesForSession(session);
  const pendingAudits = pendingAuditsForSession(session.id);
  const agentOptions = `<option value="mock">mock</option>${cliExecutorOptions()}${shell.executorProfiles?.cli ? '<option value="cli">cli</option>' : ''}${apiProviderOptions()}`;
  return `
    <aside class="info-panel" aria-label="Session info">
      <div class="info-panel-head">
        <strong>Session</strong>
        <button class="info-close" data-action="toggleExecutorPanel" type="button" aria-label="Close panel">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>
        </button>
      </div>
      <div class="info-panel-body">
        <section class="info-section">
          <h4 class="info-title">Goal &amp; plan</h4>
          <form id="session-plan-form" data-session-id="${safeAttr(session.id)}">
            <label>Goal
              <input name="goal" value="${safeAttr(session.goal || '')}" placeholder="What are we trying to achieve?" />
            </label>
            <label>Plan
              <textarea name="plan" rows="3" placeholder="Steps / approach">${safeText(session.plan || '')}</textarea>
            </label>
            <button class="secondary" data-action="saveSessionPlan" type="button">Save</button>
          </form>
        </section>

        <section class="info-section">
          <h4 class="info-title">Executors <span class="info-count">${safeText(executorLanes.length)}</span></h4>
          <div class="executor-panel-list" id="executor-list-${safeAttr(session.id)}"></div>
        </section>

        <section class="info-section">
          <details class="info-disclosure">
            <summary><span class="info-title">New lane</span><span class="info-disclosure-add">+</span></summary>
          <form id="create-lane-form" data-session-id="${safeAttr(session.id)}">
            <label>Title
              <input name="title" required placeholder="What should this lane do?" />
            </label>
            <label>Task
              <textarea name="taskDescription" rows="2" placeholder="Describe the work"></textarea>
            </label>
            <label>Agent
              <select name="executorType">${agentOptions}</select>
            </label>
            <div id="lane-command-guidance" class="tiny muted"></div>
            <label>Mode
              <select name="permissionsProfile">${runModeOptionsFor('mock', 'plan')}</select>
            </label>
            <details class="disclosure compact-disclosure">
              <summary><span>Advanced</span></summary>
              <div class="disclosure-body">
                <label>Task prompt
                  <textarea name="taskPrompt" rows="2" placeholder="Drives Codex/Claude/API when no explicit command"></textarea>
                </label>
                <label>Command
                  <input name="command" placeholder="e.g., codex run --help" />
                </label>
                <label>Command args
                  <input name="commandArgs" placeholder="quoted or tokenized args" />
                </label>
                <label>Executor binary
                  <input name="executorBinary" placeholder="codex, claude, node, ./scripts/run.sh" />
                </label>
                <label>Working directory
                  <input name="workdir" placeholder="workspace-relative or absolute path" />
                </label>
                <label>Model
                  <input name="model" placeholder="leave blank for the CLI default" />
                </label>
                <label>Intelligence
                  <select name="intelligenceProfile">${intelligenceOptionsFor('mock', 'high')}</select>
                </label>
                <label>Target URL
                  <input name="targetUrl" placeholder="blank → the agent detects it" />
                </label>
                <label>Verification command
                  <input name="verificationCommand" placeholder="blank → the agent learns it" />
                </label>
                <label>Branch
                  <input name="branch" placeholder="feature/auth-cleanup" />
                </label>
                <label>MCP tools
                  <select name="mcpToolIds" multiple size="3" data-mcp-picker="1"></select>
                </label>
                <input type="hidden" name="mcpToolIdsRaw" />
              </div>
            </details>
            <button type="submit">Queue lane</button>
          </form>
          </details>
        </section>

        <section class="info-section">
          <h4 class="info-title">Tools</h4>
          <div class="info-tools">
            <button class="secondary" data-action="auditDone" data-session-id="${safeAttr(session.id)}" type="button">Audit done lanes${pendingAudits.length ? ` (${pendingAudits.length})` : ''}</button>
            <button class="secondary" data-action="refresh" type="button">Refresh</button>
          </div>
        </section>
      </div>
    </aside>
  `;
}
