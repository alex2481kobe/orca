// Per-project / per-session settings modal. Writes the layered
// `settingsOverrides` (src/effective-settings) for a single project or session
// scope: capacity, agent flow, and audit/review policy. It diffs each field
// against the INHERITED (parent-scope) value and only persists genuine
// overrides, so leaving a field at its inherited value keeps inheriting instead
// of pinning it — and "set it back" naturally clears the override.
//
// Reuses the .modal-overlay / .modal chrome from dialog.js (Codex-style; no
// native browser chrome) and the delegated dispatcher wiring in app.js.

import { api } from './api.js';
import { refresh } from './controller.js';
import { renderAlert } from './dom.js';
import { shell } from './state.js';
import { safeText, safeAttr } from './format.js';

// Declarative field spec. `path` is "group.key" into the effective-settings
// schema (must match src/effective-settings/schema.js exactly).
const SECTIONS = [
  {
    title: 'Agents & capacity',
    fields: [
      { path: 'spawn.approvedCapacity', label: 'Executor agents', type: 'number', min: 0, max: 64,
        hint: 'How many executor lanes may run at once.' },
      { path: 'spawn.spawnPolicy', label: 'Spawn policy', type: 'enum',
        options: [['within_capacity', 'Within capacity'], ['ask', 'Ask first'], ['auto', 'Automatic'], ['never', 'Never']],
        hint: 'When the orchestrator may start executor lanes.' },
      { path: 'spawn.soloMode', label: 'Solo mode', type: 'bool',
        hint: 'Keep one executor running at a time.' },
      { path: 'spawn.idleShutdownMode', label: 'Idle shutdown', type: 'enum',
        options: [['immediate', 'Immediate'], ['short_keepalive', 'Short keep-alive'], ['policy', 'By policy']] },
    ],
  },
  {
    title: 'Audit & review',
    fields: [
      { path: 'flow.template', label: 'Flow', type: 'enum',
        options: [['orchestrator-only', 'Orchestrator only'], ['orchestrator-executor', 'Orchestrator + executors'], ['orchestrator-executor-audit', 'Orchestrator + executors + audit']],
        hint: 'How work moves between the orchestrator, executors, and audit.' },
      { path: 'flow.auditTier', label: 'Auditor', type: 'enum',
        options: [['orchestrator', 'The orchestrator audits'], ['separate-auditor', 'A separate auditor agent']],
        hint: 'Who reviews finished executor work.' },
      { path: 'critique.auditAssignment', label: 'Audit assignment', type: 'enum',
        options: [['orchestrator-audits-first', 'Orchestrator audits first'], ['separate-auditor-allowed', 'Separate auditor allowed'], ['separate-auditor-required', 'Separate auditor required']] },
      { path: 'critique.mode', label: 'Critique', type: 'enum',
        options: [['off', 'Off'], ['suggested', 'Suggested'], ['required', 'Required'], ['visual-required', 'Visual required']] },
      { path: 'flow.requireAuditPass', label: 'Require audit pass', type: 'bool',
        hint: 'A lane can’t be marked done until an audit accepts it.' },
      { path: 'flow.maxAuditLoops', label: 'Max audit loops', type: 'number', min: 0, max: 10,
        hint: 'Audit → fix → re-audit cycles before escalating to you.' },
      { path: 'flow.fixRouting', label: 'Fix routing', type: 'enum',
        options: [['same-agent', 'Same executor'], ['new-agent', 'A new executor']] },
    ],
  },
];

function splitPath(path) {
  const [group, key] = path.split('.');
  return { group, key };
}

function readEffective(settings, path) {
  const { group, key } = splitPath(path);
  return settings?.[group]?.[key];
}

async function fetchEffective(query) {
  const response = await api(`/api/settings/effective${query}`);
  if (!response.ok || !response.data) return null;
  return response.data.settings || {};
}

