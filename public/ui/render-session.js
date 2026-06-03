// Session view — a Codex-style chat column with a collapsible right info panel.

import { refs, shell } from './state.js';
import { renderLaneExecutorGuidance } from './render-fragments.js';
import { safeText } from './format.js';
import { renderExecutorSidePanel, renderOrchestratorConsole } from './render-session-parts.js';

export function renderSession(project, session) {
  refs.content.innerHTML = `
    <section class="session-shell ${shell.executorPanelOpen ? 'info-open' : ''}">
      <header class="session-topbar">
        <div class="session-crumb">
          <span class="crumb-project">${safeText(project.name)}</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-session">${safeText(session.name)}</span>
        </div>
        <button class="info-toggle ${shell.executorPanelOpen ? 'active' : ''}" data-action="toggleExecutorPanel" type="button" aria-label="Session info" title="Session info">
          <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="10" cy="10" r="7.2"></circle>
            <path d="M10 9v4.2"></path>
            <circle cx="10" cy="6.6" r="0.2"></circle>
          </svg>
        </button>
      </header>
      <div class="session-workbench">
        <div class="chat-column">
          ${renderOrchestratorConsole(session)}
        </div>
        ${shell.executorPanelOpen ? renderExecutorSidePanel(session) : ''}
      </div>
    </section>
  `;
  renderLaneExecutorGuidance(document.getElementById('create-lane-form'));
}
