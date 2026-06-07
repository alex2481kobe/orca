// Codex-style composer context row: when the working folder is a git repo, a
// branch picker (select an existing branch, filter, or create a new one) plus a
// view of existing worktrees. The chosen branch lives on the form's hidden
// `branch` input so submission/toObj keep working. Git info is fetched once per
// session and cached on shell.gitInfo[sessionId].
//
// (There is no Local/Cloud selector: neither the codex nor claude CLI exposes a
// non-interactive "run in the cloud" mode, so surfacing one would be misleading.)

import { shell } from './state.js';
import { api } from './api.js';
import { writeHtml } from './dom.js';
import { safeText, safeAttr } from './format.js';
import { icon } from './icons.js';

const ICON_BRANCH = icon('branch', { size: 15 });
const ICON_CARET = icon('chevron-down', { cls: 'ctx-caret', size: 12 });

function gitInfoFor(sessionId) { return shell.gitInfo?.[sessionId] || null; }

// The visible branch pill, rendered from cached git info + the form's current
// hidden branch value. Returns '' for non-git folders (row hides itself).
export function composerContextInner(session) {
  const git = gitInfoFor(session.id);
  if (!git || !git.isGit) return '';
  const form = document.getElementById('orchestrator-message-form');
  const branch = form?.querySelector('input[name="branch"]')?.value || '';
  const label = branch || git.currentBranch || 'branch';
  return `
    <button type="button" class="ctx-pill" data-ctx-menu="branch" aria-haspopup="menu" aria-expanded="false">
      ${ICON_BRANCH}<span class="ctx-pill-label">${safeText(label)}</span>${ICON_CARET}
    </button>
    <div class="ctx-pop" role="menu" hidden></div>`;
}

// Fetch (once) + render the context row into its stable mount. Safe to call on
// every render — the fetch is cached and writeHtml skips identical HTML.
export function hydrateComposerContext(session) {
  const sid = session.id;
  const mount = document.getElementById(`composer-context-${sid}`);
  if (!mount) return;
  shell.gitInfo = shell.gitInfo || {};
  // A draft chat has no server-side session yet, so don't fetch its git info
  // (it would 404). Git context appears once the chat is real (first message).
  if (String(sid).startsWith('draft-')) return;
  if (!(sid in shell.gitInfo)) {
    shell.gitInfo[sid] = null; // mark in-flight so we fetch only once
    api(`/api/sessions/${sid}/git`).then((res) => {
      shell.gitInfo[sid] = (res.ok && res.data) ? res.data : { isGit: false };
      const m = document.getElementById(`composer-context-${sid}`);
      if (m) writeHtml(m, composerContextInner(session));
    }).catch(() => { shell.gitInfo[sid] = { isGit: false }; });
  }
  writeHtml(mount, composerContextInner(session));
}

// ---- menu runtime ----
let _open = null; // the .ctx-pill currently open

function closeMenu() {
  if (!_open) return;
  const pop = _open.parentElement.querySelector('.ctx-pop');
  if (pop) pop.hidden = true;
  _open.setAttribute('aria-expanded', 'false');
  _open = null;
}

function formOf(el) { return el.closest('form'); }
function fieldOf(el, name) { return formOf(el)?.querySelector(`input[name="${name}"]`); }
function sessionIdOf(el) { return formOf(el)?.getAttribute('data-session-id') || ''; }
function shortPath(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(p || '');
}

