// Render view module (split from render-views.js).

import { formatRelative, safeAttr, safeText, stateBadge } from './format.js';
import { agentEventLabel, isLaneStoppable, isLiveLaneState, isRestartableLaneState, pendingAuditsForSession } from './render-helpers.js';
import { activeOrchestratorLaneForSession, assistantEventTranscriptText, chatTerminalLaneForSession, intelligenceOptionsFor, renderAgentEventTimeline, runModeOptionsFor } from './render-fragments.js';
import { shell } from './state.js';
import { renderAlert, writeHtml } from './dom.js';
import { api } from './api.js';
import { apiProviderOptions, cliExecutorOptions, normalizeExecutorType, defaultExecutorType, anyCliInstalled, defaultModelFor, isForeignModel } from './executor.js';
import { renderComposerConfig } from './composer-config.js';
import { icon } from './icons.js';
import { laneTerminalSnippet } from './lane-stream.js';

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

function parseTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes || hours) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function compactPath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return text;
  return `.../${parts.slice(-3).join('/')}`;
}

function laneElapsedMs(lane) {
  const explicit = (Array.isArray(lane?.agentEvents) ? lane.agentEvents : [])
    .map((event) => Number(event.durationMs))
    .filter((value) => Number.isFinite(value) && value > 0)
    .at(-1);
  if (explicit) return explicit;
  const started = parseTime(lane?.startedAt) || parseTime(lane?.createdAt);
  if (!started) return 0;
  const ended = parseTime(lane?.completedAt) || parseTime(lane?.updatedAt) || Date.now();
  return Math.max(0, ended - started);
}

function numericUsage(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function tokenTotalFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const direct = numericUsage(usage.total_tokens)
    || numericUsage(usage.totalTokens)
    || numericUsage(usage.token_count)
    || numericUsage(usage.tokenCount);
  if (direct) return direct;
  const input = numericUsage(usage.prompt_tokens)
    || numericUsage(usage.input_tokens)
    || numericUsage(usage.promptTokenCount)
    || numericUsage(usage.inputTokens);
  const output = numericUsage(usage.completion_tokens)
    || numericUsage(usage.output_tokens)
    || numericUsage(usage.candidatesTokenCount)
    || numericUsage(usage.outputTokens);
  return input + output;
}

function tokenSummary(lane) {
  const candidates = [
    lane?.tokenUsage,
    lane?.apiProviderResult?.usage,
    ...(Array.isArray(lane?.agentEvents) ? lane.agentEvents.map((event) => event.usage || event.stats || event.tokens) : []),
  ];
  const total = candidates.reduce((sum, usage) => sum || tokenTotalFromUsage(usage), 0);
  if (!total) return '';
  return `${new Intl.NumberFormat().format(total)} tokens`;
}

const CHAT_ACTIVITY_TYPES = new Set([
  'command.started',
  'tool.started',
  'tool.completed',
  'file.changed',
  'error',
  'agent.failed',
  'agent.stopped',
]);

