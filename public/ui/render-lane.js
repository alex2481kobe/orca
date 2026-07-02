// Render view module (split from render-views.js).

import { safeHref } from './dom.js';
import { formatMeta, safeAttr, safeText, stateBadge } from './format.js';
import { api } from './api.js';
import { activeHomePanel, executorCapabilitiesFor, isLiveLaneState, isRestartableLaneState, laneDetailRoute, pendingAuditsForLane, renderExecutorCapabilities } from './render-helpers.js';
import { renderApprovalRows } from './render-session-parts.js';
import { refs, shell } from './state.js';
import { showArtifacts } from './controller.js';
import { renderAgentEventTimeline } from './render-fragments.js';

export function renderLane(project, session, lane) {
  if (!lane) {
    return `
      <section>
        <div class="card">
          <h3>Lane not found</h3>
          <p>The selected lane is not in this session yet.</p>
          <a class="secondary" href="${safeHref(session.route)}">Back to session</a>
        </div>
      </section>
    `;
  }

  // Offer Stop whenever the lane is live OR a child process is still up (e.g. an
  // auditing/needs_critique lane whose agent hasn't exited) — base it on the real
  // runtime, not only the curated live-state list.
  const hasLiveProcess = Boolean(lane.processMeta && lane.processMeta.pid && !lane.processMeta.endedAt);
  const stopButton = (isLiveLaneState(lane.state) || hasLiveProcess)
    ? `<button data-action="stopLane" data-lane-id="${safeAttr(lane.id)}" type="button">Stop lane</button>` : '';
  const retryButton = isRestartableLaneState(lane.state)
    ? `<button class="secondary" data-action="retryLane" data-lane-id="${safeAttr(lane.id)}" type="button">Retry lane</button>` : '';
  // Escalated audit (loop budget exhausted / auditor couldn't finish) is otherwise
  // a dead end — let the operator accept the work to clear it.
  const overrideAuditButton = lane.auditState === 'escalated'
    ? `<button class="secondary" data-action="overrideAcceptAudit" data-lane-id="${safeAttr(lane.id)}" type="button">Accept (override)</button>` : '';
  // Delete is only for terminal lanes with no live process (never orphans a child).
  const deletableLane = !isLiveLaneState(lane.state) && !hasLiveProcess
    && ['done', 'failed', 'stopped', 'accepted', 'blocked', 'archived'].includes(String(lane.state || '').toLowerCase());
  const deleteButton = deletableLane
    ? `<button class="secondary" data-action="deleteLane" data-lane-id="${safeAttr(lane.id)}" data-lane-title="${safeAttr(lane.title || '')}" type="button">Delete lane</button>` : '';
  const laneIdEnc = encodeURIComponent(lane.id);
  const artifactUrl = `/api/lanes/${laneIdEnc}/artifacts`;
  const evidenceUrl = `/api/lanes/${laneIdEnc}/evidence`;
  const evidenceLatestUrl = `/api/lanes/${laneIdEnc}/evidence/latest`;
  const pendingAudits = pendingAuditsForLane(lane.id);
  const pendingAuditRows = pendingAudits.length
    ? pendingAudits.map((event) => `<div>${safeText(event.type)} (${safeText(event.id.slice(0, 8))})</div>`).join('')
    : '<div>None</div>';
  const auditLabel = pendingAudits.length ? 'Refresh audit queue' : 'Audit now';
  const laneLogs = Array.isArray(lane.logs) ? lane.logs.slice(-8) : [];
  const executorMonitorNote = lane.owner !== 'orchestrator'
    ? '<div class="alert">Executor monitor is read-only. Use Stop to interrupt the process; send new direction through the orchestrator chat.</div>'
    : '';

  const laneApprovals = (lane.pendingApprovals || []).some((entry) => entry.status === 'pending')
    ? `<article class="approvals-banner"><div class="card-kicker">Agent is asking for permission</div>${renderApprovalRows(lane)}</article>`
    : '';

  return `
    <section class="lane-detail-shell">
      ${executorMonitorNote}
      ${laneApprovals}
      ${(lane.warnings || []).map((warning) => `
        <div class="alert bad"><strong>Warning:</strong> ${safeText(warning.message || warning.kind)}</div>
      `).join('')}
      <div class="card lane-detail-card">
        <p><a href="${safeHref(session.route)}" class="secondary">Back</a></p>
        <h3>${safeText(lane.title)}</h3>
        <p>${safeText(lane.taskDescription || 'No task description')}</p>
        ${lane.taskPrompt ? `<div class="tiny"><strong>Task prompt:</strong> ${safeText(lane.taskPrompt)}</div>` : ''}
        ${lane.targetUrl ? `<div class="tiny"><strong>Target URL:</strong> <a class="secondary" href="${safeHref(lane.targetUrl)}" target="_blank" rel="noopener noreferrer">${safeText(lane.targetUrl)}</a></div>` : ''}
        <div class="tiny">Owner: ${safeText(lane.owner)} / Executor: ${safeText(lane.executorType)} / State: ${stateBadge(lane.state)}${lane.auditState && lane.auditState !== 'not_queued' ? ` / Audit: ${stateBadge(lane.auditState)}` : ''}</div>
      </div>
      <div class="card">
        <div class="lane-row">
          ${stopButton}
          ${retryButton}
          ${overrideAuditButton}
          <button class="secondary" data-action="captureEvidence" data-lane-id="${safeAttr(lane.id)}" type="button">Capture evidence</button>
          <button class="secondary" data-action="auditLane" data-lane-id="${safeAttr(lane.id)}" type="button">${auditLabel}</button>
          ${deleteButton}
        </div>
      </div>
      ${lane.state === 'needs_critique' ? `
      <div class="card">
        <div class="card-kicker">Self-review required</div>
        <p class="tiny muted">This lane finished but needs a self-review before it can go to audit.${lane.critiqueMode === 'visual-required' ? ' Capture a screenshot first, or waive.' : ''}</p>
        <div class="lane-row">
          <button data-action="markCritiqueDone" data-lane-id="${safeAttr(lane.id)}" type="button">Mark self-review complete</button>
          <button class="secondary" data-action="waiveCritique" data-lane-id="${safeAttr(lane.id)}" type="button">Waive review</button>
        </div>
      </div>` : ''}
      <details class="disclosure card">
        <summary>
          <span>Details</span>
          <small>metadata, APIs, worktree</small>
        </summary>
        <div class="disclosure-body">
          <div class="tiny muted">MCP tools: ${(lane.mcpTools || []).map((item) => safeText(item.name)).join(', ') || 'none'}</div>
          <div class="tiny muted">Route: ${safeText(laneDetailRoute(project, session, lane))}</div>
          ${lane.model || lane.permissionsProfile || lane.intelligenceProfile || lane.branch ? `<div class="tiny">Model: ${safeText(lane.model || '—')} / Mode: ${safeText(lane.permissionsProfile || '—')} / Intelligence: ${safeText(lane.intelligenceProfile || '—')} / Branch: ${safeText(lane.branch || '—')}</div>` : ''}
          ${renderExecutorCapabilities(lane.executorCapabilities || executorCapabilitiesFor(lane.executorType))}
          ${lane.workdir ? `<div class="tiny">Workdir: ${safeText(lane.workdir)}</div>` : ''}
          ${lane.processMeta && lane.processMeta.pid !== null ? `<div class="tiny">Process: PID ${safeText(String(lane.processMeta.pid))} / exit ${safeText(String(lane.processMeta.exitCode ?? '—'))} / signal ${safeText(String(lane.processMeta.signal ?? '—'))}${lane.processMeta.stopRequestedBy ? ' / stopped by ' + safeText(lane.processMeta.stopRequestedBy) : ''}</div>` : ''}
          <div class="tiny">Pending audits: ${pendingAudits.length}</div>
          <div class="tiny">Pending events: ${pendingAuditRows}</div>
          <div class="tiny">Created: ${formatMeta(lane.createdAt)} / Started: ${formatMeta(lane.startedAt)} / Completed: ${formatMeta(lane.completedAt)}</div>
          <div class="lane-row">
            <button class="secondary" data-action="clearEvidence" data-lane-id="${safeAttr(lane.id)}" type="button">Clear evidence</button>
            <button class="secondary" data-action="showArtifacts" data-lane-id="${safeAttr(lane.id)}" type="button">Artifacts</button>
            ${lane.worktreePath && lane.repoRoot ? `<button class="secondary" data-action="removeWorktree" data-lane-id="${safeAttr(lane.id)}" type="button">Remove worktree</button>` : ''}
            <a class="secondary" href="${safeHref(artifactUrl)}" target="_blank" rel="noopener noreferrer">Artifacts API</a>
            <a class="secondary" href="${safeHref(evidenceUrl)}" target="_blank" rel="noopener noreferrer">Evidence API</a>
            <a class="secondary" href="${safeHref(evidenceLatestUrl)}" target="_blank" rel="noopener noreferrer">Latest evidence API</a>
          </div>
        </div>
      </details>
      <details class="disclosure card" data-uikey="lane-live-terminal" open>
        <summary>
          <span>Live terminal</span>
          <small>raw output, streaming</small>
        </summary>
        <div class="disclosure-body">
          <div id="lane-stream-${safeAttr(lane.id)}" class="lane-stream" data-interactive-terminal="${lane.processMeta?.terminalWrapper === 'pty' && ['starting', 'running'].includes(lane.state) ? 'true' : 'false'}" aria-live="polite" tabindex="0">Connecting to live output…</div>
        </div>
      </details>
      <details class="disclosure card">
        <summary>
          <span>Agent activity</span>
          <small>${safeText(String(lane.agentEventCount ?? (lane.agentEvents || []).length))} events</small>
        </summary>
        <div class="disclosure-body">
          ${renderAgentEventTimeline(lane, { limit: 120, compact: true })}
        </div>
      </details>
      <details class="disclosure card">
        <summary>
          <span>Recent logs</span>
          <small>${safeText(laneLogs.length)} entries</small>
        </summary>
        <pre>${safeText(JSON.stringify(laneLogs, null, 2))}</pre>
      </details>
      <div class="card">
        <h4>Last evidence</h4>
        <div class="tiny muted">Captured: ${safeText(lane.lastEvidenceCaptureAt || 'never')}</div>
        <div class="tiny muted">Result: ${safeText(lane.lastEvidence?.status || 'not captured')}</div>
      </div>
      <div class="card">
        <h4>Evidence gallery</h4>
        <div id="evidence-gallery-${safeAttr(lane.id)}" class="tiny muted">Loading latest evidence...</div>
      </div>
      <div id="lane-artifacts-${safeAttr(lane.id)}" class="card tiny"></div>
    </section>
  `;
}

