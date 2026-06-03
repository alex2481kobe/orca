// Codex-style composer context row: the pills under the composer that show the
// execution location (Local / Cloud) and — when the working folder is a git repo
// — the working branch picker plus existing worktrees. Branch + mode live on the
// form's hidden inputs (branch, executionMode) so submission/toObj keep working.
// Git info is fetched once per session and cached on shell.gitInfo[sessionId].

import { shell } from './state.js';
import { api } from './api.js';
import { writeHtml } from './dom.js';
import { safeText, safeAttr } from './format.js';
import { getExecutorProfile, normalizeExecutorType } from './executor.js';

const ICON_LOCAL = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="10" rx="1.6"/><path d="M7 16.5h6M10 13.5v3"/></svg>';
const ICON_CLOUD = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15.5a3.5 3.5 0 0 1-.3-6.99A4.5 4.5 0 0 1 14.4 8.2 3.2 3.2 0 0 1 14 15.5H6z"/></svg>';
const ICON_BRANCH = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="15" r="2"/><circle cx="14" cy="7" r="2"/><path d="M6 7v6M14 9c0 3-3 3.5-6 3.5"/></svg>';
const ICON_CARET = '<svg class="ctx-caret" viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>';

function gitInfoFor(sessionId) { return shell.gitInfo?.[sessionId] || null; }

// The visible pills, rendered from cached git info + the form's current hidden
// values. Returns '' until git info has loaded (hydrate fills it in).
export function composerContextInner(session) {
  const sid = session.id;
  const git = gitInfoFor(sid);
  const form = document.getElementById('orchestrator-message-form');
  const mode = form?.querySelector('input[name="executionMode"]')?.value || 'local';
  const branch = form?.querySelector('input[name="branch"]')?.value || '';
  const modePill = `
    <button type="button" class="ctx-pill" data-ctx-menu="mode" aria-haspopup="menu" aria-expanded="false">
      ${mode === 'cloud' ? ICON_CLOUD : ICON_LOCAL}<span class="ctx-pill-label">${mode === 'cloud' ? 'Cloud' : 'Work locally'}</span>${ICON_CARET}
    </button>`;
  let branchPill = '';
  if (git && git.isGit) {
    const label = branch || git.currentBranch || 'branch';
    branchPill = `
      <button type="button" class="ctx-pill" data-ctx-menu="branch" aria-haspopup="menu" aria-expanded="false">
        ${ICON_BRANCH}<span class="ctx-pill-label">${safeText(label)}</span>${ICON_CARET}
      </button>`;
  }
  return `${modePill}${branchPill}<div class="ctx-pop" role="menu" hidden></div>`;
}

// Fetch (once) + render the context row into its stable mount. Safe to call on
// every render — the fetch is cached and writeHtml skips identical HTML.
export function hydrateComposerContext(session) {
  const sid = session.id;
  const mount = document.getElementById(`composer-context-${sid}`);
  if (!mount) return;
  shell.gitInfo = shell.gitInfo || {};
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
  const cfgPop = _open.parentElement.querySelector('.ctx-pop');
  if (cfgPop) cfgPop.hidden = true;
  _open.setAttribute('aria-expanded', 'false');
  _open = null;
}

function formOf(el) { return el.closest('form'); }
function fieldOf(el, name) { return formOf(el)?.querySelector(`input[name="${name}"]`); }
function sessionIdOf(el) { return formOf(el)?.getAttribute('data-session-id') || ''; }

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
    <div class="ctx-search"><input type="text" class="ctx-filter" placeholder="Filter branches" aria-label="Filter branches" /></div>
    <div class="ctx-scroll">${rows}</div>
    ${wtSection}`;
}

function modeMenuBody(pill) {
  const sid = sessionIdOf(pill);
  const cur = fieldOf(pill, 'executionMode')?.value || 'local';
  const ex = normalizeExecutorType(formOf(pill)?.querySelector('select[name="executorType"]')?.value || '');
  const cloud = getExecutorProfile(ex)?.capabilities?.controls?.cloud || {};
  const cloudNote = cloud.detected
    ? `${ex} cloud (${safeText(cloud.command || 'cloud')}) isn't a non-interactive run yet`
    : `${ex || 'this agent'} has no cloud run mode`;
  return `
    <div class="ctx-head">Run location</div>
    <button type="button" class="ctx-item ctx-mode${cur !== 'cloud' ? ' selected' : ''}" data-v="local">${ICON_LOCAL}<span class="ctx-mode-main"><span>Work locally</span><span class="ctx-mode-sub">Runs in this folder on your machine</span></span>${cur !== 'cloud' ? '<span class="ctx-check">✓</span>' : ''}</button>
    <button type="button" class="ctx-item ctx-mode is-disabled" data-v="cloud" disabled aria-disabled="true">${ICON_CLOUD}<span class="ctx-mode-main"><span>Cloud</span><span class="ctx-mode-sub">${safeText(cloudNote)}</span></span></button>`;
}

function shortPath(p) {
  const str = String(p || '');
  const parts = str.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : str;
}

function openMenu(pill) {
  closeMenu();
  const pop = pill.parentElement.querySelector('.ctx-pop');
  if (!pop) return;
  pop.innerHTML = pill.dataset.ctxMenu === 'branch' ? branchMenuBody(pill) : modeMenuBody(pill);
  pop.hidden = false;
  pill.setAttribute('aria-expanded', 'true');
  _open = pill;
  const filter = pop.querySelector('.ctx-filter');
  if (filter) setTimeout(() => filter.focus(), 0);
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

    const branchRow = t.closest('.ctx-branch');
    if (branchRow && _open) {
      event.preventDefault();
      const f = fieldOf(_open, 'branch'); if (f) f.value = branchRow.dataset.v || '';
      const label = _open.querySelector('.ctx-pill-label'); if (label) label.textContent = branchRow.dataset.v || '';
      closeMenu();
      return;
    }
    const modeRow = t.closest('.ctx-mode');
    if (modeRow && !modeRow.hasAttribute('disabled') && _open) {
      event.preventDefault();
      const f = fieldOf(_open, 'executionMode'); if (f) f.value = modeRow.dataset.v || 'local';
      const label = _open.querySelector('.ctx-pill-label'); if (label) label.textContent = modeRow.dataset.v === 'cloud' ? 'Cloud' : 'Work locally';
      closeMenu();
      return;
    }
  });
  // Live-filter the branch list.
  document.addEventListener('input', (event) => {
    if (!event.target.classList?.contains('ctx-filter')) return;
    const q = event.target.value.trim().toLowerCase();
    const scroll = event.target.closest('.ctx-pop')?.querySelector('.ctx-scroll');
    if (!scroll) return;
    scroll.querySelectorAll('.ctx-branch').forEach((row) => {
      const hit = (row.dataset.v || '').toLowerCase().includes(q);
      row.style.display = hit ? '' : 'none';
    });
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
}
