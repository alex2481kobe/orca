// Render view module (split from render-views.js).

import { formatRelative, safeAttr, safeText, stateBadge } from './format.js';
import { isLaneStoppable, isLiveLaneState, isRestartableLaneState, pendingAuditsForSession } from './render-helpers.js';
import { activeOrchestratorLaneForSession, intelligenceOptionsFor, renderAgentEventTimeline, runModeOptionsFor } from './render-fragments.js';
import { shell } from './state.js';
import { renderAlert, writeHtml } from './dom.js';
import { api } from './api.js';
import { apiProviderOptions, cliExecutorOptions, normalizeExecutorType, defaultExecutorType, anyCliInstalled, defaultModelFor } from './executor.js';
import { renderComposerConfig } from './composer-config.js';
import { icon } from './icons.js';

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
  // Model precedence: the active matching lane's pin → the per-session default →
  // the per-project default → the executor's built-in default.
  const project = shell.projects.find((p) => p.id === session.projectId);
  const scopedDefaultModel = session.defaultModel || project?.defaultModel || '';
  const selectedModel = (laneMatches && activeLane.model)
    ? activeLane.model
    : (scopedDefaultModel || defaultModelFor(selectedExecutor));
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
            ${icon('plus', { size: 19 })}
          </button>
          <div class="composer-controls">
            <select name="executorType" class="composer-select" aria-label="Agent"${locked ? ' disabled' : ''}>
              ${cliExecutorOptions(selectedExecutor)}
              ${apiProviderOptions()}
            </select>
            <select name="permissionsProfile" class="composer-select" aria-label="Mode">
              ${runModeOptionsFor(selectedExecutor, selectedRunMode)}
            </select>
          </div>
          <span class="composer-spacer"></span>
          <div class="composer-right">
            ${renderComposerConfig(selectedExecutor, { model: selectedModel, intelligence: selectedIntelligence, speed: 'standard' })}
            <button class="composer-mic" data-action="composerMic" data-session-id="${safeAttr(session.id)}" type="button" title="Speak to type" aria-label="Dictate by voice">
              ${icon('mic', { size: 19 })}
            </button>
            <button class="composer-send" type="submit" aria-label="Send message">
              ${icon('send', { size: 19 })}
            </button>
          </div>
        </div>
        ${anyCliInstalled() ? '' : `<div class="composer-nocli">No CLI agent found — <a href="/#system" class="composer-nocli-link">set up agents</a> so Orca can run real ones.</div>`}
        <div class="composer-context" id="composer-context-${safeAttr(session.id)}"></div>
      </form>
    </article>
  `;
}

export function renderExecutorLanePanelItem(lane) {
  const stopButton = isLaneStoppable(lane)
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
        <span class="lane-badges">${stateBadge(lane.state)}${lane.auditState && lane.auditState !== 'not_queued' ? stateBadge(lane.auditState) : ''}</span>
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
    .filter((lane) => lane.sessionId === session.id && lane.owner !== 'orchestrator' && lane.owner !== 'auditor')
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

// Dedicated auditor lanes (owner='auditor') spawned by auto-audit — shown in the
// Audit section, NOT mixed into the executor-lane list.
export function auditorLanesForSession(session) {
  return shell.lanes
    .filter((lane) => lane.sessionId === session.id && lane.owner === 'auditor')
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

export function renderExecutorListInner(session) {
  const executorLanes = executorLanesForSession(session);
  return executorLanes.map(renderExecutorLanePanelItem).join('') || '<div class="muted tiny">No executor lanes yet.</div>';
}

export function renderExecutorSidePanel(session) {
  const executorLanes = executorLanesForSession(session);
  const auditorLanes = auditorLanesForSession(session);
  const pendingAudits = pendingAuditsForSession(session.id);
  // Only offer the Audit section when there's actually finished work awaiting
  // review (an audit queued/in-flight, or an auditor lane running) — no point
  // showing it with nothing to audit.
  const AUDITABLE_STATES = ['done', 'completed', 'ready_for_audit', 'needs_critique'];
  const hasAuditable = pendingAudits.length > 0
    || auditorLanes.length > 0
    || executorLanes.some((lane) => AUDITABLE_STATES.includes(String(lane.state || '').toLowerCase()));
  const agentOptions = `${cliExecutorOptions()}${shell.executorProfiles?.cli ? '<option value="cli">cli</option>' : ''}${apiProviderOptions()}`;
  const backlog = shell.backlogs?.[session.id] || null;
  const hasBacklog = backlog && backlog.counts && backlog.counts.total > 0;
  const c = hasBacklog ? backlog.counts : null;
  const backlogNotes = hasBacklog ? [...(backlog.stallReasons || []), ...(backlog.warnings || [])] : [];
  return `
    <aside class="info-panel" aria-label="Session info">
      <div class="info-panel-head">
        <strong>Session</strong>
        <div class="info-panel-head-actions">
          <button class="info-close" data-action="openSessionSettings" data-session-id="${safeAttr(session.id)}" data-session-name="${safeAttr(session.name || '')}" type="button" aria-label="Session settings" title="Session settings">
            ${icon('settings', { size: 16 })}
          </button>
          <button class="info-close" data-action="toggleExecutorPanel" type="button" aria-label="Close panel">
            ${icon('close', { size: 15 })}
          </button>
        </div>
      </div>
      <div class="info-panel-body">
        <section class="info-section">
          <h4 class="info-title">Executor lanes <span class="info-count">${safeText(executorLanes.length)}</span></h4>
          <div class="executor-panel-list" id="executor-list-${safeAttr(session.id)}"></div>
          ${(executorLanes.some(isLaneStoppable) || auditorLanes.some(isLaneStoppable))
    ? `<div class="info-tools"><button class="secondary" data-action="stopAllLanes" data-session-id="${safeAttr(session.id)}" type="button">Stop all lanes</button></div>` : ''}
          <details class="info-disclosure">
            <summary><span class="info-disclosure-add">+</span><span>New executor lane</span></summary>
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
            <button type="submit">Create lane</button>
          </form>
          </details>
        </section>

        ${hasBacklog ? `<section class="info-section">
          <h4 class="info-title">Backlog <span class="info-count">${safeText(c.accepted)}/${safeText(c.total)}</span></h4>
          <p class="tiny muted">${backlog.allAccepted
    ? 'All tasks accepted ✓'
    : `${safeText(c.accepted)} accepted · ${safeText(c.in_lane)} running · ${safeText(c.pending)} pending${c.failed ? ` · ${safeText(c.failed)} failed` : ''}${c.blocked ? ` · ${safeText(c.blocked)} blocked` : ''}`}</p>
          ${backlogNotes.map((note) => `<p class="tiny muted">⚠ ${safeText(note)}</p>`).join('')}
          ${(backlog.tasks || []).length ? `<div class="auditor-lane-list">${backlog.tasks.map((task) => `
            <div class="auditor-lane-row">
              <span class="auditor-lane-link">${safeText(task.title)}</span>
              ${stateBadge(task.state)}
              ${['accepted', 'in_lane'].includes(task.state) ? '' : `<button class="info-close" data-action="deleteTask" data-session-id="${safeAttr(session.id)}" data-task-id="${safeAttr(task.id)}" data-task-title="${safeAttr(task.title)}" type="button" aria-label="Delete task" title="Delete task">${icon('close', { size: 13 })}</button>`}
            </div>`).join('')}</div>` : ''}
          ${backlog.capacity?.spawnPolicy === 'auto' ? `<div class="info-tools"><button class="secondary" data-action="pauseSessionSpawning" data-session-id="${safeAttr(session.id)}" type="button">Pause spawning</button></div>` : ''}
        </section>` : ''}

        ${hasAuditable ? `<section class="info-section">
          <h4 class="info-title">Audit</h4>
          <p class="tiny muted">Hand finished executor lanes to the auditor for review.</p>
          ${auditorLanes.length ? `<div class="auditor-lane-list">${auditorLanes.map((lane) => `
            <div class="auditor-lane-row">
              <a class="auditor-lane-link" href="${safeAttr(lane.route || '#')}">${safeText(lane.title)}</a>
              ${stateBadge(lane.state)}
            </div>`).join('')}</div>` : ''}
          <div class="info-tools">
            <button class="secondary" data-action="auditDone" data-session-id="${safeAttr(session.id)}" type="button">Audit completed lanes${pendingAudits.length ? ` (${pendingAudits.length})` : ''}</button>
          </div>
        </section>` : ''}
      </div>
    </aside>
  `;
}
