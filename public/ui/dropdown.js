// Custom dropdown: a consistent, styled replacement for the OS <select> menu.
//
// Progressive enhancement — every native <select> stays in the DOM as the single
// source of truth (form value, `change` events, toObj() serialization, and the
// executorType→model repopulation all keep working). We just hide it and overlay a
// styled trigger + menu. Selecting an option writes the native value and dispatches
// a real `change` event so existing listeners fire unchanged.

import { safeText, safeAttr } from './format.js';

let _open = null; // the currently-open .dd wrapper

const CHEVRON = '<svg class="dd-chevron" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>';

function selectedLabel(select) {
  const opt = select.options[select.selectedIndex];
  return opt ? opt.textContent : '';
}

function optionsSignature(select) {
  return Array.from(select.options).map((o) => `${o.value}${o.textContent}${o.disabled ? 1 : 0}`).join('') + `${select.value}`;
}

function buildMenu(select) {
  return Array.from(select.options).map((o) =>
    `<button type="button" class="dd-opt${o.selected ? ' selected' : ''}" role="option" data-v="${safeAttr(o.value)}"${o.disabled ? ' disabled' : ''}>${safeText(o.textContent)}</button>`,
  ).join('');
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
    if (event.key === 'Escape') closeOpen();
  });
  // Close on scroll of the page/containers (the menu is absolutely positioned),
  // but NOT when the scroll happens inside the menu's own option list.
  document.addEventListener('scroll', (event) => {
    if (event.target && event.target.closest && event.target.closest('.dd-menu')) return;
    closeOpen();
  }, true);
}
