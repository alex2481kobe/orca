// Render view module (split from render-views.js).

import { refs, shell } from './state.js';
import { intelligenceOptions, renderLaneCard, renderLaneExecutorGuidance, runModeOptions } from './render-fragments.js';
import { pendingAuditsForSession } from './render-helpers.js';
import { safeText } from './format.js';
import { renderExecutorSidePanel, renderOrchestratorConsole } from './render-session-parts.js';
import { apiProviderOptions, cliExecutorOptions } from './executor.js';
import { refresh } from './controller.js';

export function renderSession(project, session) {
  const laneList = shell.lanes.filter((lane) => lane.sessionId === session.id).map((lane) => renderLaneCard(lane)).join('');
  const pendingAudits = pendingAuditsForSession(session.id);
  const pendingAuditSummary = pendingAudits.length
    ? `<p>Pending audit events: ${pendingAudits.length}</p>`
    : '<p>No pending audit events.</p>';
  refs.content.innerHTML = `
    <section class="session-shell ${shell.executorPanelOpen ? 'executor-panel-open' : 'executor-panel-closed'}">
      <div class="session-toolbar">
        <div class="tiny muted">${safeText(project.name)} · ${safeText(session.leader)} led</div>
        <button class="secondary" data-action="toggleExecutorPanel" type="button">${shell.executorPanelOpen ? 'Hide executors' : 'Show executors'}</button>
      </div>
      <div class="session-workbench">
        <div class="session-main-column">
          ${renderOrchestratorConsole(session)}
          <div class="grid-2 session-controls">
            <article class="card control-card" id="create-session">
              <details class="disclosure">
                <summary>
                  <span>Create lane</span>
                  <small>Queue Codex, Claude, API, CLI, or mock work</small>
                </summary>
                <div class="disclosure-body">
              <form id="create-lane-form" data-session-id="${session.id}">
            <label>Title
              <input name="title" required />
            </label>
            <label>Task description
              <textarea name="taskDescription" rows="3"></textarea>
            </label>
            <label>Command (for local CLI/Codex/Claude lanes)
              <input name="command" placeholder="e.g., codex run --help" />
            </label>
            <div id="lane-command-guidance" class="tiny muted"></div>
            <label>Command args
              <input name="commandArgs" placeholder="quoted optional args or tokenized words" />
            </label>
            <label>Executor binary override
              <input name="executorBinary" placeholder="e.g., codex, claude, node, ./scripts/run.sh" />
            </label>
            <label>Working directory
              <input name="workdir" placeholder="optional workspace-relative or absolute path" />
            </label>
            <label>Executor
              <select name="executorType">
                <option value="mock">mock</option>
                ${cliExecutorOptions()}
                ${shell.executorProfiles?.cli ? '<option value="cli">cli</option>' : ''}
                ${apiProviderOptions()}
              </select>
            </label>
            <label>Task prompt (drives Codex/Claude/API requests when no explicit command)
              <textarea name="taskPrompt" rows="3" placeholder="e.g., Plan the cleanup ramp"></textarea>
            </label>
            <label>Model / profile
              <input name="model" placeholder="e.g., gpt-5 or claude-opus-4-7" />
            </label>
            <label>Intelligence
              <select name="intelligenceProfile">
                ${intelligenceOptions('high')}
              </select>
            </label>
            <label>Permissions profile
              <select name="permissionsProfile">
                ${runModeOptions('plan')}
              </select>
            </label>
            <div class="tiny muted">Orca snapshots the selected executor's detected capabilities when the lane is queued.</div>
            <label>Target URL
              <input name="targetUrl" placeholder="https://localhost:5173" />
            </label>
            <label>Branch (for worktree lanes)
              <input name="branch" placeholder="feature/auth-cleanup" />
            </label>
            <label>Verification command
              <input name="verificationCommand" placeholder="e.g., npm run smoke" />
            </label>
            <label>MCP tools
              <select name="mcpToolIds" multiple size="4" data-mcp-picker="1"></select>
              <span class="tiny muted">Tap to select; long-press on phone to multi-select. IDs are also accepted comma-separated.</span>
            </label>
            <input type="hidden" name="mcpToolIdsRaw" />
            <button type="submit">Queue lane</button>
              </form>
                </div>
              </details>
            </article>
            <article class="card control-card">
              <details class="disclosure">
                <summary>
                  <span>Session tools</span>
                  <small>${pendingAudits.length} pending audits</small>
                </summary>
                <div class="disclosure-body">
                  ${pendingAuditSummary}
                  <div class="lane-row">
                    <button class="secondary" data-action="auditDone" data-session-id="${session.id}" type="button">Audit done lanes</button>
                    <button class="secondary" data-action="refresh" type="button">Refresh</button>
                  </div>
                </div>
              </details>
            </article>
          </div>
          <section class="lane-queue">
            <div class="card-grid">${laneList || '<div class="muted">No lanes yet.</div>'}</div>
          </section>
        </div>
        ${shell.executorPanelOpen ? renderExecutorSidePanel(session) : ''}
      </div>
    </section>
  `;
  renderLaneExecutorGuidance(document.getElementById('create-lane-form'));
}
