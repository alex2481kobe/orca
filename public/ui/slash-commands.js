// Codex-style "/" command palette for the composer. Typing "/" surfaces a fuzzy,
// flat list of the things each terminal agent actually exposes — model, reasoning
// effort, fast/standard speed, git branch — plus /status and /help. Everything is
// derived from the selected agent's detected capabilities (nothing hardcoded), so
// it mirrors what that CLI supports. Selecting a row applies it to the composer's
// hidden config fields (the same ones the config pill drives).

import { shell } from './state.js';
import { normalizeExecutorType } from './executor.js';
import {
  reasoningValues, modelItems, speedSupported, reasonLabel, shortModel, refreshConfigLabel,
} from './composer-config.js';
import { safeText } from './format.js';

let _rows = [];
let _sel = 0;
let _info = '';

function activeForm() { return document.getElementById('orchestrator-message-form'); }
function textareaOf(form) { return form?.querySelector('textarea[name="message"]'); }
function menuOf(form) { return form?.querySelector('.slash-menu'); }
function executorOf(form) { return normalizeExecutorType(form?.querySelector('select[name="executorType"]')?.value || ''); }
function fieldOf(form, name) { return form?.querySelector(`input[name="${name}"]`); }
function val(form, name) { return fieldOf(form, name)?.value || ''; }

function statusText(form) {
  const ex = executorOf(form);
  const model = val(form, 'model');
  const speed = val(form, 'speed') || 'standard';
  const branch = val(form, 'branch') || shell.gitInfo?.[form.dataset.sessionId]?.currentBranch || '(none)';
  return `agent ${ex} · model ${model ? shortModel(model) : '(default)'} · reasoning ${reasonLabel(val(form, 'intelligenceProfile') || 'high')} · speed ${speed} · branch ${branch}`;
}

// Every concrete command-row available for the current agent (flat, fuzzy-filtered).
function buildRows(form) {
  const ex = executorOf(form);
  const git = shell.gitInfo?.[form.dataset.sessionId];
  const rows = [];
  modelItems(ex).forEach((m) => rows.push({
    label: `/model ${shortModel(m.v)}`, hint: m.label && m.label !== shortModel(m.v) ? m.label : 'model',
    run: () => applyConfig(form, 'model', m.v),
  }));
  reasoningValues(ex, val(form, 'model')).forEach((r) => rows.push({
    label: `/effort ${r}`, hint: reasonLabel(r),
    run: () => applyConfig(form, 'intelligenceProfile', r),
  }));
  if (speedSupported(ex)) {
    rows.push({ label: '/fast', hint: '1.5× speed', run: () => applyConfig(form, 'speed', 'fast') });
    rows.push({ label: '/standard', hint: 'default speed', run: () => applyConfig(form, 'speed', 'standard') });
  }
  if (git?.isGit) {
    (git.branches || []).forEach((b) => rows.push({
      label: `/branch ${b}`, hint: b === git.currentBranch ? 'current' : 'branch',
      run: () => applyConfig(form, 'branch', b),
    }));
  }
  rows.push({ label: '/status', hint: 'show current config', run: () => { _info = statusText(form); renderMenu(form); } });
  rows.push({ label: '/help', hint: 'list commands', run: () => { _info = 'Commands: /model /effort' + (speedSupported(ex) ? ' /fast /standard' : '') + (git?.isGit ? ' /branch' : '') + ' /status /help'; renderMenu(form); } });
  return rows;
}

function applyConfig(form, name, value) {
  const f = fieldOf(form, name);
  if (f) f.value = value;
  refreshConfigLabel(form);
  if (name === 'branch') {
    const pill = document.querySelector('.ctx-pill[data-ctx-menu="branch"] .ctx-pill-label');
    if (pill) pill.textContent = value || shell.gitInfo?.[form.dataset.sessionId]?.currentBranch || 'branch';
  }
  const ta = textareaOf(form);
  if (ta) { ta.value = ''; if (shell.composerDrafts) shell.composerDrafts[form.dataset.sessionId] = ''; }
  hideMenu(form);
  ta?.focus();
}

function hideMenu(form) {
  const m = menuOf(form);
  if (m) { m.hidden = true; m.innerHTML = ''; }
  _rows = []; _sel = 0; _info = '';
}

function renderMenu(form) {
  const m = menuOf(form);
  if (!m) return;
  const list = _rows.map((r, i) =>
    `<button type="button" class="slash-row${i === _sel ? ' sel' : ''}" data-i="${i}" role="option"><span class="slash-cmd">${safeText(r.label)}</span><span class="slash-hint">${safeText(r.hint || '')}</span></button>`,
  ).join('');
  m.innerHTML = list + (_info ? `<div class="slash-info">${safeText(_info)}</div>` : '');
  m.hidden = false;
}

function refilter(form) {
  const ta = textareaOf(form);
  const text = ta?.value || '';
  if (!text.startsWith('/')) { hideMenu(form); return; }
  _info = '';
  const q = text.slice(1).toLowerCase().trim();
  const all = buildRows(form);
  _rows = q ? all.filter((r) => r.label.toLowerCase().includes(q)) : all;
  // Offer to create a branch the user is typing that doesn't exist yet.
  const git = shell.gitInfo?.[form.dataset.sessionId];
  const branchMatch = /^branch\s+(.+)$/.exec(q);
  if (git?.isGit && branchMatch) {
    const name = text.slice(1).trim().replace(/^branch\s+/i, '').trim();
    if (name && !(git.branches || []).some((b) => b.toLowerCase() === name.toLowerCase())) {
      _rows = [{ label: `/branch ${name}`, hint: 'create', run: () => applyConfig(form, 'branch', name) }, ..._rows];
    }
  }
  if (!_rows.length) { hideMenu(form); return; }
  _sel = Math.max(0, Math.min(_sel, _rows.length - 1));
  renderMenu(form);
}

function isOpen(form) { const m = menuOf(form); return m && !m.hidden; }

export function initSlashCommands() {
  // Filter as the user types.
  document.addEventListener('input', (event) => {
    const t = event.target;
    if (!t || t.name !== 'message') return;
    const form = t.closest('#orchestrator-message-form');
    if (form) refilter(form);
  });

  // Capture phase so we intercept Enter/Arrows BEFORE the Enter-to-send handler.
  document.addEventListener('keydown', (event) => {
    const t = event.target;
    if (!t || t.name !== 'message') return;
    const form = t.closest('#orchestrator-message-form');
    if (!form || !isOpen(form)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault(); event.stopPropagation();
      _sel = (_sel + 1) % _rows.length; renderMenu(form);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      _sel = (_sel - 1 + _rows.length) % _rows.length; renderMenu(form);
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      _rows[_sel]?.run();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      hideMenu(form);
    }
  }, true);

  // Click a row to run it.
  document.addEventListener('click', (event) => {
    const row = event.target.closest?.('.slash-row');
    if (!row) return;
    const form = row.closest('#orchestrator-message-form');
    if (!form) return;
    event.preventDefault();
    const i = Number(row.dataset.i);
    if (Number.isInteger(i)) _rows[i]?.run();
  });
}
