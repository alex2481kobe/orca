// Consolidated composer config popover (Codex-style): one control next to the send
// button that holds Reasoning (effort), Model (submenu), and Speed (submenu). All
// dynamic per chosen agent — the lists come from the CLI's detected capabilities,
// nothing hardcoded. The chosen values live on hidden form inputs (model,
// intelligenceProfile, speed) so form submission / toObj keep working.

import { getExecutorProfile, normalizeExecutorType } from './executor.js';
import { safeText, safeAttr } from './format.js';

// Pretty labels for effort levels (xhigh -> "Extra High"); anything else is title-cased.
const REASONING_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultracode: 'Ultracode' };
const SPEED_OPTIONS = [
  { v: 'standard', label: 'Standard', sub: 'Default speed' },
  { v: 'fast', label: 'Fast', sub: '1.5x speed, increased usage' },
];

function titleCase(s) { return String(s || '').replace(/(^|[\s-])\w/g, (m) => m.toUpperCase()); }
export function reasonLabel(v) { return REASONING_LABELS[v] || titleCase(v); }
export function shortModel(m) { return String(m || '').replace(/^gpt-/i, '').replace(/^claude-/i, ''); }

// Reasoning levels are PER-MODEL when the CLI exposes a catalog (codex lists each
// model's supported_reasoning_levels), else per-CLI from detected capabilities,
// else a generic fallback. This is what keeps codex on low/medium/high/xhigh (no
// "max") while claude surfaces its real low/medium/high/xhigh/max set.
export function reasoningValues(executorType, model) {
  const cat = modelCatalog(executorType);
  if (cat && model) {
    const hit = cat.find((m) => m.slug === model);
    if (hit && Array.isArray(hit.efforts) && hit.efforts.length) return hit.efforts.filter(Boolean);
  }
  const node = getExecutorProfile(executorType)?.capabilities?.controls?.intelligence;
  const vals = Array.isArray(node?.values) ? node.values.filter(Boolean) : [];
  return vals.length ? vals : ['low', 'medium', 'high', 'xhigh'];
}
// A model's default reasoning effort from the catalog (codex), when present.
function defaultEffortFor(executorType, model) {
  const cat = modelCatalog(executorType);
  const hit = cat && model ? cat.find((m) => m.slug === model) : null;
  return hit?.defaultEffort || '';
}
// Speed ("/fast") is only offered for CLIs that actually expose a fast mode
// (codex fast_mode feature, claude fastMode setting) — read from capabilities.
export function speedSupported(executorType) {
  const node = getExecutorProfile(executorType)?.capabilities?.controls?.speed;
  return Boolean(node?.supported) && Array.isArray(node?.values) && node.values.includes('fast');
}
function modelValues(executorType) {
  const node = getExecutorProfile(executorType)?.capabilities?.controls?.model;
  return Array.isArray(node?.values) ? node.values.filter(Boolean) : [];
}
// Rich catalog (slug + display name) when the CLI provides one (e.g. codex).
function modelCatalog(executorType) {
  const c = getExecutorProfile(executorType)?.capabilities?.controls?.model?.catalog;
  return Array.isArray(c) && c.length ? c : null;
}
export function modelItems(executorType) {
  const cat = modelCatalog(executorType);
  if (cat) return cat.map((m) => ({ v: m.slug, label: m.name || m.slug }));
  return modelValues(executorType).map((v) => ({ v, label: shortModel(v) }));
}

// Two-tone label: the model slug in bright text, the reasoning level muted. They
// read as separate by default and only "connect" into one pill on hover/active
// (Codex-style) via the .cfg-trigger background.
export function configLabel({ model, intelligence }) {
  const m = model ? `<span class="cfg-lab-model">${safeText(shortModel(model))}</span>` : '';
  const r = `<span class="cfg-lab-reason">${safeText(reasonLabel(intelligence || 'high'))}</span>`;
  return `${m}${r}`;
}

// Refresh the visible "{model} {reasoning}" label from the form's current hidden
// values (called after the agent changes and resets the default model).
export function refreshConfigLabel(scope) {
  const cfg = scope && scope.querySelector ? scope.querySelector('.cfg') : null;
  if (cfg) setLabel(cfg);
}

export function renderComposerConfig(executorType, state = {}) {
  return `
    <div class="cfg">
      <button type="button" class="cfg-trigger" aria-haspopup="menu" aria-expanded="false" title="Model, reasoning &amp; speed">
        <span class="cfg-label">${configLabel(state)}</span>
        <svg class="cfg-caret" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>
      </button>
      <div class="cfg-pop" role="menu" hidden></div>
      <div class="cfg-flyout" role="menu" hidden></div>
    </div>`;
}

