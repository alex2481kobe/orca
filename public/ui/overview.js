// v2 read-only overview: poll /api/overview and render the projects-by-cwd ->
// orchestrators -> executors tree. External module (CSP is script-src 'self').
const root = document.getElementById('ov-root');
const revEl = document.getElementById('ov-rev');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tagClass = (tag) => {
  const t = String(tag || '').toLowerCase();
  if (t.includes('working') || t === 'auditing') return 'working';
  if (t.includes('waiting') || t.includes('approval') || t.includes('awaiting')) return 'waiting';
  if (t.includes('fail') || t.includes('block')) return 'failed';
  return '';
};

// Break-glass: laneIds whose stop control is "armed" (first click). Survives the
// innerHTML re-render because it lives here, not in the DOM.
const armed = new Set();
let lastData = { projects: [] };

// Preserve which <details> are open across re-render (ephemeral-state invariant).
function openSet() {
  return new Set([...document.querySelectorAll('.ov-project[open]')].map((d) => d.dataset.pid));
}

function stopControl(laneId) {
  return armed.has(laneId)
    ? `<button class="ov-stop armed" data-lane="${esc(laneId)}" title="Click again to stop">⚠ stop?</button>`
    : `<button class="ov-stop" data-lane="${esc(laneId)}" title="Break-glass: stop this executor">⏹</button>`;
}

function render(data, wasOpen) {
  lastData = data;
  revEl.textContent = data.projects.length ? `${data.projects.length} project${data.projects.length > 1 ? 's' : ''}` : '';
  if (!data.projects.length) {
    root.innerHTML = '<div class="ov-empty">No agents registered. Register an orchestrator from your CLI to see it here.</div>';
    return;
  }
  root.innerHTML = data.projects.map((p) => {
    const open = (wasOpen.has(p.id) || wasOpen.size === 0) ? ' open' : '';
    const orchs = p.orchestrators.map((o) => {
      const execs = o.executors.map((e) => `
        <div class="ov-exec${e.terminal ? ' terminal' : ''}">
          <span class="ov-dot"></span>
          <span class="ov-etitle">${esc(e.title) || '<span class="ov-etype">untitled</span>'}</span>
          <span class="ov-etype">${esc(e.executorType || '')}</span>
          ${e.statusText ? `<span class="ov-etext">${esc(e.statusText)}</span>` : ''}
          <span class="ov-tag ${tagClass(e.statusTag)}">${esc(e.statusTag)}</span>
          ${e.terminal ? '' : stopControl(e.id)}
        </div>`).join('');
      return `
        <div class="ov-orch${o.stale ? ' stale' : ''}">
          <div class="ov-orow">
            <span class="ov-otitle">${esc(o.title) || 'Untitled orchestrator'}</span>
            <span class="ov-oactor">${esc(o.actor)}</span>
          </div>
          ${o.focus ? `<div class="ov-ofocus">${esc(o.focus)}</div>` : ''}
          <div class="ov-execs">${execs || '<span class="ov-etext" style="margin-left:var(--space-3)">no executors</span>'}</div>
        </div>`;
    }).join('');
    return `
      <details class="ov-project" data-pid="${esc(p.id)}"${open}>
        <summary>
          <span class="ov-pname">${esc(p.name)}</span>
          <span class="ov-ppath">${esc(p.parentName ? p.parentName + ' / ' : '')}${esc(p.cwd)}</span>
        </summary>
        ${orchs}
      </details>`;
  }).join('');
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
// Two-stage break-glass stop. Delegated (survives re-render): first click on a
// stop control arms it (shows "⚠ stop?"); a second click fires the stop.
root.addEventListener('click', async (event) => {
  const btn = event.target.closest('.ov-stop');
  if (!btn) return;
  event.preventDefault();
  const laneId = btn.dataset.lane;
  if (!laneId) return;
  if (!armed.has(laneId)) {
    armed.add(laneId);
    render(lastData, openSet()); // reflect the armed state immediately
    // auto-disarm after 30s if not confirmed (long enough for an operator to react)
    setTimeout(() => { if (armed.delete(laneId)) render(lastData, openSet()); }, 30000);
    return;
  }
  armed.delete(laneId);
  btn.disabled = true;
  try {
    await fetch('/api/emergency-stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ laneId }),
    });
  } catch (err) { /* poll will reflect reality */ }
  poll();
});

poll();
setInterval(poll, 2000);
