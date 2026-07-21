// v2 read-only dashboard: left panel (registered projects + active-agent state),
// settings (theme), and the main projects → orchestrators → executors tree.
// External module (CSP is script-src 'self'). Vanilla, no imports.
const sideEl = document.getElementById('side-projects');
const root = document.getElementById('ov-root');
const revEl = document.getElementById('ov-rev');
const titleEl = document.getElementById('main-title');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tagClass = (tag) => {
  const t = String(tag || '').toLowerCase();
  if (t.includes('working') || t === 'auditing') return 'working';
  if (t.includes('waiting') || t.includes('approval') || t.includes('awaiting')) return 'waiting';
  if (t.includes('fail') || t.includes('block')) return 'failed';
  return '';
};

// ---- selection + ephemeral state (survive the 2s innerHTML re-render) ----
let selectedProjectId = null; // null = All
const armed = new Set();       // break-glass laneIds
let lastData = { projects: [] };

function openSet() {
  return new Set([...document.querySelectorAll('.ov-project[open]')].map((d) => d.dataset.pid));
}
function activeAgents(project) {
  return project.orchestrators.filter((o) => !o.stale).length;
}
function stopControl(laneId) {
  return armed.has(laneId)
    ? `<button class="ov-stop armed" data-lane="${esc(laneId)}" title="Click again to stop">⚠ stop?</button>`
    : `<button class="ov-stop" data-lane="${esc(laneId)}" title="Break-glass: stop this executor">⏹</button>`;
}

// ---- left panel ----
function renderSide(data) {
  const items = data.projects.map((p) => {
    const active = activeAgents(p);
    const sel = p.id === selectedProjectId ? ' selected' : '';
    return `
      <button class="side-project${sel}" data-pid="${esc(p.id)}">
        <span class="side-dot${active ? ' live' : ''}"></span>
        <span class="side-pname">${esc(p.name)}</span>
        ${active ? `<span class="side-count">${active}</span>` : ''}
      </button>`;
  }).join('');
  sideEl.innerHTML = `
    <button class="side-project side-all${selectedProjectId ? '' : ' selected'}" data-pid="">
      <span class="side-all-icon">▦</span><span class="side-pname">All projects</span>
    </button>
    ${items || '<div class="side-empty">No projects registered yet.</div>'}`;
}

// ---- main tree ----
function executorRow(e) {
  return `
    <div class="ov-exec${e.terminal ? ' terminal' : ''}">
      <span class="ov-dot"></span>
      <span class="ov-etitle">${esc(e.title) || '<span class="ov-etype">untitled</span>'}</span>
      <span class="ov-etype">${esc(e.executorType || '')}</span>
      ${e.statusText ? `<span class="ov-etext">${esc(e.statusText)}</span>` : ''}
      <span class="ov-tag ${tagClass(e.statusTag)}">${esc(e.statusTag)}</span>
      ${e.terminal ? '' : stopControl(e.id)}
    </div>`;
}
function projectCard(p, wasOpen) {
  const open = (wasOpen.has(p.id) || wasOpen.size === 0 || selectedProjectId) ? ' open' : '';
  const orchs = p.orchestrators.map((o) => `
    <div class="ov-orch${o.stale ? ' stale' : ''}">
      <div class="ov-orow">
        <span class="ov-otitle">${esc(o.title) || 'Untitled orchestrator'}</span>
        <span class="ov-oactor">${esc(o.actor)}</span>
      </div>
      ${o.focus ? `<div class="ov-ofocus">${esc(o.focus)}</div>` : ''}
      <div class="ov-execs">${o.executors.map(executorRow).join('') || '<span class="ov-etext" style="margin-left:var(--space-3)">no executors</span>'}</div>
    </div>`).join('');
  return `
    <details class="ov-project" data-pid="${esc(p.id)}"${open}>
      <summary>
        <span class="ov-pname">${esc(p.name)}</span>
        <span class="ov-ppath">${esc(p.parentName ? p.parentName + ' / ' : '')}${esc(p.cwd)}</span>
      </summary>
      ${orchs}
    </details>`;
}

function render(data, wasOpen) {
  lastData = data;
  renderSide(data);
  const shown = selectedProjectId ? data.projects.filter((p) => p.id === selectedProjectId) : data.projects;
  titleEl.textContent = selectedProjectId ? (data.projects.find((p) => p.id === selectedProjectId)?.name || 'Orca') : 'Orca';
  revEl.textContent = data.projects.length ? `${data.projects.length} project${data.projects.length > 1 ? 's' : ''}` : '';
  if (!shown.length) {
    root.innerHTML = '<div class="ov-empty">No agents registered. Register an orchestrator from your CLI to see it here.</div>';
    return;
  }
  root.innerHTML = shown.map((p) => projectCard(p, wasOpen)).join('');
}

async function poll() {
  try {
    const res = await fetch('/api/overview', { headers: { accept: 'application/json' } });
    if (!res.ok) { root.innerHTML = `<div class="ov-empty">Overview unavailable (${res.status}).</div>`; return; }
    render(await res.json(), openSet());
  } catch (err) {
    root.innerHTML = '<div class="ov-empty">Could not reach Orca.</div>';
  }
}

// ---- interactions (delegated: survive re-render) ----
sideEl.addEventListener('click', (event) => {
  const btn = event.target.closest('.side-project');
  if (!btn) return;
  selectedProjectId = btn.dataset.pid || null;
  render(lastData, openSet());
});

root.addEventListener('click', async (event) => {
  const btn = event.target.closest('.ov-stop');
  if (!btn) return;
  event.preventDefault();
  const laneId = btn.dataset.lane;
  if (!laneId) return;
  if (!armed.has(laneId)) {
    armed.add(laneId);
    render(lastData, openSet());
    setTimeout(() => { if (armed.delete(laneId)) render(lastData, openSet()); }, 30000);
    return;
  }
  armed.delete(laneId);
  btn.disabled = true;
  try {
    await fetch('/api/emergency-stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ laneId }) });
  } catch (err) { /* poll reflects reality */ }
  poll();
});

// ---- settings (theme) ----
const modal = document.getElementById('settings-modal');
function currentThemePref() {
  try { return localStorage.getItem('orca.theme') || 'system'; } catch { return 'system'; }
}
function applyTheme(pref) {
  try {
    if (pref === 'system') localStorage.removeItem('orca.theme');
    else localStorage.setItem('orca.theme', pref);
  } catch { /* ignore */ }
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelectorAll('.theme-opt').forEach((b) => b.classList.toggle('selected', b.dataset.theme === pref));
}
document.getElementById('open-settings').addEventListener('click', () => {
  applyTheme(currentThemePref()); // sync the selected pill
  modal.hidden = false;
});
modal.addEventListener('click', (event) => {
  if (event.target === modal || event.target.closest('[data-close]')) { modal.hidden = true; return; }
  const opt = event.target.closest('.theme-opt');
  if (opt) applyTheme(opt.dataset.theme);
});

poll();
setInterval(poll, 2000);