export async function loadEvidenceGallery(laneId) {
  const target = document.getElementById(`evidence-gallery-${laneId}`);
  if (!target) return;
  try {
    const [latest, presets] = await Promise.all([
      api(`/api/lanes/${laneId}/evidence/latest`),
      api(`/api/lanes/${laneId}/evidence/presets`),
    ]);
    const files = latest.data?.files || {};
    const presetList = presets.data?.presets || [];
    const tiles = ['screenshot', 'video', 'trace', 'log'].map((mode) => {
      const item = files[mode];
      if (!item) return `<div class="card"><strong>${mode}</strong><div class="tiny muted">none yet</div></div>`;
      const link = `<a class="secondary" href="${safeHref(item.url)}" target="_blank" rel="noopener noreferrer">Open</a>`;
      const preview = mode === 'screenshot'
        ? `<img src="${safeHref(item.url)}" alt="${safeAttr(mode)}" style="max-width:100%;border-radius:var(--radius-sm);margin-top:0.4rem" loading="lazy" />`
        : '';
      return `<div class="card"><strong>${mode}</strong><div class="tiny">${safeText(item.name)} · ${safeText(item.at)}</div>${preview}<div style="margin-top:0.4rem">${link}</div></div>`;
    }).join('');
    const presetsRow = presetList.length
      ? `<div class="lane-row" style="margin-top:0.4rem">${presetList.map((preset) => `<button class="secondary" data-action="captureEvidencePreset" data-lane-id="${safeAttr(laneId)}" data-preset-id="${safeAttr(preset.id)}" data-preset-label="${safeAttr(preset.label || preset.url)}" type="button">${safeText(preset.label || preset.url)}</button>`).join('')}</div>`
      : '<div class="tiny muted">No presets — set a lane target URL or project quick links to populate.</div>';
    target.innerHTML = `${presetsRow}<div class="card-grid" style="margin-top:0.5rem">${tiles}</div>`;
  } catch {
    target.textContent = 'Could not load evidence gallery.';
  }
}

