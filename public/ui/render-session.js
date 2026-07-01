// Session view — a Codex-style chat column with a collapsible right info panel.

import { refs, shell } from './state.js';
import { writeHtml } from './dom.js';
import { activeOrchestratorLaneForSession, renderLaneExecutorGuidance } from './render-fragments.js';
import { safeText, safeAttr } from './format.js';
import { icon } from './icons.js';
import { renderExecutorSidePanel, renderOrchestratorConsole, renderChatThreadInner, renderChatTerminalInner, renderExecutorListInner, renderOrchestratorPanelInner } from './render-session-parts.js';
import { hydrateComposerContext } from './composer-context.js';
import { isForeignModel, defaultModelFor } from './executor.js';
import { refreshConfigLabel } from './composer-config.js';

function renderActiveOrchestratorChip(session) {
  const active = session?.orchestratorThread?.activeOrchestrator || null;
  if (active?.active && !active.stale) {
    return `<span class="tag ok">Orchestrator: ${safeText(active.actor || active.source || 'active')}</span>`;
  }
  const lane = activeOrchestratorLaneForSession(session);
  if (lane) {
    const klass = ['queued', 'starting', 'running'].includes(lane.state) ? 'ok' : lane.state === 'failed' ? 'bad' : 'warn';
    return `<span class="tag ${klass}">Orchestrator lane: ${safeText(lane.state || 'unknown')}</span>`;
  }
  return '<span class="tag warn">Orchestrator: idle</span>';
}

export function renderSession(project, session) {
  const sid = session.id;
  const panelOpen = shell.executorPanelOpen;
  // The skeleton (topbar + composer + info-panel forms) is rebuilt ONLY when the
  // structural key changes — switching session, or toggling the info panel. On a
  // normal chat/lane update the key is unchanged, so the composer the user is
  // typing in and the info-panel forms keep their exact DOM nodes; we only touch
  // the volatile mounts below. This is what keeps a paired/workstation page static
  // and updating in real time instead of whole-page refreshing.
  // Structural key is the SESSION only — NOT the panel state. Opening/closing the
  // info panel must not rebuild the DOM (that would be instant + lose the composer);
  // instead we toggle the .info-open class and let CSS animate the panel width.
  const structuralKey = sid;
  const existing = refs.content.querySelector('.session-shell');
  if (!existing || existing.getAttribute('data-structural-key') !== structuralKey) {
    writeHtml(refs.content, `
      <section class="session-shell" data-structural-key="${safeAttr(structuralKey)}">
        <header class="session-topbar">
          <div class="session-crumb">
            <span class="crumb-project">${safeText(project.name)}</span>
            <span class="crumb-sep">/</span>
            <span class="crumb-session">${safeText(session.name)}</span>
            <span id="orchestrator-chip-${safeAttr(sid)}">${renderActiveOrchestratorChip(session)}</span>
          </div>
          <div class="session-topbar-side session-tools">
            <button class="info-toggle terminal-toggle" data-action="toggleChatTerminal" data-session-id="${safeAttr(sid)}" type="button" aria-label="Toggle terminal view" aria-pressed="false" title="Terminal view">
              ${icon('terminal', { size: 18 })}
            </button>
            <button class="info-toggle" data-action="toggleExecutorPanel" type="button" aria-label="Toggle agents panel" title="Agents & tools">
              ${icon('panel-right', { size: 18 })}
            </button>
          </div>
        </header>
        <div class="session-workbench">
          <div class="chat-column">
            ${renderOrchestratorConsole(session)}
          </div>
          <div class="info-col" id="info-col-${safeAttr(sid)}">${renderExecutorSidePanel(session)}</div>
        </div>
      </section>
    `);
  }

  // Sync the open state on the existing shell (animated via CSS — see .info-open).
  const shellEl = refs.content.querySelector('.session-shell');
  if (shellEl) {
    shellEl.classList.toggle('info-open', panelOpen);
    const terminalOpen = Boolean(shell.chatTerminalOpenBySession?.[sid]);
    shellEl.classList.toggle('chat-terminal-open', terminalOpen);
    const chatEl = shellEl.querySelector('.chat');
    if (chatEl) chatEl.classList.toggle('chat-terminal-open', terminalOpen);
    const toggleBtn = shellEl.querySelector('[data-action="toggleExecutorPanel"]');
    if (toggleBtn) toggleBtn.classList.toggle('active', panelOpen);
    const terminalBtn = shellEl.querySelector('[data-action="toggleChatTerminal"]');
    if (terminalBtn) {
      terminalBtn.classList.toggle('active', terminalOpen);
      terminalBtn.setAttribute('aria-pressed', terminalOpen ? 'true' : 'false');
    }
    const orchestratorChip = document.getElementById(`orchestrator-chip-${sid}`);
    if (orchestratorChip) writeHtml(orchestratorChip, renderActiveOrchestratorChip(session));
  }

  // Targeted real-time updates: fill the volatile mounts. Each writeHtml is a
  // no-op when its region's HTML is unchanged, so a new chat message rewrites ONLY
  // the thread and a lane-state change rewrites ONLY the executor list.
  const threadEl = document.getElementById(`chat-thread-${sid}`);
  if (threadEl) {
    const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 80;
    const changed = writeHtml(threadEl, renderChatThreadInner(session));
    if (changed && nearBottom) threadEl.scrollTop = threadEl.scrollHeight;
  }
  const terminalEl = document.getElementById(`chat-terminal-${sid}`);
  if (terminalEl) {
    const terminalOpen = Boolean(shell.chatTerminalOpenBySession?.[sid]);
    writeHtml(terminalEl, terminalOpen ? renderChatTerminalInner(session) : '');
  }
  const listEl = document.getElementById(`executor-list-${sid}`);
  if (listEl) writeHtml(listEl, renderExecutorListInner(session));
  const orchestratorPanelEl = document.getElementById(`orchestrator-panel-${sid}`);
  if (orchestratorPanelEl) writeHtml(orchestratorPanelEl, renderOrchestratorPanelInner(session));
  // Rehydrate the composer from the draft store (source of truth). Only when the
  // box is not focused, so we never disturb the caret of someone mid-type.
  const composer = document.querySelector('#orchestrator-message-form textarea[name="message"]');
  if (composer && document.activeElement !== composer) {
    composer.value = shell.composerDrafts?.[sid] || '';
  }
  // Lock the agent once the session has traffic (sync here so it applies the
  // moment the first message lands, without rebuilding the composer skeleton).
  const agentSel = document.querySelector('#orchestrator-message-form select[name="executorType"]');
  if (agentSel) agentSel.disabled = (session.orchestratorThread?.messages?.length || 0) > 0;
  // Keep the shown model matched to the selected agent: if a different agent's
  // model leaked in (e.g. gpt-5.5 while claude is selected), snap it back to this
  // agent's default. Free-text models the agent doesn't list are left untouched.
  const modelField = document.querySelector('#orchestrator-message-form input[name="model"]');
  if (modelField && agentSel) {
    const agent = agentSel.value;
    if (isForeignModel(modelField.value, agent)) {
      modelField.value = defaultModelFor(agent) || '';
      refreshConfigLabel(document.getElementById('orchestrator-message-form'));
    }
  }
  renderLaneExecutorGuidance(document.getElementById('create-lane-form'));
  // Fill the Codex-style context row (Local/Cloud + branch picker). Cached per
  // session so the poll loop doesn't refetch; writeHtml skips identical HTML.
  hydrateComposerContext(session);
}
