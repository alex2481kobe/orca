// Custom dropdown: a consistent, styled replacement for the OS <select> menu.
//
// Progressive enhancement — every native <select> stays in the DOM as the single
// source of truth (form value, `change` events, toObj() serialization, and the
// executorType→model repopulation all keep working). We just hide it and overlay a
// styled trigger + menu. Selecting an option writes the native value and dispatches
// a real `change` event so existing listeners fire unchanged.

import { safeText, safeAttr } from './format.js';
import { icon } from './icons.js';

let _open = null; // the currently-open .dd wrapper

const CHEVRON = icon('chevron-down', { cls: 'dd-chevron', size: 16 });

function selectedLabel(select) {
  const opt = select.options[select.selectedIndex];
  return opt ? opt.textContent : '';
}

function optionsSignature(select) {
  return Array.from(select.options).map((o) => `${o.value}${o.textContent}${o.disabled ? 1 : 0}`).join('') + `${select.value}`;
}

function buildMenu(select) {
  const withModel = select.hasAttribute('data-dd-model');
  return Array.from(select.options).map((o) => {
    const opt = `<button type="button" class="dd-opt${o.selected ? ' selected' : ''}" role="option" data-v="${safeAttr(o.value)}"${o.disabled ? ' disabled' : ''}>${safeText(o.textContent)}</button>`;
    // Agent dropdown: each installed option gets a "⋯" to pick that CLI's model.
    if (withModel && !o.disabled && o.dataset && o.dataset.models !== undefined) {
      return `<div class="dd-optrow">${opt}<button type="button" class="dd-opt-more" data-cli="${safeAttr(o.value)}" data-models="${safeAttr(o.dataset.models || '')}" aria-label="Choose model for ${safeAttr(o.value)}" title="Choose model">⋯</button></div>`;
    }
    return opt;
  }).join('');
}

// Sub-panel: pick a model for one CLI. Lists the models the CLI reports (dynamic)
// plus a free-text field for any slug. Nothing is hardcoded.
function renderModelPanel(cli, models) {
  const list = (models || []).filter(Boolean);
  const rows = list.length
    ? list.map((m) => `<button type="button" class="dd-opt" data-model="${safeAttr(m)}" data-cli="${safeAttr(cli)}">${safeText(m)}</button>`).join('')
    : '<div class="dd-note">No preset models reported — type one below.</div>';
  return `
    <button type="button" class="dd-back" data-cli="${safeAttr(cli)}">‹ ${safeText(cli)} model</button>
    <div class="dd-model-list">${rows}</div>
    <div class="dd-model-free">
      <input type="text" class="dd-model-input" placeholder="model slug (e.g. gpt-5.5)" aria-label="Custom model for ${safeAttr(cli)}" />
      <button type="button" class="dd-model-use" data-cli="${safeAttr(cli)}">Use</button>
    </div>`;
}

function applyAgentModel(wrap, cli, model) {
  const select = wrap.__select;
  if (cli && select.value !== cli) select.value = cli;
  const modelField = wrap.closest('form')?.querySelector('input[name="model"]');
  if (modelField) modelField.value = model || '';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  wrap.__sig = null;
  wrap.__trigger.querySelector('.dd-value').textContent = model ? `${cli} · ${model}` : cli;
}

export function enhanceSelect(select) {
  if (!select || select.dataset.ddSkip || select.multiple) return;
  let wrap = select.__ddWrap;
  if (!wrap || !wrap.isConnected || select.parentNode !== wrap) {
    wrap = document.createElement('div');
    wrap.className = 'dd';
    if (select.classList.contains('composer-select')) wrap.classList.add('dd-compact');
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dd-trigger';
    const label = select.getAttribute('aria-label');
    if (label) trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `<span class="dd-value"></span>${CHEVRON}`;
    const menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    select.__ddWrap = wrap;
    wrap.__select = select;
    wrap.__trigger = trigger;
    wrap.__menu = menu;
    wrap.__sig = null;
  }
  // Never rebuild the menu of a dropdown the user currently has open.
  if (_open === wrap) return;
  const sig = optionsSignature(select);
  if (sig !== wrap.__sig) {
    wrap.__sig = sig;
    wrap.__menu.innerHTML = buildMenu(select);
    wrap.__trigger.querySelector('.dd-value').textContent = selectedLabel(select);
  }
  wrap.classList.toggle('dd-disabled', select.disabled);
}

export function enhanceSelects(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('select:not([data-dd-skip])').forEach(enhanceSelect);
}

