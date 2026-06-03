// Consolidated composer config popover (Codex-style): one control next to the send
// button that holds Reasoning (effort), Model (submenu), and Speed (submenu). All
// dynamic per chosen agent — the lists come from the CLI's detected capabilities,
// nothing hardcoded. The chosen values live on hidden form inputs (model,
// intelligenceProfile, speed) so form submission / toObj keep working.

import { getExecutorProfile, normalizeExecutorType } from './executor.js';
import { safeText, safeAttr } from './format.js';

// Pretty labels for effort levels (xhigh -> "Extra High"); anything else is title-cased.
const REASONING_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };
const SPEED_OPTIONS = [
  { v: 'standard', label: 'Standard', sub: 'Default speed' },
  { v: 'fast', label: 'Fast', sub: '1.5x speed, increased usage' },
];

function titleCase(s) { return String(s || '').replace(/(^|[\s-])\w/g, (m) => m.toUpperCase()); }
function reasonLabel(v) { return REASONING_LABELS[v] || titleCase(v); }
function shortModel(m) { return String(m || '').replace(/^gpt-/i, '').replace(/^claude-/i, ''); }

function reasoningValues(executorType) {
  const node = getExecutorProfile(executorType)?.capabilities?.controls?.intelligence;
  const vals = Array.isArray(node?.values) ? node.values.filter(Boolean) : [];
  return vals.length ? vals : ['low', 'medium', 'high', 'xhigh'];
}
function modelValues(executorType) {
  const node = getExecutorProfile(executorType)?.capabilities?.controls?.model;
  return Array.isArray(node?.values) ? node.values.filter(Boolean) : [];
}

export function configLabel({ model, intelligence }) {
  const parts = [];
  if (model) parts.push(shortModel(model));
  parts.push(reasonLabel(intelligence || 'high'));
  return parts.join(' ');
}

export function renderComposerConfig(executorType, state = {}) {
  return `
    <div class="cfg">
      <button type="button" class="cfg-trigger" aria-haspopup="menu" aria-expanded="false" title="Model, reasoning &amp; speed">
        <span class="cfg-label">${safeText(configLabel(state))}</span>
        <svg class="cfg-caret" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>
      </button>
      <div class="cfg-pop" role="menu" hidden></div>
    </div>`;
}

// ---- runtime ----
let _open = null;

function form(cfg) { return cfg.closest('form'); }
function field(cfg, name) { return form(cfg)?.querySelector(`input[name="${name}"]`); }
function executorOf(cfg) { return normalizeExecutorType(form(cfg)?.querySelector('select[name="executorType"]')?.value || ''); }
function val(cfg, name) { return field(cfg, name)?.value || ''; }

function setLabel(cfg) {
  cfg.querySelector('.cfg-label').textContent = configLabel({ model: val(cfg, 'model'), intelligence: val(cfg, 'intelligenceProfile') });
}

function mainView(cfg) {
  const ex = executorOf(cfg);
  const reason = val(cfg, 'intelligenceProfile') || 'high';
  const model = val(cfg, 'model');
  const reasonRows = reasoningValues(ex).map((v) =>
    `<button type="button" class="cfg-item cfg-reason${v === reason ? ' selected' : ''}" data-v="${safeAttr(v)}">${safeText(reasonLabel(v))}${v === reason ? '<span class="cfg-check">✓</span>' : ''}</button>`,
  ).join('');
  return `
    <div class="cfg-head">Reasoning</div>
    ${reasonRows}
    <div class="cfg-sep"></div>
    <button type="button" class="cfg-item cfg-row" data-sub="model"><span>${safeText(model ? shortModel(model) : 'Model')}</span><span class="cfg-arrow">›</span></button>
    <button type="button" class="cfg-item cfg-row" data-sub="speed"><span>Speed</span><span class="cfg-arrow">›</span></button>`;
}

