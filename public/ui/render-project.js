// Render view module (split from render-views.js).

import { refs, shell } from './state.js';
import { formatRelative, latestTimestamp, safeAttr, safeText } from './format.js';
import { clientUrl, safeHref } from './dom.js';
import { effectiveProjectQuickLinkUrl, quickLinkHealthLabel } from './access-mode.js';

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
  const sessionsMarkup = shell.sessions.filter((session) => session.projectId === project.id).map((session) => {
    const route = session.route;
    const sessionLanes = shell.lanes.filter((lane) => lane.sessionId === session.id);
    const latestActivity = latestTimestamp([...sessionLanes, session]);
    return `
      <article class="card click-card session-card" data-href="${safeAttr(route)}" tabindex="0" role="link" aria-label="Open ${safeAttr(session.name)} session">
        <div class="card-kicker">Session</div>
        <h3>${safeText(session.name)}</h3>
        <p>${safeText(sessionLanes.length)} lane${sessionLanes.length === 1 ? '' : 's'} coordinated by ${safeText(session.leader)}.</p>
        <div class="card-meta">
          <span>${safeText(session.laneConcurrencyLimit)} max parallel</span>
          <span>${safeText(formatRelative(latestActivity))}</span>
        </div>
        <div class="lane-row"><a href="${safeAttr(route)}" class="secondary">Open session</a></div>
      </article>
    `;
  }).join('');
  const createSessionOpen = window.location.hash === '#create-session' || !sessionsMarkup;
  const quickLinks = Array.isArray(project.quickLinks) ? project.quickLinks.filter((quick) => !quick.hidden) : [];
  const quickLinksMarkup = quickLinks
    .map((quick) => {
      const url = clientUrl(effectiveProjectQuickLinkUrl(quick));
      return `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.label)}</a>`;
    })
    .join('');
  const quickLinkRows = quickLinks.map((quick) => {
    const url = clientUrl(effectiveProjectQuickLinkUrl(quick));
    const detail = [
      quick.kind || 'other',
      quick.port ? `:${quick.port}` : '',
      quick.lastCheckedAt ? `checked ${formatRelative(quick.lastCheckedAt)}` : 'not checked',
    ].filter(Boolean).join(' / ');
    return `
      <div class="lane-row">
        <div>
          <div>${safeText(quick.label || 'Live link')}</div>
          <a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${safeText(url)}</a>
          <div class="tiny muted">${safeText(detail)}</div>
          <div class="tiny">${safeText(quickLinkHealthLabel(quick.healthStatus))}${quick.lastStatusCode ? ` / HTTP ${safeText(quick.lastStatusCode)}` : ''}</div>
        </div>
        <div class="lane-row">
          <button class="secondary" data-action="checkProjectQuickLink" data-project-id="${safeAttr(project.id)}" data-link-id="${safeAttr(quick.id)}" type="button">Check</button>
          <button class="secondary" data-action="deleteProjectQuickLink" data-project-id="${safeAttr(project.id)}" data-link-id="${safeAttr(quick.id)}" type="button">Remove</button>
        </div>
      </div>
    `;
  }).join('');

  refs.content.innerHTML = `
    <section class="project-shell">
      <div class="project-workspace">
        <div class="project-main">
          <article class="card control-card">
            <details class="disclosure" ${createSessionOpen ? 'open' : ''}>
              <summary>
                <span>Create session</span>
                <small>Start a new work board</small>
              </summary>
              <div class="disclosure-body">
            <form id="create-session-form" data-project-id="${project.id}">
              <label>Session name
                <input name="name" required />
              </label>
              <label>Leader
                <select name="leader">
                  <option value="codex">Codex-led</option>
                  <option value="claude">Claude-led</option>
                  <option value="mixed">Mixed</option>
                </select>
              </label>
              <label>Max parallel lanes (executor capacity cap)
                <input name="laneConcurrencyLimit" type="number" min="1" max="4" value="1" />
              </label>
              <label>Working directory (workstation repo)
                <input id="session-repo-root" name="repoRoot" placeholder="Pick a folder on the workstation…" autocomplete="off" />
              </label>
              <button class="secondary" data-action="browseWorkstation" data-for-input="session-repo-root" type="button">Browse workstation…</button>
              ${renderWorkstationPickerPanel('session-repo-root')}
              <button type="submit">Create session</button>
            </form>
              </div>
            </details>
          </article>
          <article class="card">
          <h3>Sessions</h3>
          <div class="card-grid">${sessionsMarkup || '<div class="muted">No sessions yet.</div>'}</div>
          </article>
        </div>
        <aside class="project-side-panel" id="project-tools" aria-label="Project tools">
          <details class="disclosure">
            <summary>
              <span>Quick links</span>
              <small>Dev routes</small>
            </summary>
            <div class="disclosure-body">
              <div class="lane-row">${quickLinksMarkup || '<span class="muted">No quick links.</span>'}</div>
              <div class="card-grid">
                ${quickLinkRows || '<div class="muted">No quick links.</div>'}
              </div>
              <form id="update-project-links-form" data-project-id="${project.id}">
                <label>Quick link label
                  <input name="quickLinkLabel" placeholder="My web app" required />
                </label>
                <label>Quick link URL
                  <input name="quickLinkUrl" placeholder="http://localhost:5173" required />
                </label>
                <div class="grid-2">
                  <label>Kind
                    <select name="quickLinkKind">
                      <option value="vite">Vite</option>
                      <option value="dev-server">Dev server</option>
                      <option value="preview">Preview</option>
                      <option value="dashboard">Dashboard</option>
                      <option value="artifact">Artifact</option>
                      <option value="docs">Docs</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label>Port
                    <input name="quickLinkPort" type="number" min="1" max="65535" placeholder="5173" />
                  </label>
                </div>
                <label><input type="checkbox" name="quickLinkFavorite"> Favorite</label>
                <details class="disclosure compact-disclosure">
                  <summary><span>Remote variants</span><small>optional</small></summary>
                  <div class="disclosure-body">
                    <label>Local URL
                      <input name="quickLinkLocalUrl" placeholder="http://127.0.0.1:5173" />
                    </label>
                    <label>Tailnet HTTP URL
                      <input name="quickLinkTailnetHttpUrl" placeholder="http://device.tailnet.ts.net:5173" />
                    </label>
                    <label>HTTPS Serve URL
                      <input name="quickLinkHttpsServeUrl" placeholder="https://device.tailnet.ts.net" />
                    </label>
                  </div>
                </details>
                <button type="submit">Save live link</button>
              </form>
            </div>
          </details>
          <details class="disclosure">
            <summary>
              <span>Operations</span>
              <small>Global tools</small>
            </summary>
            <div class="disclosure-body action-list">
              <button class="danger" data-action="archiveProject" data-project-id="${safeAttr(project.id)}" data-project-name="${safeAttr(project.name)}" type="button">Archive project</button>
              <a href="/#notifications">Notifications</a>
              <a href="/#audit">Audit queue</a>
              <a href="/#mcp">MCP tools</a>
              <a href="/#cleanup">Cleanup</a>
              <a href="/#token">API token</a>
            </div>
          </details>
        </aside>
      </div>
    </section>
  `;
}
