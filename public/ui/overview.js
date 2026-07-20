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

// Preserve which <details> are open across re-render (ephemeral-state invariant).
function openSet() {
  return new Set([...document.querySelectorAll('.ov-project[open]')].map((d) => d.dataset.pid));
}

function render(data, wasOpen) {
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
poll();
setInterval(poll, 2000);