function closeOpen() {
  if (!_open) return;
  _open.__menu.hidden = true;
  _open.classList.remove('dd-open');
  _open.__trigger.setAttribute('aria-expanded', 'false');
  _open = null;
}

function openMenu(wrap) {
  closeOpen();
  // Open upward if there isn't room below (composer sits near the viewport bottom).
  const rect = wrap.__trigger.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom;
  wrap.classList.toggle('dd-up', below < 240 && rect.top > below);
  wrap.__menu.hidden = false;
  wrap.classList.add('dd-open');
  wrap.__trigger.setAttribute('aria-expanded', 'true');
  // Highlight the selected option. (No scrollIntoView — it would fire the
  // scroll-to-close listener and immediately reclose, which made the menu
  // impossible to toggle shut.)
  wrap.__menu.querySelectorAll('.dd-opt').forEach((o) => o.classList.remove('active'));
  const sel = wrap.__menu.querySelector(`.dd-opt[data-v="${CSS.escape(wrap.__select.value)}"]`);
  if (sel) sel.classList.add('active');
  _open = wrap;
}

export function initDropdowns() {
  document.addEventListener('click', (event) => {
    // Per-agent model picker: "⋯" opens the model sub-panel for that CLI.
    const more = event.target.closest?.('.dd-opt-more');
    if (more && more.closest('.dd')) {
      event.preventDefault();
      const wrap = more.closest('.dd');
      const models = (more.dataset.models || '').split(',').map((s) => s.trim()).filter(Boolean);
      wrap.__menu.innerHTML = renderModelPanel(more.dataset.cli, models);
      wrap.__menu.querySelector('.dd-model-input')?.focus();
      return;
    }
    if (event.target.closest?.('.dd-back')) {
      event.preventDefault();
      const wrap = event.target.closest('.dd');
      wrap.__sig = null; enhanceSelect(wrap.__select); // rebuild the agent menu
      wrap.__menu.innerHTML = buildMenu(wrap.__select);
      return;
    }
    const modelPick = event.target.closest?.('.dd-opt[data-model]');
    if (modelPick && modelPick.closest('.dd')) {
      event.preventDefault();
      const wrap = modelPick.closest('.dd');
      applyAgentModel(wrap, modelPick.dataset.cli, modelPick.dataset.model);
      closeOpen();
      return;
    }
    const useBtn = event.target.closest?.('.dd-model-use');
    if (useBtn && useBtn.closest('.dd')) {
      event.preventDefault();
      const wrap = useBtn.closest('.dd');
      const val = wrap.__menu.querySelector('.dd-model-input')?.value.trim() || '';
      applyAgentModel(wrap, useBtn.dataset.cli, val);
      closeOpen();
      return;
    }
    const opt = event.target.closest?.('.dd-opt');
    if (opt && opt.closest('.dd')) {
      event.preventDefault();
      const wrap = opt.closest('.dd');
      if (!opt.disabled) {
        const select = wrap.__select;
        if (select.value !== opt.dataset.v) {
          select.value = opt.dataset.v;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        wrap.__sig = null; // force label/menu refresh on next enhance
        wrap.__trigger.querySelector('.dd-value').textContent = opt.textContent;
      }
      closeOpen();
      return;
    }
    const trigger = event.target.closest?.('.dd-trigger');
    if (trigger && trigger.closest('.dd')) {
      event.preventDefault();
      const wrap = trigger.closest('.dd');
      if (wrap.classList.contains('dd-disabled')) return;
      if (_open === wrap) closeOpen();
      else openMenu(wrap);
      return;
    }
    if (!event.target.closest?.('.dd-menu')) closeOpen();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeOpen(); return; }
    // Enter in the free-text model field applies the model (and must NOT bubble up
    // to submit the chat composer).
    if (event.key === 'Enter' && event.target.classList?.contains('dd-model-input')) {
      event.preventDefault();
      event.stopPropagation();
      const wrap = event.target.closest('.dd');
      const cli = wrap.__menu.querySelector('.dd-model-use')?.dataset.cli;
      applyAgentModel(wrap, cli, event.target.value.trim());
      closeOpen();
    }
  });
  // Close on scroll of the page/containers (the menu is absolutely positioned),
  // but NOT when the scroll happens inside the menu's own option list.
  document.addEventListener('scroll', (event) => {
    if (!_open) return; // nothing open → don't even run closest() on every scroll
    if (event.target && event.target.closest && event.target.closest('.dd-menu')) return;
    closeOpen();
  }, true);
}