// ---- runtime ----
let _open = null;
let _hideTimer = null;
function cancelHide() { if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; } }
// Grace period before a submenu closes so a slow diagonal move from the row,
// across the small gap, into the flyout doesn't snap it shut.
function scheduleHide(cfg) {
  cancelHide();
  _hideTimer = setTimeout(() => { _hideTimer = null; if (_open === cfg) hideFlyout(cfg); }, 280);
}

function form(cfg) { return cfg.closest('form'); }
function field(cfg, name) { return form(cfg)?.querySelector(`input[name="${name}"]`); }
function executorOf(cfg) { return normalizeExecutorType(form(cfg)?.querySelector('select[name="executorType"]')?.value || ''); }
function val(cfg, name) { return field(cfg, name)?.value || ''; }

function setLabel(cfg) {
  cfg.querySelector('.cfg-label').innerHTML = configLabel({ model: val(cfg, 'model'), intelligence: val(cfg, 'intelligenceProfile') });
}

// When the model changes, keep the reasoning level valid for the new model
// (e.g. switching off a model that supported "max"). Falls back to the model's
// default effort, else the highest available level.
function clampReasoning(cfg, model) {
  const f = field(cfg, 'intelligenceProfile');
  if (!f) return;
  const allowed = reasoningValues(executorOf(cfg), model);
  if (allowed.includes(f.value)) return;
  f.value = defaultEffortFor(executorOf(cfg), model) || (allowed.includes('high') ? 'high' : allowed[allowed.length - 1]) || 'high';
}

function mainView(cfg) {
  const ex = executorOf(cfg);
  const reason = val(cfg, 'intelligenceProfile') || 'high';
  const model = val(cfg, 'model');
  const reasonRows = reasoningValues(ex, model).map((v) =>
    `<button type="button" class="cfg-item cfg-reason${v === reason ? ' selected' : ''}" data-v="${safeAttr(v)}">${safeText(reasonLabel(v))}${v === reason ? '<span class="cfg-check">✓</span>' : ''}</button>`,
  ).join('');
  return `
    <div class="cfg-head">Reasoning</div>
    ${reasonRows}
    <div class="cfg-sep"></div>
    <button type="button" class="cfg-item cfg-row" data-sub="model"><span>${safeText(model ? shortModel(model) : 'Model')}</span><span class="cfg-arrow">›</span></button>
    ${speedSupported(ex) ? '<button type="button" class="cfg-item cfg-row" data-sub="speed"><span>Speed</span><span class="cfg-arrow">›</span></button>' : ''}`;
}

// Submenu bodies are rendered into the side flyout (no back button — the main
// menu stays visible beside it, Codex-style).
function modelBody(cfg) {
  const cur = val(cfg, 'model');
  const items = modelItems(executorOf(cfg));
  const rows = items.length
    ? items.map((it) => `<button type="button" class="cfg-item cfg-model${it.v === cur ? ' selected' : ''}" data-v="${safeAttr(it.v)}">${safeText(it.label)}${it.v === cur ? '<span class="cfg-check">✓</span>' : ''}</button>`).join('')
    : '<div class="cfg-note">No preset models reported — type one below.</div>';
  return `
    <div class="cfg-head">Model</div>
    ${rows}
    <div class="cfg-free">
      <input type="text" class="cfg-model-input" placeholder="model slug (e.g. gpt-5.5)" value="${safeAttr(cur)}" aria-label="Custom model" />
      <button type="button" class="cfg-model-use">Use</button>
    </div>`;
}
function speedBody(cfg) {
  const cur = val(cfg, 'speed') || 'standard';
  return `<div class="cfg-head">Speed</div>` + SPEED_OPTIONS.map((o) =>
    `<button type="button" class="cfg-item cfg-speed${o.v === cur ? ' selected' : ''}" data-v="${o.v}"><span class="cfg-speed-main">${safeText(o.label)}${o.v === cur ? '<span class="cfg-check">✓</span>' : ''}</span><span class="cfg-speed-sub">${safeText(o.sub)}</span></button>`,
  ).join('');
}

function renderMain(cfg) {
  const pop = cfg.querySelector('.cfg-pop');
  pop.innerHTML = mainView(cfg);
}

function hideFlyout(cfg) {
  cancelHide();
  const fly = cfg.querySelector('.cfg-flyout');
  if (fly) { fly.hidden = true; fly.dataset.sub = ''; }
  cfg.querySelectorAll('.cfg-row.active').forEach((r) => r.classList.remove('active'));
}