function fieldControl(field, current) {
  const id = `setting-${field.path.replace('.', '-')}`;
  const hint = field.hint ? `<small class="settings-field-hint">${safeText(field.hint)}</small>` : '';
  if (field.type === 'bool') {
    return `
      <label class="settings-field settings-field-row" for="${id}">
        <input type="checkbox" id="${id}" data-path="${safeAttr(field.path)}" data-type="bool"${current ? ' checked' : ''} />
        <span><span class="settings-field-label">${safeText(field.label)}</span>${hint}</span>
      </label>`;
  }
  if (field.type === 'number') {
    return `
      <label class="settings-field" for="${id}">
        <span class="settings-field-label">${safeText(field.label)}</span>${hint}
        <input type="number" id="${id}" data-path="${safeAttr(field.path)}" data-type="number" min="${field.min}" max="${field.max}" value="${safeAttr(String(current ?? ''))}" />
      </label>`;
  }
  const opts = field.options.map(([value, label]) =>
    `<option value="${safeAttr(value)}"${String(current) === value ? ' selected' : ''}>${safeText(label)}</option>`).join('');
  return `
    <label class="settings-field" for="${id}">
      <span class="settings-field-label">${safeText(field.label)}</span>${hint}
      <select id="${id}" data-path="${safeAttr(field.path)}" data-type="enum">${opts}</select>
    </label>`;
}

export async function openScopedSettingsDialog({ scope, id, name }) {
  if (!scope || !id) return;
  const isProject = scope === 'project';
  const thisQuery = isProject ? `?projectId=${encodeURIComponent(id)}` : `?sessionId=${encodeURIComponent(id)}`;
  // Parent scope to diff against: project inherits global; session inherits its project.
  const target = isProject
    ? shell.projects.find((p) => p.id === id)
    : shell.sessions.find((s) => s.id === id);
  const parentQuery = isProject
    ? ''
    : (target?.projectId ? `?projectId=${encodeURIComponent(target.projectId)}` : '');

  const [thisEff, parentEff] = await Promise.all([
    fetchEffective(thisQuery),
    fetchEffective(parentQuery),
  ]);
  if (!thisEff) {
    renderAlert('Could not load settings.', 'bad');
    return;
  }

  const sectionsHtml = SECTIONS.map((section) => `
    <div class="settings-section">
      <h4 class="settings-section-title">${safeText(section.title)}</h4>
      ${section.fields.map((field) => fieldControl(field, readEffective(thisEff, field.path))).join('')}
    </div>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-wide settings-modal" role="dialog" aria-modal="true" aria-label="${safeAttr((isProject ? 'Project' : 'Session') + ' settings')}">
      <div class="settings-modal-head">
        <h3 class="modal-title">${isProject ? 'Project' : 'Session'} settings</h3>
        <p class="settings-modal-sub">${safeText(name || '')}${isProject ? '' : ' · overrides this project'}</p>
      </div>
      <div class="settings-modal-body">${sectionsHtml}</div>
      <div class="modal-actions">
        <button class="modal-cancel secondary" type="button">Cancel</button>
        <button class="modal-confirm" type="button">Save settings</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const previousFocus = document.activeElement;

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    try { previousFocus && previousFocus.focus && previousFocus.focus(); } catch { /* ignore */ }
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('.modal-cancel').addEventListener('click', close);

  overlay.querySelector('.modal-confirm').addEventListener('click', async () => {
    // Start from existing overrides so groups/keys we don't manage are preserved.
    const next = JSON.parse(JSON.stringify(target?.settingsOverrides || {}));
    for (const input of overlay.querySelectorAll('[data-path]')) {
      const { group, key } = splitPath(input.dataset.path);
      const type = input.dataset.type;
      let value;
      if (type === 'bool') value = input.checked;
      else if (type === 'number') value = Number.parseInt(input.value, 10);
      else value = input.value;
      if (type === 'number' && !Number.isFinite(value)) continue;
      const inherited = readEffective(parentEff || {}, input.dataset.path);
      if (value === inherited) {
        // Matches the inherited value -> don't pin it as an override.
        if (next[group]) { delete next[group][key]; if (!Object.keys(next[group]).length) delete next[group]; }
      } else {
        next[group] = next[group] || {};
        next[group][key] = value;
      }
    }
    const response = await api(`/api/settings/${scope}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { actor: 'dashboard', approved: true, settingsOverrides: next },
    });
    if (response.ok) {
      if (target) target.settingsOverrides = next;
      renderAlert(`${isProject ? 'Project' : 'Session'} settings saved.`);
      close();
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required to change settings.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not save settings.', 'bad');
    }
  });

  overlay.querySelector('.modal-confirm').focus();
}
