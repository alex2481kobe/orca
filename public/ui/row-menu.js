// Sidebar row context menu — a single floating popover (Codex-app-style) for
// project and session rows. Opened by the row's 3-dot trigger (click) or by a
// long-press on the row (touch). It is appended to <body>, NOT rendered inside the
// sidebar markup, so the dashboard poll re-rendering the sidebar can't close it
// (the "opens then auto-closes" bug class). Its item buttons carry data-action +
// data-* so the existing delegated click dispatcher runs the real handlers
// (renameSession, archiveSession, renameProject, archiveProject, newSession).

import { safeText, safeAttr } from './format.js';

let _menu = null;
let _anchor = null;
let _onDocPointer = null;
let _onKey = null;
let _onScroll = null;

export function closeRowMenu() {
  if (_menu) { _menu.remove(); _menu = null; }
  _anchor = null;
  if (_onDocPointer) { document.removeEventListener('pointerdown', _onDocPointer, true); _onDocPointer = null; }
  if (_onKey) { document.removeEventListener('keydown', _onKey, true); _onKey = null; }
  if (_onScroll) { window.removeEventListener('scroll', _onScroll, true); window.removeEventListener('resize', _onScroll); _onScroll = null; }
}

export function isRowMenuOpen() {
  return Boolean(_menu);
}

// True when the menu is currently open AND was opened by this exact trigger — lets
// the dispatcher toggle it closed on a second click of the same 3-dot button.
export function isRowMenuOpenFor(el) {
  return Boolean(_menu) && _anchor === el;
}

// Items for a trigger, derived from its data-* (data-menu = 'project' | 'session').
function itemsFor(dataset) {
  if (dataset.menu === 'project') {
    const data = `data-project-id="${safeAttr(dataset.projectId)}" data-project-name="${safeAttr(dataset.projectName || '')}"`;
    return [
      { label: 'New session', action: 'newSession', data: `data-project-id="${safeAttr(dataset.projectId)}"` },
      { label: 'Rename project', action: 'renameProject', data },
      { label: 'Archive project', action: 'archiveProject', data, danger: true },
    ];
  }
  const data = `data-session-id="${safeAttr(dataset.sessionId)}" data-session-name="${safeAttr(dataset.sessionName || '')}"`;
  return [
    { label: 'Rename', action: 'renameSession', data },
    { label: 'Archive chat', action: 'archiveSession', data, danger: true },
  ];
}

function placeMenu(menu, anchorRect) {
  // Right-align to the anchor (menus grow left), drop below; clamp to viewport.
  const margin = 6;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = anchorRect.right - mw;
  let top = anchorRect.bottom + 4;
  if (left < margin) left = margin;
  if (left + mw > window.innerWidth - margin) left = window.innerWidth - margin - mw;
  if (top + mh > window.innerHeight - margin) top = Math.max(margin, anchorRect.top - mh - 4);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

// Open the menu anchored to `anchorEl` (the 3-dot button), reading its dataset for
// the row identity. `rect` optionally overrides the anchor rectangle (used by
// long-press to anchor at the row instead of the hidden trigger).
export function openRowMenuFromTrigger(anchorEl, rect = null) {
  if (!anchorEl) return;
  closeRowMenu();
  const items = itemsFor(anchorEl.dataset);
  const menu = document.createElement('div');
  menu.className = 'row-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it) =>
    `<button class="row-menu-item${it.danger ? ' danger' : ''}" type="button" role="menuitem" data-action="${it.action}" ${it.data}>${safeText(it.label)}</button>`,
  ).join('');
  document.body.appendChild(menu);
  placeMenu(menu, rect || anchorEl.getBoundingClientRect());
  _menu = menu;
  _anchor = anchorEl;

  // Choosing an item: let the delegated handler run (it sees the item's data-*),
  // then close on the next tick.
  menu.addEventListener('click', (event) => {
    if (event.target.closest('.row-menu-item')) setTimeout(closeRowMenu, 0);
  });
  // Dismiss on outside pointerdown, Escape, or scroll/resize. Clicks ON the anchor
  // trigger are left for the dispatcher to TOGGLE (close), so we don't close here
  // only to immediately reopen.
  _onDocPointer = (event) => {
    const t = event.target;
    if (menu.contains(t)) return;
    if (_anchor && (t === _anchor || _anchor.contains(t))) return;
    closeRowMenu();
  };
  _onKey = (event) => { if (event.key === 'Escape') { closeRowMenu(); } };
  _onScroll = () => closeRowMenu();
  document.addEventListener('pointerdown', _onDocPointer, true);
  document.addEventListener('keydown', _onKey, true);
  window.addEventListener('scroll', _onScroll, true);
  window.addEventListener('resize', _onScroll);
  // Focus the first item for keyboard users.
  menu.querySelector('.row-menu-item')?.focus();
}