// Show a submenu to the LEFT of the main popover, aligned to the hovered row.
function showFlyout(cfg, row) {
  const sub = row.dataset.sub;
  const fly = cfg.querySelector('.cfg-flyout');
  if (!fly) return;
  if (fly.dataset.sub !== sub) {
    fly.innerHTML = sub === 'model' ? modelBody(cfg) : speedBody(cfg);
    fly.dataset.sub = sub;
  }
  fly.hidden = false;
  cancelHide();
  cfg.querySelectorAll('.cfg-row').forEach((r) => r.classList.toggle('active', r === row));
  const cfgRect = cfg.getBoundingClientRect();
  const popRect = cfg.querySelector('.cfg-pop').getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  // Overlap the popover by 1px so there's no dead gap between the menu and the
  // flyout for the cursor to fall through; bottom aligned to the row.
  fly.style.right = `${Math.round(cfgRect.right - popRect.left - 1)}px`;
  fly.style.bottom = `${Math.round(cfgRect.bottom - rowRect.bottom)}px`;
}

function close() {
  cancelHide();
  if (!_open) return;
  _open.querySelector('.cfg-pop').hidden = true;
  hideFlyout(_open);
  _open.classList.remove('cfg-active');
  _open.querySelector('.cfg-trigger').setAttribute('aria-expanded', 'false');
  _open = null;
}
function open(cfg) {
  close();
  renderMain(cfg);
  cfg.querySelector('.cfg-pop').hidden = false;
  cfg.classList.add('cfg-active');
  cfg.querySelector('.cfg-trigger').setAttribute('aria-expanded', 'true');
  _open = cfg;
}

export function initComposerConfig() {
  // Submenus open on HOVER and appear beside the menu (flyout), not replacing it.
  // Closing is debounced (hover-intent) so a slow move from the row into the
  // flyout never makes it vanish — only a deliberate move onto another main item,
  // or leaving the menu for the grace period, dismisses it.
  document.addEventListener('mouseover', (event) => {
    if (!_open) return;
    const inFlyout = event.target.closest?.('.cfg-flyout');
    if (inFlyout && inFlyout.closest('.cfg') === _open) { cancelHide(); return; } // stay open in flyout
    const row = event.target.closest?.('.cfg-row');
    if (row && row.closest('.cfg') === _open) { showFlyout(_open, row); return; }
    // Hovering another main-menu item (e.g. a reasoning row): close after a grace
    // period so crossing the gap to the flyout (briefly over neither) is allowed.
    if (event.target.closest?.('.cfg-pop')) scheduleHide(_open);
  });
  // Leaving the whole control entirely also closes the submenu after the grace.
  document.addEventListener('mouseout', (event) => {
    if (!_open) return;
    const to = event.relatedTarget;
    if (to && to.closest?.('.cfg') === _open) return; // still inside this control
    scheduleHide(_open);
  });
  document.addEventListener('click', (event) => {
    const t = event.target;
    const cfg = t.closest?.('.cfg');
    if (!cfg) { close(); return; }

    if (t.closest('.cfg-trigger')) {
      event.preventDefault();
      if (_open === cfg) close(); else open(cfg);
      return;
    }
    const reason = t.closest('.cfg-reason');
    if (reason) {
      event.preventDefault();
      const f = field(cfg, 'intelligenceProfile'); if (f) f.value = reason.dataset.v;
      setLabel(cfg); renderMain(cfg); hideFlyout(cfg);
      return;
    }
    const model = t.closest('.cfg-model');
    if (model) {
      event.preventDefault();
      const f = field(cfg, 'model'); if (f) f.value = model.dataset.v;
      clampReasoning(cfg, model.dataset.v);
      setLabel(cfg); close();
      return;
    }
    if (t.closest('.cfg-model-use')) {
      event.preventDefault();
      const input = cfg.querySelector('.cfg-model-input');
      const value = (input?.value || '').trim();
      const f = field(cfg, 'model'); if (f) f.value = value;
      clampReasoning(cfg, value);
      setLabel(cfg); close();
      return;
    }
    const speed = t.closest('.cfg-speed');
    if (speed) {
      event.preventDefault();
      const f = field(cfg, 'speed'); if (f) f.value = speed.dataset.v;
      close();
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
      setLabel(cfg); close();
    }
  });
  document.addEventListener('scroll', (event) => {
    if (event.target?.closest?.('.cfg-pop') || event.target?.closest?.('.cfg-flyout')) return;
    close();
  }, true);
}
