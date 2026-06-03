// Session view — a Codex-style chat column with a collapsible right info panel.

import { refs, shell } from './state.js';
import { writeHtml } from './dom.js';
import { renderLaneExecutorGuidance } from './render-fragments.js';
import { safeText, safeAttr } from './format.js';
import { renderExecutorSidePanel, renderOrchestratorConsole, renderChatThreadInner, renderExecutorListInner } from './render-session-parts.js';

export function renderSession(project, session) {
  const sid = session.id;
  const panelOpen = shell.executorPanelOpen;
  // The skeleton (topbar + composer + info-panel forms) is rebuilt ONLY when the
  // structural key changes — switching session, or toggling the info panel. On a
  // normal chat/lane update the key is unchanged, so the composer the user is
  // typing in and the info-panel forms keep their exact DOM nodes; we only touch
  // the volatile mounts below. This is what keeps a paired/workstation page static
  // and updating in real time instead of whole-page refreshing.
  const structuralKey = `${sid}::${panelOpen ? 'panel' : 'nopanel'}`;
  const existing = refs.content.querySelector('.session-shell');
  if (!existing || existing.getAttribute('data-structural-key') !== structuralKey) {
    writeHtml(refs.content, `
      <section class="session-shell ${panelOpen ? 'info-open' : ''}" data-structural-key="${safeAttr(structuralKey)}">
        <header class="session-topbar">
          <div class="session-crumb">
            <span class="crumb-project">${safeText(project.name)}</span>
            <span class="crumb-sep">/</span>
            <span class="crumb-session">${safeText(session.name)}</span>
          </div>
          <button class="info-toggle ${panelOpen ? 'active' : ''}" data-action="toggleExecutorPanel" type="button" aria-label="Toggle agents panel" title="Agents & tools">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2.2"></rect>
              <path d="M12.5 3.5v13"></path>
            </svg>
          </button>
        </header>
        <div class="session-workbench">
          <div class="chat-column">
            ${renderOrchestratorConsole(session)}
          </div>
          ${panelOpen ? `<div class="info-col" id="info-col-${safeAttr(sid)}">${renderExecutorSidePanel(session)}</div>` : ''}
        </div>
      </section>
    `);
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
  if (panelOpen) {
    const listEl = document.getElementById(`executor-list-${sid}`);
    if (listEl) writeHtml(listEl, renderExecutorListInner(session));
  }
  // Rehydrate the composer from the draft store (source of truth). Only when the
  // box is not focused, so we never disturb the caret of someone mid-type.
  const composer = document.querySelector('#orchestrator-message-form textarea[name="message"]');
  if (composer && document.activeElement !== composer) {
    composer.value = shell.composerDrafts?.[sid] || '';
  }
  renderLaneExecutorGuidance(document.getElementById('create-lane-form'));
}
