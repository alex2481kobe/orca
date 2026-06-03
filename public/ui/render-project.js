// Render view module (split from render-views.js).

import { refs, shell } from './state.js';
import { formatRelative, latestTimestamp, safeAttr, safeText } from './format.js';
import { clientUrl, safeHref, writeHtml } from './dom.js';
import { effectiveProjectQuickLinkUrl, quickLinkHealthLabel } from './access-mode.js';
import { leaderOptions } from './executor.js';

export function renderWorkstationPickerPanel(forInput) {
  const picker = shell.workstationPicker;
  if (!picker || !picker.open || picker.forInput !== forInput) return '';
  const entries = Array.isArray(picker.entries) ? picker.entries : [];
  const rows = entries.map((entry) => `
    <button class="picker-row" data-action="workstationOpenDir" data-dir="${safeAttr(entry.path)}" data-for-input="${safeAttr(forInput)}" type="button">
      <span class="picker-icon">${entry.isGitRepo ? '◆' : '▸'}</span>
      <span>${safeText(entry.name)}</span>${entry.isGitRepo ? '<small class="muted"> git repo</small>' : ''}
    </button>`).join('');
  return `
    <div class="workstation-picker card" role="group" aria-label="Workstation directory picker">
      <div class="picker-head">
        <strong>Pick a working directory</strong>
        <button class="secondary" data-action="workstationPickerClose" type="button">Close</button>
      </div>
      ${picker.error ? `<div class="tiny bad">${safeText(picker.error)}</div>` : ''}
      <div class="tiny muted">${picker.path ? safeText(picker.path) : 'Approved workstation roots (add more with ORCA_REPO_ROOTS):'}</div>
      <div class="picker-list">
        ${picker.parent ? `<button class="picker-row" data-action="workstationOpenDir" data-dir="${safeAttr(picker.parent)}" data-for-input="${safeAttr(forInput)}" type="button"><span class="picker-icon">↑</span><span>Up one level</span></button>` : ''}
        ${rows || '<div class="tiny muted">No subfolders here.</div>'}
      </div>
      ${picker.path ? `<button data-action="workstationUseDir" data-dir="${safeAttr(picker.path)}" data-for-input="${safeAttr(forInput)}" type="button">Use this folder</button>` : ''}
    </div>`;
}

export function renderProject(project) {
  writeHtml(refs.content, `
    <section class="create-shell">
      <div class="create-card">
        <header class="create-head">
          <h2>New session</h2>
          <div class="tiny muted">${safeText(project.name)}</div>
        </header>
        <form id="create-session-form" data-project-id="${safeAttr(project.id)}">
          <label>Session name
            <input name="name" required placeholder="What is this session about?" />
          </label>
          <label>Leader
            <select name="leader">${leaderOptions('codex')}</select>
          </label>
          <label>Max parallel lanes
            <input name="laneConcurrencyLimit" type="number" min="1" max="64" value="1" />
          </label>
          <label>Working directory
            <input id="session-repo-root" name="repoRoot" placeholder="Inherits the project folder if blank" autocomplete="off" />
          </label>
          <button class="secondary" data-action="browseWorkstation" data-for-input="session-repo-root" type="button">Browse…</button>
          ${renderWorkstationPickerPanel('session-repo-root')}
          <details class="disclosure compact-disclosure">
            <summary><span>Agent flow</span></summary>
            <div class="disclosure-body">
              <label>Flow
                <select name="flowTemplate">
                  <option value="orchestrator-executor">Orchestrator → executor → orchestrator</option>
                  <option value="orchestrator-executor-audit">Orchestrator → executor → audit → orchestrator</option>
                  <option value="orchestrator-only">Orchestrator only (no executors)</option>
                </select>
              </label>
              <label>Who audits
                <select name="flowAuditTier">
                  <option value="orchestrator">Main orchestrator audits</option>
                  <option value="separate-auditor">Separate auditor / mini-orchestrator</option>
                </select>
              </label>
              <label>On fix request, send work to
                <select name="flowFixRouting">
                  <option value="same-agent">The same agent (retry)</option>
                  <option value="new-agent">A fresh agent (new lane)</option>
                </select>
              </label>
              <label>Max audit to fix loops
                <input name="flowMaxAuditLoops" type="number" min="0" max="10" value="2" />
              </label>
              <label class="check-inline"><input type="checkbox" name="flowRequireAuditPass" /> Require an audit to pass before returning to the orchestrator</label>
            </div>
          </details>
          <button type="submit">Create session</button>
        </form>
        <div class="create-foot">
          <button class="danger" data-action="archiveProject" data-project-id="${safeAttr(project.id)}" data-project-name="${safeAttr(project.name)}" type="button">Archive project</button>
        </div>
      </div>
    </section>
  `);
}