function shortActivityText(event) {
  const raw = event?.command || event?.toolName || event?.title || event?.content || agentEventLabel(event?.type || 'event');
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function chatActivityItems(lane) {
  const events = Array.isArray(lane?.agentEvents) ? lane.agentEvents : [];
  return events
    .filter((event) => CHAT_ACTIVITY_TYPES.has(String(event?.type || '')))
    .map((event) => ({
      type: String(event.type || 'event'),
      label: agentEventLabel(event.type || 'event'),
      text: shortActivityText(event),
    }))
    .filter((item) => item.text)
    .slice(-12);
}

function renderChatRunMeta(lane, working) {
  if (!lane) return '';
  const terminalMode = lane.presentationMode === 'terminal';
  const duration = laneElapsedMs(lane);
  const startedAt = lane?.startedAt || lane?.createdAt || '';
  const endedAt = lane?.completedAt || lane?.updatedAt || '';
  const durationText = (duration > 0 || !working) ? formatDuration(duration) : '';
  const tokens = tokenSummary(lane);
  const label = working
    ? (terminalMode ? 'Terminal active' : 'Thinking...')
    : (lane.state === 'failed' || lane.state === 'stopped'
      ? 'Stopped after'
      : (terminalMode ? 'Terminal ran for' : 'Worked for'));
  const bits = [
    durationText ? `<span class="chat-run-duration" data-started-at="${safeAttr(startedAt)}" data-ended-at="${safeAttr(working ? '' : endedAt)}">${safeText(durationText)}</span>` : '',
    tokens ? `<span class="chat-run-tokens">${safeText(tokens)}</span>` : '',
  ].filter(Boolean).join('<span class="chat-run-sep">·</span>');
  return `
    <div class="chat-run-meta" data-lane-id="${safeAttr(lane.id)}">
      <span class="chat-run-meta-main">
        ${working && !terminalMode ? '<span class="chat-spinner" aria-hidden="true"></span>' : ''}
        <span>${safeText(label)}</span>
        ${bits ? `<span class="chat-run-bits">${bits}</span>` : ''}
      </span>
      <button class="chat-run-terminal-action" data-action="showLaneTerminal" data-session-id="${safeAttr(lane.sessionId || '')}" data-lane-id="${safeAttr(lane.id)}" type="button" title="View live output" aria-label="View live output">
        ${icon('terminal', { size: 14 })}
      </button>
    </div>
  `;
}

function renderTerminalChatSnippet(lane, working, { compact = false } = {}) {
  if (!lane || lane.presentationMode !== 'terminal') return '';
  const snippet = laneTerminalSnippet(lane.id);
  if (snippet) {
    return `
      <div class="terminal-chat-receipt${compact ? ' compact' : ''}" data-lane-id="${safeAttr(lane.id)}" aria-label="Latest terminal output">
        <div class="terminal-chat-receipt-label">${working ? 'Live terminal' : 'Terminal output'}</div>
        <pre>${safeText(snippet)}</pre>
      </div>
    `;
  }
  return `
    <div class="terminal-chat-receipt muted${compact ? ' compact' : ''}" data-lane-id="${safeAttr(lane.id)}">
      ${safeText(working
        ? 'Live CLI output is available for this session.'
        : 'Terminal transcript is available for this session.')}
    </div>
  `;
}

function renderChatRunDetails(lane, working = false) {
  const items = chatActivityItems(lane);
  if (!items.length) return '';
  const latest = items.at(-1);
  const summary = working && latest
    ? `${latest.label}: ${latest.text}`
    : `Details · ${items.length} ${items.length === 1 ? 'item' : 'items'}`;
  return `
    <details class="chat-run-details">
      <summary>${safeText(summary)}</summary>
      <div class="chat-run-detail-list">
        ${items.map((item) => `
          <div class="chat-run-detail">
            <span>${safeText(item.label)}</span>
            <code>${safeText(item.text)}</code>
          </div>
        `).join('')}
      </div>
    </details>
  `;
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
  const laneById = new Map((shell.lanes || [])
    .filter((lane) => lane.sessionId === session.id)
    .map((lane) => [lane.id, lane]));
  const renderedLaneIds = new Set();
  const renderAssistantTurn = (message) => {
    const lane = message.laneId ? laneById.get(message.laneId) : null;
    const isStartStub = /^Started\s+.+\s+orchestrator lane\s+"/i.test(String(message.content || '').trim());
    const transcriptText = lane ? assistantEventTranscriptText(lane, { limit: 120 }) : '';
    const visibleText = isStartStub ? transcriptText : (String(message.content || '').trim() || transcriptText);
    const hasEvents = Boolean(lane && ((Array.isArray(lane.agentEvents) && lane.agentEvents.length) || lane.agentEventCount));
    const working = Boolean(lane && isLiveLaneState(lane.state));
    const terminalReceipt = renderTerminalChatSnippet(lane, working, { compact: Boolean(visibleText) });
    if (lane) renderedLaneIds.add(lane.id);
    const fallback = lane
      ? (lane.presentationMode === 'terminal'
        ? ''
        : (lane.state === 'failed' ? 'No assistant response was captured.' : ''))
      : safeText(message.content || '');
    return `
      <div class="msg msg-assistant" ${lane ? `data-lane-id="${safeAttr(lane.id)}"` : ''}>
        <div class="msg-body">
          ${renderChatRunMeta(lane, working)}
          ${visibleText ? `<div class="chat-agent-transcript">${safeText(visibleText)}</div>` : (fallback ? `<div class="muted">${fallback}</div>` : '')}
          ${visibleText && lane?.presentationMode === 'terminal' ? '' : terminalReceipt}
          ${hasEvents ? renderChatRunDetails(lane, working) : ''}
        </div>
      </div>
    `;
  };
  const messageRows = messages.slice(-50).map((message) => {
    const role = String(message.role || 'system').toLowerCase();
    const isUser = role === 'user';
    if (!isUser && message.laneId) return renderAssistantTurn(message);
    return `
      <div class="msg msg-${isUser ? 'user' : 'assistant'}">
        <div class="msg-body">${safeText(message.content || '')}</div>
      </div>
    `;
  }).join('');
  const activeLane = activeOrchestratorLaneForSession(session);
  const orphanActivity = activeLane && !renderedLaneIds.has(activeLane.id)
    ? renderAssistantTurn({ role: 'assistant', laneId: activeLane.id, content: '' })
    : '';
  // Codex-style hero for a fresh chat: "What should we build in {project}?"
  const project = (shell.projects || []).find((p) => p.id === session.projectId);
  const heroName = project?.name || session.name || 'this project';
  const emptyState = `
    <div class="chat-empty">
      <h2>What should we build in ${safeText(heroName)}?</h2>
    </div>`;
  return `${messageRows || emptyState}${orphanActivity}${renderSessionApprovals(session)}`;
}

export function renderChatTerminalInner(session) {
  const agentLane = chatTerminalLaneForSession(session);
  const { terminals } = operatorTerminalRecords(session.id);
  const activeTerminalId = shell.operatorTerminalActiveBySession?.[session.id] || terminals.find((item) => item.state === 'running')?.id || terminals[0]?.id || '';
  const activeTerminal = terminals.find((item) => item.id === activeTerminalId) || terminals[0] || null;
  const explicitCommand = shell.chatTerminalTabBySession?.[session.id] === 'command';
  return (activeTerminal && (explicitCommand || !agentLane) && !agentLane?.processMeta?.attachedOperatorTerminalId)
    ? renderOperatorTerminalInner(session)
    : renderAgentTerminalInner(session);
}

function renderAgentTerminalInner(session) {
  const lane = chatTerminalLaneForSession(session);
  if (!lane) {
    return `
      <div class="chat-terminal-empty">
        <strong>No live output yet.</strong>
        <span>Send a message to start an orchestrator lane, then this view will show its live terminal output.</span>
      </div>
    `;
  }
  const attachedNative = Boolean(lane.processMeta?.attachedOperatorTerminalId);
  const title = attachedNative
    ? `${lane.executorType || 'agent'} terminal agent`
    : (lane.executorType || 'agent');
  return `
    <div class="agent-terminal-shell">
      <div class="chat-terminal-head compact" data-lane-id="${safeAttr(lane.id)}">
        <div>
          <strong>${safeText(title)}</strong>
          <div class="chat-terminal-meta">
            <span>${safeText(lane.title || lane.id)}</span>
            ${stateBadge(lane.state || 'unknown')}
          </div>
        </div>
        <button class="secondary terminal-action-button" data-action="showLaneChat" data-session-id="${safeAttr(session.id)}" data-lane-id="${safeAttr(lane.id)}" type="button" title="Show this turn in Chat">
          ${icon('chevron-down', { size: 15 })}<span>Chat</span>
        </button>
      </div>
      <div id="lane-stream-${safeAttr(lane.id)}" class="lane-stream chat-terminal-stream" data-interactive-terminal="${lane.processMeta?.terminalWrapper === 'pty' && ['starting', 'running'].includes(lane.state) ? 'true' : 'false'}" aria-live="polite" tabindex="0">Connecting to live output…</div>
    </div>
  `;
}

function operatorTerminalRecords(sessionId) {
  const record = shell.operatorTerminalsBySession?.[sessionId] || null;
  const terminals = Array.isArray(record?.terminals) ? record.terminals : [];
  return { record, terminals };
}

function renderOperatorTerminalInner(session) {
  const { record, terminals } = operatorTerminalRecords(session.id);
  const activeId = shell.operatorTerminalActiveBySession?.[session.id] || terminals.find((item) => item.state === 'running')?.id || terminals[0]?.id || '';
  const active = terminals.find((item) => item.id === activeId) || terminals[0] || null;
  const accessError = record?.error || '';
  const titleCounts = terminals.reduce((counts, terminal) => {
    const key = terminal.title || 'Terminal';
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
  const titleIndexes = new Map();
  const tabButtons = terminals.length > 1 ? terminals.map((terminal) => {
    const baseTitle = terminal.title || 'Terminal';
    const currentIndex = (titleIndexes.get(baseTitle) || 0) + 1;
    titleIndexes.set(baseTitle, currentIndex);
    const displayTitle = titleCounts.get(baseTitle) > 1 ? `${currentIndex}. ${baseTitle}` : baseTitle;
    return `
    <button class="${terminal.id === active?.id ? 'active' : ''}" data-action="selectOperatorTerminal" data-session-id="${safeAttr(session.id)}" data-terminal-id="${safeAttr(terminal.id)}" type="button">
      <span>${safeText(displayTitle)}</span>
      ${stateBadge(terminal.state || 'unknown')}
    </button>
  `;
  }).join('') : '';
  if (!active) {
    return `
      <div class="operator-terminal-shell">
        <div class="operator-terminal-toolbar">
          <div class="operator-terminal-tabs">${tabButtons}</div>
          <button class="secondary terminal-action-button" data-action="startOperatorTerminal" data-session-id="${safeAttr(session.id)}" type="button" title="New shell">${icon('plus', { size: 15 })}<span>New shell</span></button>
        </div>
        <div class="chat-terminal-empty">
          <strong>${accessError ? 'Shell unavailable.' : 'No shell yet.'}</strong>
          <span>${safeText(accessError || 'Start a terminal to run commands in this session folder.')}</span>
        </div>
      </div>
    `;
  }
  const stopped = active.state !== 'running';
  const activeTitle = active.agentBridge?.state === 'active' && active.agentBridge?.executorType
    ? `${active.agentBridge.executorType} terminal agent`
    : (active.title || 'shell');
  const activeMeta = `${active.shell || 'shell'}${active.cwd ? ` · ${compactPath(active.cwd)}` : ''}`;
  return `
    <div class="operator-terminal-shell">
      <div class="operator-terminal-toolbar">
        ${tabButtons
          ? `<div class="operator-terminal-tabs">${tabButtons}</div>`
          : `<div class="operator-terminal-current"><strong>${safeText(activeTitle)}</strong><span title="${safeAttr(active.cwd || '')}">${safeText(activeMeta)}</span></div>`}
        <div class="operator-terminal-actions">
          ${tabButtons ? `<div class="operator-terminal-active-meta"><span title="${safeAttr(active.cwd || '')}">${safeText(activeMeta)}</span></div>` : stateBadge(active.state || 'unknown')}
          <button class="secondary terminal-action-button" data-action="startOperatorTerminal" data-session-id="${safeAttr(session.id)}" type="button" title="New shell">${icon('plus', { size: 15 })}<span>New shell</span></button>
          ${stopped ? '' : `<button class="secondary terminal-action-button terminal-stop-button" data-action="stopOperatorTerminal" data-terminal-id="${safeAttr(active.id)}" type="button" title="Stop terminal">${icon('close', { size: 15 })}<span>Stop</span></button>`}
        </div>
      </div>
      <div id="operator-terminal-stream-${safeAttr(active.id)}" class="lane-stream chat-terminal-stream operator-terminal-stream" data-terminal-state="${safeAttr(active.state || 'unknown')}" aria-live="polite" tabindex="0">Connecting to terminal…</div>
    </div>
  `;
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
  // Once a session has traffic it's locked to the agent that actually owns the
  // orchestrator thread. `session.leader` can be only a draft/default value from
  // before the first send, so the thread wins after any real turn exists.
  const locked = messages.length > 0;
  const selectedExecutor = defaultExecutorType(thread.executorType || session.leader);
  // Reflect the active lane's settings ONLY when that lane is the same agent;
  // otherwise show the selected agent's own defaults (fixes e.g. codex showing
  // claude's 'opus' because a prior lane used it).
  const laneMatches = activeLane && normalizeExecutorType(activeLane.executorType || '') === selectedExecutor;
  // Model precedence: the active matching lane's pin → the per-session default →
  // the per-project default → the executor's built-in default.
  const project = shell.projects.find((p) => p.id === session.projectId);
  const scopedDefaultModel = session.defaultModel || project?.defaultModel || '';
  const laneModel = laneMatches && activeLane.model && !isForeignModel(activeLane.model, selectedExecutor)
    ? activeLane.model
    : '';
  const scopedModel = scopedDefaultModel && !isForeignModel(scopedDefaultModel, selectedExecutor)
    ? scopedDefaultModel
    : '';
  const selectedModel = laneModel
    ? laneModel
    : (scopedModel || defaultModelFor(selectedExecutor));
  const selectedRunMode = (laneMatches && activeLane.permissionsProfile) || 'auto-edit';
  const selectedIntelligence = (laneMatches && activeLane.intelligenceProfile) || 'high';
  return `
    <article class="chat${locked ? '' : ' chat--empty'}">
      <div class="chat-thread" id="chat-thread-${safeAttr(session.id)}"></div>
      <div class="chat-terminal" id="chat-terminal-${safeAttr(session.id)}" aria-label="Live session terminal"></div>
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

export function renderOrchestratorPanelInner(session) {
  const orchestratorLane = activeOrchestratorLaneForSession(session);
  const orchestratorEventCount = orchestratorLane
    ? (orchestratorLane.agentEventCount ?? (orchestratorLane.agentEvents || []).length ?? 0)
    : 0;
  return orchestratorLane ? `
    <article class="executor-item orchestrator-item">
      <div>
        <strong>${safeText(orchestratorLane.executorType || 'agent')}</strong>
        <div class="tiny muted">${safeText(orchestratorLane.title || 'Chat turn')} · ${safeText(orchestratorLane.state || 'queued')} · ${safeText(String(orchestratorEventCount))} events</div>
      </div>
    </article>
  ` : '<div class="muted tiny">No active chat turn.</div>';
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
  const selectedLaneExecutor = defaultExecutorType(session.orchestratorThread?.executorType || session.leader);
  const agentOptions = `${cliExecutorOptions(selectedLaneExecutor)}${shell.executorProfiles?.cli ? '<option value="cli">cli</option>' : ''}${apiProviderOptions()}`;
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
          <h4 class="info-title">Orchestrator</h4>
          <div id="orchestrator-panel-${safeAttr(session.id)}">${renderOrchestratorPanelInner(session)}</div>
        </section>
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