function modelView(cfg) {
  const ex = executorOf(cfg);
  const cur = val(cfg, 'model');
  const vals = modelValues(ex);
  const rows = vals.length
    ? vals.map((m) => `<button type="button" class="cfg-item cfg-model${m === cur ? ' selected' : ''}" data-v="${safeAttr(m)}">${safeText(shortModel(m))}${m === cur ? '<span class="cfg-check">✓</span>' : ''}</button>`).join('')
    : '<div class="cfg-note">No preset models for this agent — type one below.</div>';
  return `
    <button type="button" class="cfg-back">‹ Model</button>
    ${rows}
    <div class="cfg-free">
      <input type="text" class="cfg-model-input" placeholder="model slug (e.g. gpt-5.5)" value="${safeAttr(cur)}" aria-label="Custom model" />
      <button type="button" class="cfg-model-use">Use</button>
    </div>`;
}

function speedView(cfg) {
  const cur = val(cfg, 'speed') || 'standard';
  const rows = SPEED_OPTIONS.map((o) =>
    `<button type="button" class="cfg-item cfg-speed${o.v === cur ? ' selected' : ''}" data-v="${o.v}"><span class="cfg-speed-main">${safeText(o.label)}${o.v === cur ? '<span class="cfg-check">✓</span>' : ''}</span><span class="cfg-speed-sub">${safeText(o.sub)}</span></button>`,
  ).join('');
  return `<button type="button" class="cfg-back">‹ Speed</button>${rows}`;
}

function render(cfg, view = 'main') {
  const pop = cfg.querySelector('.cfg-pop');
  pop.innerHTML = view === 'model' ? modelView(cfg) : view === 'speed' ? speedView(cfg) : mainView(cfg);
}

function close() {
  if (!_open) return;
  _open.querySelector('.cfg-pop').hidden = true;
  _open.classList.remove('cfg-active');
  _open.querySelector('.cfg-trigger').setAttribute('aria-expanded', 'false');
  _open = null;
}
function open(cfg) {
  close();
  render(cfg, 'main');
  cfg.querySelector('.cfg-pop').hidden = false;
  cfg.classList.add('cfg-active');
  cfg.querySelector('.cfg-trigger').setAttribute('aria-expanded', 'true');
  _open = cfg;
}

export function initComposerConfig() {
  document.addEventListener('click', (event) => {
    const t = event.target;
    const cfg = t.closest?.('.cfg');
    if (!cfg) { if (!t.closest?.('.cfg-pop')) close(); return; }

    if (t.closest('.cfg-trigger')) {
      event.preventDefault();
      if (_open === cfg) close(); else open(cfg);
      return;
    }
    const reason = t.closest('.cfg-reason');
    if (reason) {
      event.preventDefault();
      const f = field(cfg, 'intelligenceProfile'); if (f) f.value = reason.dataset.v;
      setLabel(cfg); render(cfg, 'main');
      return;
    }
    const row = t.closest('.cfg-row');
    if (row) { event.preventDefault(); render(cfg, row.dataset.sub); return; }
    if (t.closest('.cfg-back')) { event.preventDefault(); render(cfg, 'main'); return; }
    const model = t.closest('.cfg-model');
    if (model) {
      event.preventDefault();
      const f = field(cfg, 'model'); if (f) f.value = model.dataset.v;
      setLabel(cfg); render(cfg, 'main');
      return;
    }
    if (t.closest('.cfg-model-use')) {
      event.preventDefault();
      const input = cfg.querySelector('.cfg-model-input');
      const f = field(cfg, 'model'); if (f) f.value = (input?.value || '').trim();
      setLabel(cfg); render(cfg, 'main');
      return;
    }
    const speed = t.closest('.cfg-speed');
    if (speed) {
      event.preventDefault();
      const f = field(cfg, 'speed'); if (f) f.value = speed.dataset.v;
      render(cfg, 'main');
      return;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'Enter' && event.target.classList?.contains('cfg-model-input')) {
      event.preventDefault();
      event.stopPropagation();
      const cfg = event.target.closest('.cfg');
      const f = field(cfg, 'model'); if (f) f.value = event.target.value.trim();
      setLabel(cfg); render(cfg, 'main');
    }
  });
  document.addEventListener('scroll', (event) => {
    if (event.target?.closest?.('.cfg-pop')) return;
    close();
  }, true);
}