export function renderAuditLog() {
  if (activeHomePanel() !== 'audit') return;
  const events = Array.isArray(shell.pendingAuditEvents) ? shell.pendingAuditEvents : [];
  if (!events.length) {
    refs.actions.innerHTML = `
      <section class="home-hero">
        <div>
          <div class="card-kicker">Audit queue</div>
          <h2>No pending audits.</h2>
          <p class="muted">Finished lanes that need review will show up here.</p>
        </div>
        <a class="nav-tile" href="#projects">Back to projects</a>
      </section>
    `;
    return;
  }
  const rows = events.map((event) => {
    const project = shell.projects.find((value) => value.id === event.projectId);
    const laneRoute = project && event.sessionId && event.laneId
      ? `${project.route}/sessions/${event.sessionId}/lanes/${event.laneId}`
      : '';
    return `
      <article class="card">
        <p><strong>${safeText(event.summary || event.type || 'Audit event')}</strong></p>
        <div class="tiny">Type: ${safeText(event.type || 'unknown')}</div>
        <div class="tiny">Project: ${safeText(event.projectId || 'unknown')}</div>
        <div class="tiny">Lane: ${safeText(event.laneId || 'n/a')}</div>
        ${laneRoute ? `<a class="secondary" href="${safeHref(laneRoute)}">Open lane</a>` : ''}
        <div class="lane-row" style="margin-top:0.75rem">
          <button class="secondary" data-action="ackAuditEvent" data-event-id="${safeAttr(event.id)}" type="button">Mark reviewed</button>
        </div>
      </article>
    `;
  }).join('');
  refs.actions.innerHTML = `<div class="card"><h3>Open audit queue</h3><div class="card-grid">${rows}</div></div>`;
}