function branchMenuBody(pill) {
  const sid = sessionIdOf(pill);
  const git = gitInfoFor(sid) || {};
  const cur = fieldOf(pill, 'branch')?.value || '';
  const branches = Array.isArray(git.branches) ? git.branches : [];
  const rows = branches.map((b) =>
    `<button type="button" class="ctx-item ctx-branch${b === (cur || git.currentBranch) ? ' selected' : ''}" data-v="${safeAttr(b)}"><span>${safeText(b)}</span>${b === git.currentBranch ? '<span class="ctx-tag">current</span>' : ''}${b === cur ? '<span class="ctx-check">✓</span>' : ''}</button>`,
  ).join('') || '<div class="ctx-note">No branches found.</div>';
  const worktrees = Array.isArray(git.worktrees) ? git.worktrees : [];
  const wtSection = worktrees.length > 1
    ? `<div class="ctx-sep"></div><div class="ctx-head">Worktrees</div>${worktrees.map((w) =>
      `<div class="ctx-wt"><span class="ctx-wt-branch">${safeText(w.branch || w.head || '(detached)')}</span><span class="ctx-wt-path">${safeText(shortPath(w.path))}</span></div>`).join('')}`
    : '';
  return `
    <div class="ctx-head">Branch</div>
    <div class="ctx-search"><input type="text" class="ctx-filter" placeholder="Filter or create a branch" aria-label="Filter or create a branch" /></div>
    <button type="button" class="ctx-item ctx-create" data-v="" hidden><span class="ctx-create-plus">+</span><span class="ctx-create-label"></span></button>
    <div class="ctx-scroll">${rows}</div>
    ${wtSection}`;
}

function openMenu(pill) {
  closeMenu();
  const pop = pill.parentElement.querySelector('.ctx-pop');
  if (!pop) return;
  pop.innerHTML = branchMenuBody(pill);
  pop.hidden = false;
  pill.setAttribute('aria-expanded', 'true');
  _open = pill;
  const filter = pop.querySelector('.ctx-filter');
  if (filter) setTimeout(() => filter.focus(), 0);
}

function chooseBranch(pill, value) {
  const f = fieldOf(pill, 'branch'); if (f) f.value = value || '';
  const label = pill.querySelector('.ctx-pill-label');
  const git = gitInfoFor(sessionIdOf(pill)) || {};
  if (label) label.textContent = value || git.currentBranch || 'branch';
  closeMenu();
}

export function initComposerContext() {
  document.addEventListener('click', (event) => {
    const t = event.target;
    const pill = t.closest?.('.ctx-pill');
    if (pill) {
      event.preventDefault();
      if (_open === pill) closeMenu(); else openMenu(pill);
      return;
    }
    if (!t.closest?.('.ctx-pop')) { closeMenu(); return; }
    if (!_open) return;

    const createRow = t.closest('.ctx-create');
    if (createRow && createRow.dataset.v) { event.preventDefault(); chooseBranch(_open, createRow.dataset.v); return; }
    const branchRow = t.closest('.ctx-branch');
    if (branchRow) { event.preventDefault(); chooseBranch(_open, branchRow.dataset.v || ''); return; }
  });

  // Live-filter the branch list, and offer "Create '<name>'" for a novel name.
  document.addEventListener('input', (event) => {
    if (!event.target.classList?.contains('ctx-filter')) return;
    const pop = event.target.closest('.ctx-pop');
    if (!pop) return;
    const q = event.target.value.trim();
    const lower = q.toLowerCase();
    const rows = [...pop.querySelectorAll('.ctx-branch')];
    let exact = false;
    rows.forEach((row) => {
      const v = (row.dataset.v || '').toLowerCase();
      row.style.display = v.includes(lower) ? '' : 'none';
      if (v === lower) exact = true;
    });
    const create = pop.querySelector('.ctx-create');
    if (create) {
      if (q && !exact) {
        create.dataset.v = q;
        create.querySelector('.ctx-create-label').textContent = `Create “${q}”`;
        create.hidden = false;
      } else {
        create.dataset.v = '';
        create.hidden = true;
      }
    }
  });

  // Enter in the filter creates/selects the typed branch.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeMenu(); return; }
    if (event.key === 'Enter' && event.target.classList?.contains('ctx-filter') && _open) {
      event.preventDefault();
      const q = event.target.value.trim();
      if (q) chooseBranch(_open, q);
    }
  });
}
