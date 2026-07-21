// Per-project / per-session settings modal. Writes the layered
// `settingsOverrides` (src/effective-settings) plus the record's own agent
// defaults (executor + model). Each field diffs against the INHERITED
// (parent-scope) value and only persists genuine overrides, so leaving a field
// at its inherited value keeps inheriting instead of pinning it.
//
// Controls are custom dropdowns (no native <select> chrome) with a short
// description under every option, so the meaning is never ambiguous. Reuses the
// .modal-overlay chrome from dialog.js.

import { api } from './api.js';
import { refresh } from './controller.js';
import { renderAlert } from './dom.js';
import { shell } from './state.js';
import { safeText, safeAttr } from './format.js';
import { icon } from './icons.js';

// Executors offered as a per-scope default. Value is stored verbatim on the
// record's `leader`; the composer reads it. (Brief descriptions, since the modal
// shows a description under every option.)
const EXECUTOR_CATALOG = [
  ['codex', 'Codex', 'OpenAI Codex CLI'],
  ['claude', 'Claude', 'Anthropic Claude CLI'],
  ['gemini-cli', 'Gemini CLI', 'Google Gemini CLI'],
  ['composer', 'Composer', 'Cursor Composer CLI'],
  ['openai-compatible', 'OpenAI-compatible API', 'Any OpenAI-style HTTP API'],
  ['gemini', 'Gemini API', 'Google Gemini API'],
  ['kimi', 'Kimi API', 'Moonshot Kimi API'],
  ['deepseek', 'DeepSeek API', 'DeepSeek API'],
  ['openrouter', 'OpenRouter API', 'OpenRouter gateway'],
];

