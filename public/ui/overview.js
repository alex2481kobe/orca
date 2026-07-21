// v2 read-only dashboard app: collapsible sidebar (logo→home, projects, nav),
// and three screens — Home (the projects→orchestrators→executors tree),
// Settings, and Remote (pairing + Tailscale). Hash-routed. CSP: script-src 'self'.
import { icon, FOLDER_ICON } from './icons.js';
import { shouldRenderProjectOpen } from './home-disclosure.js';

const app = document.getElementById('app');
const sideProjects = document.getElementById('side-projects');
const sideNav = document.getElementById('side-nav');
const main = document.getElementById('main');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tagClass = (tag) => {
  const t = String(tag || '').toLowerCase();
  if (t.includes('working') || t === 'auditing') return 'working';
  if (t.includes('waiting') || t.includes('approval') || t.includes('awaiting')) return 'waiting';
  if (t.includes('fail') || t.includes('block')) return 'failed';
  return '';
};

// ---- state (survives the 2s re-render) ----
let selectedProjectId = null;
const armed = new Set();
let lastData = { projects: [] };
function route() { return (location.hash.replace(/^#\/?/, '') || 'home'); }

// ---- collapse ----
try { if (localStorage.getItem('orca.sidebar') === 'collapsed') app.classList.add('collapsed'); } catch { /* */ }
document.getElementById('collapse').innerHTML = icon('panel-left', { size: 18 });
document.getElementById('collapse').addEventListener('click', () => {
  app.classList.toggle('collapsed');
  try { localStorage.setItem('orca.sidebar', app.classList.contains('collapsed') ? 'collapsed' : 'open'); } catch { /* */ }
});
document.getElementById('logo-home').addEventListener('click', () => { selectedProjectId = null; location.hash = ''; });

// ---- sidebar ----
function activeAgents(p) { return p.orchestrators.filter((o) => !o.stale).length; }
function renderSidebar(data) {
  const r = route();
  sideProjects.innerHTML = data.projects.map((p) => {
    const active = activeAgents(p);
    const sel = (r === 'home' && p.id === selectedProjectId) ? ' selected' : '';
    return `
      <button class="side-project${sel}" data-pid="${esc(p.id)}" title="${esc(p.cwd)}">
        ${FOLDER_ICON}
        <span class="side-pname">${esc(p.name)}</span>
        <span class="side-dot${active ? ' live' : ''}"></span>
        ${active ? `<span class="side-count">${active}</span>` : ''}
      </button>`;
  }).join('') || '<div class="side-empty">No projects yet.</div>';
  sideNav.innerHTML = `
    <button class="side-nav-btn${r === 'remote' ? ' selected' : ''}" data-nav="remote">${icon('remote')}<span>Remote devices</span></button>
    <button class="side-nav-btn${r === 'settings' ? ' selected' : ''}" data-nav="settings">${icon('settings')}<span>Settings</span></button>`;
}

// ---- home (tree) ----
function stopControl(id) {
  return armed.has(id)
    ? `<button class="ov-stop armed" data-lane="${esc(id)}" title="Click again to stop">⚠ stop?</button>`
    : `<button class="ov-stop" data-lane="${esc(id)}" title="Break-glass: stop this executor">⏹</button>`;
}
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
function previewChip(v) {
  const href = v.url || v.localUrl || '';
  if (!href) return '';
  const h = String(v.healthStatus || '').toLowerCase();
  const cls = /ok|health|reachable|up|200/.test(h) ? ' up' : /unreach|fail|down|error|refus/.test(h) ? ' down' : '';
  const remote = Boolean(v.tailnetUrl);
  return `<a class="ov-preview" href="${esc(href)}" target="_blank" rel="noopener"
      title="${esc(v.tailnetUrl || v.localUrl || href)}${remote ? '' : ' (local only — Tailscale not detected)'}">
    <span class="ov-preview-dot${cls}"></span>${icon('external', { cls: 'ov-preview-ic', size: 13 })}<span class="ov-preview-label">${esc(v.label) || 'Preview'}</span>${v.port ? `<span class="ov-preview-port">:${esc(v.port)}</span>` : ''}
  </a>`;
}
function projectCard(p, wasOpen, freshEntry) {
  const open = shouldRenderProjectOpen({ pid: p.id, wasOpen, freshEntry, hasSelection: Boolean(selectedProjectId) }) ? ' open' : '';
  const previews = (p.previews || []).filter((v) => v.url || v.localUrl);
  const previewsHtml = previews.length ? `<div class="ov-previews">${previews.map(previewChip).join('')}</div>` : '';
  const orchs = p.orchestrators.map((o) => `
    <div class="ov-orch${o.stale ? ' stale' : ''}">
      <div class="ov-orow">${icon('agent', { cls: 'ov-oicon' })}<span class="ov-otitle">${esc(o.title) || 'Untitled orchestrator'}</span><span class="ov-oactor">${esc(o.actor)}</span></div>
      ${o.focus ? `<div class="ov-ofocus">${esc(o.focus)}</div>` : ''}
      <div class="ov-execs">${o.executors.map(executorRow).join('') || '<span class="ov-etext" style="margin-left:var(--space-3)">no executors</span>'}</div>
    </div>`).join('');
  return `
    <details class="ov-project" data-pid="${esc(p.id)}"${open}>
      <summary>${FOLDER_ICON}<span class="ov-pname">${esc(p.name)}</span><span class="ov-ppath">${esc(p.parentName ? p.parentName + ' / ' : '')}${esc(p.cwd)}</span></summary>
      ${previewsHtml}
      ${orchs}
    </details>`;
}
function homeOpenSet() {
  return new Set([...main.querySelectorAll('.ov-project[open]')].map((d) => d.dataset.pid));
}
function renderHome(data, freshEntry = false) {
  const wasOpen = homeOpenSet();
  const shown = selectedProjectId ? data.projects.filter((p) => p.id === selectedProjectId) : data.projects;
  const title = selectedProjectId ? (data.projects.find((p) => p.id === selectedProjectId)?.name || 'Orca') : 'All projects';
  const n = selectedProjectId ? (shown[0]?.orchestrators.length || 0) : data.projects.length;
  const noun = selectedProjectId ? 'orchestrator' : 'project';
  const count = n ? `${n} ${noun}${n > 1 ? 's' : ''}` : '';
  main.innerHTML = `
    <div class="screen-head"><h1>${esc(title)}</h1><span class="screen-sub">${count}</span></div>
    <div id="ov-root">${shown.length ? shown.map((p) => projectCard(p, wasOpen, freshEntry)).join('') : '<div class="ov-empty">No agents registered. Register an orchestrator from your CLI to see it here.</div>'}</div>`;
}

// ---- settings (full screen) ----
function renderSettings() {
  const pref = (() => { try { return localStorage.getItem('orca.theme') || 'system'; } catch { return 'system'; } })();
  main.innerHTML = `
    <div class="screen-head"><button class="back-btn" data-back>${icon('chevron-left')}<span>Back</span></button><h1>Settings</h1></div>
    <div class="card">
      <div class="card-row">
        <div class="card-label">Theme</div>
        <div class="theme-toggle">
          ${['system', 'light', 'dark'].map((t) => `<button class="theme-opt${t === pref ? ' selected' : ''}" data-theme="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-label">About</div>
      <p class="card-text">Orca runs locally as your agents' headquarters. Agents register over MCP (<code>orca-mcp</code>) and spawn executors; you watch them here. Open <b>Remote devices</b> to view this dashboard on your phone over Tailscale.</p>
    </div>`;
}

// ---- remote (pairing + tailscale) ----
async function renderRemote() {
  main.innerHTML = `<div class="screen-head"><button class="back-btn" data-back>${icon('chevron-left')}<span>Back</span></button><h1>Remote devices</h1></div><div id="remote-body"><div class="ov-empty">Loading…</div></div>`;
  const body = document.getElementById('remote-body');
  let access = {};
  try { access = await (await fetch('/api/private-access', { headers: { accept: 'application/json' } })).json(); } catch { /* */ }
  const tailnet = access.tailnet || {};
  const serveOn = Boolean(access.serve?.enabled || tailnet.serving);
  const magicDns = tailnet.magicDnsName || tailnet.dnsName || '';
  body.innerHTML = `
    <div class="card">
      <div class="card-row"><div><div class="card-label">Tailscale</div><div class="card-text">${serveOn ? `Serving privately${magicDns ? ` at <code>${esc(magicDns)}</code>` : ''}.` : 'Not yet serving. Enable Tailscale Serve to reach this dashboard from your phone on your private tailnet.'}</div></div><span class="pill ${serveOn ? 'ok' : 'off'}">${serveOn ? 'on' : 'off'}</span></div>
    </div>
    <div class="card">
      <div class="card-label">Pair a phone</div>
      <p class="card-text">Generate a one-time pairing code, then open the dashboard URL on your phone (over Tailscale) and enter it. No public exposure; the session is an HttpOnly cookie.</p>
      <button class="btn" id="gen-pair">Generate pairing code</button>
      <div id="pair-out" class="pair-out"></div>
    </div>
    <div class="card">
      <div class="card-label">Setup</div>
      <p class="card-text">Full walkthrough: <code>docs/tailscale-mobile-access.md</code>.</p>
    </div>`;
  const gen = document.getElementById('gen-pair');
  if (gen) gen.addEventListener('click', async () => {
    gen.disabled = true;
    try {
      const res = await fetch('/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', label: 'phone' }) });
      const data = await res.json();
      const code = data.code || data.pairingCode || (data.pairing && data.pairing.code);
      document.getElementById('pair-out').innerHTML = code
        ? `<div class="pair-code">${esc(code)}</div><div class="card-text">Enter this on the phone within the expiry window.</div>`
        : `<div class="card-text">Could not generate a code (${esc(data.error || res.status)}).</div>`;
    } catch (e) {
      document.getElementById('pair-out').innerHTML = '<div class="card-text">Could not reach Orca.</div>';
    }
    gen.disabled = false;
  });
}

// ---- theme ----
function applyTheme(pref) {
  try { if (pref === 'system') localStorage.removeItem('orca.theme'); else localStorage.setItem('orca.theme', pref); } catch { /* */ }
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  main.querySelectorAll('.theme-opt').forEach((b) => b.classList.toggle('selected', b.dataset.theme === pref));
}

// ---- render dispatch ----
function renderScreen() {
  renderSidebar(lastData);
  const r = route();
  if (r === 'settings') renderSettings();
  else if (r === 'remote') renderRemote();
  else renderHome(lastData, true); // fresh entry to home: expand the tree
}

async function poll() {
  try {
    const res = await fetch('/api/overview', { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    lastData = await res.json();
    renderSidebar(lastData);
    if (route() === 'home') renderHome(lastData); // only the tree auto-refreshes
  } catch { /* */ }
}

// ---- interactions (delegated) ----
sideProjects.addEventListener('click', (e) => {
  const btn = e.target.closest('.side-project');
  if (!btn) return;
  selectedProjectId = btn.dataset.pid || null;
  if (route() !== 'home') location.hash = ''; else renderScreen();
});
sideNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.side-nav-btn');
  if (btn) location.hash = btn.dataset.nav;
});
main.addEventListener('click', async (e) => {
  if (e.target.closest('[data-back]')) { location.hash = ''; return; }
  const opt = e.target.closest('.theme-opt');
  if (opt) { applyTheme(opt.dataset.theme); return; }
  const stop = e.target.closest('.ov-stop');
  if (stop) {
    e.preventDefault();
    const laneId = stop.dataset.lane;
    if (!laneId) return;
    if (!armed.has(laneId)) { armed.add(laneId); renderHome(lastData); setTimeout(() => { if (armed.delete(laneId)) renderHome(lastData); }, 30000); return; }
    armed.delete(laneId); stop.disabled = true;
    try { await fetch('/api/emergency-stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ laneId }) }); } catch { /* */ }
    poll();
  }
});

window.addEventListener('hashchange', renderScreen);
poll().then(renderScreen);
setInterval(poll, 2000);