// Declarative field spec. `path` is "group.key" into the effective-settings
// schema (must match src/effective-settings/schema.js). Enum options are
// [value, label, description].
const SECTIONS = [
  {
    title: 'Agents',
    fields: [
      { path: 'spawn.approvedCapacity', label: 'Executor agents', type: 'number', min: 0, max: 64,
        hint: 'How many executor lanes may run at once.' },
      { path: 'spawn.spawnPolicy', label: 'Spawn policy', type: 'enum',
        hint: 'When the orchestrator may start executor lanes.', options: [
          ['within_capacity', 'Within capacity', 'Start lanes while under the executor-agent limit.'],
          ['ask', 'Ask first', 'Ask you before starting each new lane.'],
          ['auto', 'Automatic', 'Start lanes whenever there is work, up to the limit.'],
          ['never', 'Never', 'Don’t auto-start lanes — you create them yourself.'],
        ] },
    ],
  },
  {
    title: 'Audit & review',
    fields: [
      { path: 'flow.template', label: 'Work flow', type: 'enum',
        hint: 'How work moves between the orchestrator, executors, and audit.', options: [
          ['orchestrator-only', 'Orchestrator only', 'The orchestrator does the work itself — no executor lanes.'],
          ['orchestrator-executor', 'Orchestrator + executors', 'The orchestrator delegates to executor agents.'],
          ['orchestrator-executor-audit', 'Orchestrator + executors + audit', 'Executor work is audited before it returns.'],
        ] },
      // Single "Auditor" control (replaces the old auditTier + auditAssignment
      // pair). Maps to flow.auditTier AND critique.auditAssignment on save.
      { path: 'flow.auditTier', label: 'Auditor', type: 'auditor',
        hint: 'Who reviews finished executor work.', options: [
          ['orchestrator', 'The orchestrator', 'The main agent reviews finished work itself.'],
          ['separate-auditor', 'A separate auditor agent', 'A dedicated auditor agent reviews finished work.'],
        ] },
      { path: 'critique.mode', label: 'Self-review', type: 'enum',
        hint: 'Whether an agent critiques its own work before it is considered done.', options: [
          ['off', 'Off', 'No self-review step.'],
          ['suggested', 'Suggested', 'Encourage the agent to self-review.'],
          ['required', 'Required', 'The agent must self-review before finishing.'],
          ['visual-required', 'Required (with visuals)', 'Self-review must include visual / screenshot checks.'],
        ] },
      { path: 'flow.requireAuditPass', label: 'Require audit pass', type: 'bool',
        hint: 'A lane isn’t done until an audit accepts it.' },
      { path: 'flow.maxAuditLoops', label: 'Max audit loops', type: 'number', min: 0, max: 10,
        hint: 'Audit → fix → re-audit cycles before escalating to you.' },
      { path: 'flow.fixRouting', label: 'Fix routing', type: 'enum',
        hint: 'When an audit asks for fixes, who makes them.', options: [
          ['same-agent', 'Same executor', 'Send fixes back to the same executor.'],
          ['new-agent', 'A new executor', 'Hand fixes to a fresh executor.'],
        ] },
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

// Custom dropdown: a trigger pill + a popover of options, each with a
// description. Value lives on the .sd-select element's data-value.
function richSelect({ path, kind, value, options }) {
  const cur = options.find((o) => o[0] === String(value)) || options[0];
  const items = options.map(([v, label, desc]) => `
    <button type="button" class="sd-opt${v === String(value) ? ' is-sel' : ''}" data-v="${safeAttr(v)}" data-label="${safeAttr(label)}" role="option" aria-selected="${v === String(value)}">
      <span class="sd-opt-main">${safeText(label)}${v === String(value) ? '<span class="sd-opt-check">✓</span>' : ''}</span>
      ${desc ? `<span class="sd-opt-desc">${safeText(desc)}</span>` : ''}
    </button>`).join('');
  return `
    <div class="sd-select" data-path="${safeAttr(path)}" data-kind="${safeAttr(kind)}" data-value="${safeAttr(String(value))}">
      <button type="button" class="sd-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="sd-trigger-label">${safeText(cur ? cur[1] : '')}</span>
        ${icon('chevron-down', { cls: 'sd-caret', size: 16 })}
      </button>
      <div class="sd-pop" role="listbox" hidden>${items}</div>
    </div>`;
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
  // enum / auditor -> custom dropdown
  return `
    <div class="settings-field">
      <span class="settings-field-label">${safeText(field.label)}</span>${hint}
      ${richSelect({ path: field.path, kind: field.type, value: current, options: field.options })}
    </div>`;
}

export async function openScopedSettingsDialog({ scope, id, name }) {
  if (!scope || !id) return;
  const isProject = scope === 'project';
  const thisQuery = isProject ? `?projectId=${encodeURIComponent(id)}` : `?sessionId=${encodeURIComponent(id)}`;
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

  // Defaults (executor + model) live on the record, not in settingsOverrides.
  const currentExecutor = target?.leader || (isProject ? '' : 'codex');
  const currentModel = target?.defaultModel || '';
  const execOptions = isProject
    ? [['', 'Auto (Codex)', 'New sessions fall back to Codex.'], ...EXECUTOR_CATALOG]
    : EXECUTOR_CATALOG;
  const defaultsHtml = `
    <div class="settings-section">
      <h4 class="settings-section-title">Defaults</h4>
      <div class="settings-field">
        <span class="settings-field-label">Default executor</span>
        <small class="settings-field-hint">The agent new lanes${isProject ? ' and sessions' : ''} start with.</small>
        ${richSelect({ path: '__executor', kind: 'executor', value: currentExecutor, options: execOptions })}
      </div>
      <label class="settings-field" for="setting-default-model">
        <span class="settings-field-label">Default model</span>
        <small class="settings-field-hint">Blank inherits ${isProject ? 'the executor default' : 'the project / executor default'}.</small>
        <input type="text" id="setting-default-model" value="${safeAttr(currentModel)}" placeholder="e.g. gpt-5.5-codex (blank = default)" />
      </label>
    </div>`;

  const sectionsHtml = defaultsHtml + SECTIONS.map((section) => `
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

  const closePops = (except) => {
    for (const pop of overlay.querySelectorAll('.sd-pop')) {
      if (pop === except) continue;
      pop.hidden = true;
      pop.previousElementSibling?.setAttribute('aria-expanded', 'false');
    }
  };
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

  // Custom-dropdown interactions (open/close, select).
  overlay.addEventListener('click', (event) => {
    const trigger = event.target.closest('.sd-trigger');
    if (trigger) {
      const pop = trigger.nextElementSibling;
      const willOpen = pop.hidden;
      closePops(willOpen ? pop : null);
      pop.hidden = !willOpen;
      trigger.setAttribute('aria-expanded', String(willOpen));
      return;
    }
    const opt = event.target.closest('.sd-opt');
    if (opt) {
      const select = opt.closest('.sd-select');
      const value = opt.dataset.v;
      select.dataset.value = value;
      select.querySelector('.sd-trigger-label').textContent = opt.dataset.label || '';
      for (const o of select.querySelectorAll('.sd-opt')) {
        const sel = o === opt;
        o.classList.toggle('is-sel', sel);
        o.setAttribute('aria-selected', String(sel));
        const existing = o.querySelector('.sd-opt-check');
        if (sel && !existing) o.querySelector('.sd-opt-main').insertAdjacentHTML('beforeend', '<span class="sd-opt-check">✓</span>');
        if (!sel && existing) existing.remove();
      }
      closePops(null);
      return;
    }
    // Click elsewhere inside the modal closes any open dropdown.
    if (!event.target.closest('.sd-pop')) closePops(null);
  });

  overlay.querySelector('.modal-cancel').addEventListener('click', close);

  overlay.querySelector('.modal-confirm').addEventListener('click', async () => {
    const next = JSON.parse(JSON.stringify(target?.settingsOverrides || {}));
    const applyOverride = (path, value) => {
      const { group, key } = splitPath(path);
      const inherited = readEffective(parentEff || {}, path);
      if (value === inherited) {
        if (next[group]) { delete next[group][key]; if (!Object.keys(next[group]).length) delete next[group]; }
      } else {
        next[group] = next[group] || {};
        next[group][key] = value;
      }
    };

    // Number / boolean inputs.
    for (const input of overlay.querySelectorAll('input[data-path]')) {
      const type = input.dataset.type;
      let value;
      if (type === 'bool') value = input.checked;
      else if (type === 'number') { value = Number.parseInt(input.value, 10); if (!Number.isFinite(value)) continue; }
      else value = input.value;
      applyOverride(input.dataset.path, value);
    }
    // Custom dropdowns (enum / auditor); executor handled separately.
    for (const select of overlay.querySelectorAll('.sd-select')) {
      const kind = select.dataset.kind;
      const value = select.dataset.value;
      if (kind === 'executor') continue;
      if (kind === 'auditor') {
        applyOverride('flow.auditTier', value);
        applyOverride('critique.auditAssignment', value === 'separate-auditor' ? 'separate-auditor-required' : 'orchestrator-audits-first');
      } else {
        applyOverride(select.dataset.path, value);
      }
    }

    // Defaults -> record patch.
    const execSel = overlay.querySelector('.sd-select[data-kind="executor"]');
    const nextExecutor = execSel ? execSel.dataset.value : currentExecutor;
    const nextModel = (overlay.querySelector('#setting-default-model')?.value || '').trim();
    const recordPatch = {};
    if (nextExecutor !== currentExecutor && (isProject || nextExecutor)) recordPatch.leader = nextExecutor;
    if (nextModel !== currentModel) recordPatch.defaultModel = nextModel;

    if (Object.keys(recordPatch).length) {
      const recResp = await api(`/api/${scope}s/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { actor: 'dashboard', approved: true, ...recordPatch },
      });
      if (!recResp.ok) {
        renderAlert(recResp.data?.error || 'Could not save defaults.', 'bad');
        return;
      }
      if (target) {
        if (recordPatch.leader !== undefined) target.leader = recordPatch.leader;
        if (recordPatch.defaultModel !== undefined) target.defaultModel = recordPatch.defaultModel;
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
