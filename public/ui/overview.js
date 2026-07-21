// v2 read-only dashboard — rendered on the shared Orca design system (styles.css):
// app-topbar + .ops-shell grid + .ops-sidebar (full collapse via body.sidebar-collapsed)
// + .ops-main/.ops-content. Screens: Home (projects→orchestrators→executors tree),
// Settings, Remote devices. Hash-routed. CSP: script-src 'self' (external module only).
import { icon, FOLDER_ICON } from './icons.js';
import { shouldRenderProjectOpen } from './home-disclosure.js';
import { qrSvgForText } from './qr.js';

const body = document.body;
const sideProjects = document.getElementById('sidebar-projects');
const topbarTitle = document.getElementById('topbar-title');
const content = document.getElementById('content');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tagClass = (tag) => {
  const t = String(tag || '').toLowerCase();
  if (t.includes('working') || t === 'auditing') return 'working';
  if (t.includes('waiting') || t.includes('approval') || t.includes('awaiting')) return 'waiting';
  if (t.includes('fail') || t.includes('block')) return 'failed';
  return '';
};

// ---- state ----
let selectedProjectId = null;
const armed = new Set();
const collapsed = new Set(); // project pids the operator explicitly collapsed
let lastData = { projects: [] };
function route() { return (location.hash.replace(/^#\/?/, '') || 'home'); }

// ---- sidebar collapse (full collapse via body.sidebar-collapsed, old design system) ----
try { if (localStorage.getItem('orca.sidebar') === 'collapsed') body.classList.add('sidebar-collapsed'); } catch { /* */ }
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-action="toggleNav"]');
  if (!toggle) return;
  body.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('orca.sidebar', body.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open'); } catch { /* */ }
});
document.getElementById('brand-home').addEventListener('click', (e) => { e.preventDefault(); selectedProjectId = null; location.hash = ''; });

// ---- sidebar project list ----
function activeAgents(p) { return p.orchestrators.filter((o) => !o.stale).length; }
function renderSidebar(data) {
  const r = route();
  sideProjects.innerHTML = data.projects.map((p) => {
    const active = activeAgents(p);
    const sel = (r === 'home' && p.id === selectedProjectId) ? ' is-selected' : '';
    return `<button class="sidebar-link sidebar-project${sel}" data-pid="${esc(p.id)}" type="button" title="${esc(p.cwd)}">
      <span class="sidebar-folder" aria-hidden="true">${FOLDER_ICON}</span>
      <span>${esc(p.name)}</span>
      ${active ? `<span class="pill">${active}</span>` : '<span></span>'}
    </button>`;
  }).join('') || '<div class="sidebar-empty">No projects yet.</div>';
  // Footer nav active state
  document.querySelectorAll('.sidebar-footer [data-nav]').forEach((b) => b.classList.toggle('is-selected', b.dataset.nav === r));
}

// ---- home tree ----
function stopControl(id) {
  return armed.has(id)
    ? `<button class="ov-stop armed" data-lane="${esc(id)}" title="Click again to stop">⚠ stop?</button>`
    : `<button class="ov-stop" data-lane="${esc(id)}" title="Break-glass: stop this executor">⏹</button>`;
}
function executorRow(e) {
  return `<div class="ov-exec${e.terminal ? ' terminal' : ''}">
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
  return `<a class="ov-preview" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(v.tailnetUrl || v.localUrl || href)}${remote ? '' : ' (local only — Tailscale not detected)'}">
    <span class="ov-preview-dot${cls}"></span>${icon('external', { cls: 'ov-preview-ic', size: 13 })}<span class="ov-preview-label">${esc(v.label) || 'Preview'}</span>${v.port ? `<span class="ov-preview-port">:${esc(v.port)}</span>` : ''}
  </a>`;
}
function projectCard(p) {
  const open = shouldRenderProjectOpen({ pid: p.id, collapsedPids: collapsed }) ? ' open' : '';
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
function renderHome(data) {
  const shown = selectedProjectId ? data.projects.filter((p) => p.id === selectedProjectId) : data.projects;
  topbarTitle.textContent = selectedProjectId ? (data.projects.find((p) => p.id === selectedProjectId)?.name || '') : '';
  if (!shown.length) {
    content.innerHTML = `<div class="ov-empty-wrap"><div class="ov-empty">
      ${icon('agent', { size: 26 })}
      <div class="ov-empty-title">No agents registered</div>
      <div class="ov-empty-sub">Register an orchestrator from your CLI (<code>orchestrator.register</code>) and it will appear here.</div>
    </div></div>`;
    return;
  }
  content.innerHTML = `<div class="ov-tree">${shown.map((p) => projectCard(p)).join('')}</div>`;
}
// A project renders open by default; remember the operator's explicit collapses
// so the 2s poll re-render preserves them (toggle doesn't bubble → capture).
content.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('ov-project') || !d.dataset.pid) return;
  if (d.open) collapsed.delete(d.dataset.pid); else collapsed.add(d.dataset.pid);
}, true);

// ---- settings screen ----
function renderSettings() {
  topbarTitle.textContent = 'Settings';
  const pref = (() => { try { return localStorage.getItem('orca.theme') || 'system'; } catch { return 'system'; } })();
  content.innerHTML = `
    <div class="screen">
      <div class="screen-head"><button class="btn-back" data-back type="button">${icon('chevron-left')}<span>Back</span></button><h1>Settings</h1></div>
      <article class="card">
        <div class="card-row">
          <div class="card-label">Theme</div>
          <div class="seg-theme">${['system', 'light', 'dark'].map((t) => `<button class="seg-opt${t === pref ? ' is-active' : ''}" data-theme="${t}" type="button">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
        </div>
      </article>
      <article class="card">
        <div class="card-label">About</div>
        <p class="card-text">Orca is your agents' local headquarters. Agents register over MCP (<code>orca-mcp</code>) and spawn executors under contract; you watch them here. Open <b>Remote devices</b> to reach this dashboard from your phone over Tailscale.</p>
      </article>
    </div>`;
}

// ---- remote devices screen ----
async function renderRemote() {
  topbarTitle.textContent = 'Remote devices';
  content.innerHTML = `<div class="screen">
    <div class="screen-head"><button class="btn-back" data-back type="button">${icon('chevron-left')}<span>Back</span></button><h1>Remote devices</h1></div>
    <div id="remote-body"><div class="ov-empty-sub" style="padding:var(--space-5)">Loading…</div></div>
  </div>`;
  const bodyEl = document.getElementById('remote-body');
  let access = {};
  try { access = await (await fetch('/api/private-access', { headers: { accept: 'application/json' } })).json(); } catch { /* */ }
  const tailnet = access.tailnet || {};
  const magicDns = tailnet.hostname || tailnet.magicDnsName || tailnet.dnsName || '';
  const serveOn = Boolean(tailnet.serveConfigured || tailnet.servedUrl);
  const tailnetUp = Boolean(tailnet.binaryAvailable && tailnet.loggedIn);
  // The URL a phone/laptop on the tailnet opens to reach this dashboard.
  const phoneUrl = tailnet.servedUrl || (magicDns ? `http://${esc(magicDns)}:${location.port || '3000'}/` : '');
  const statusText = serveOn
    ? `Serving privately on your tailnet${magicDns ? ` — <code>${esc(magicDns)}</code>` : ''}.`
    : tailnetUp
      ? 'Tailscale is up. Enable Serve (or open the tailnet address directly) so other devices can reach this dashboard.'
      : 'Not connected. Bring up Tailscale on this machine so your phone/laptop on the same tailnet can reach the dashboard and your projects’ dev-server previews.';
  bodyEl.innerHTML = `
    <article class="card control-card">
      <div class="card-row">
        <div><div class="card-label">Tailscale</div><div class="card-text">${statusText}</div></div>
        <span class="status-pill ${serveOn ? 'ok' : ''}">${serveOn ? 'on' : tailnetUp ? 'ready' : 'off'}</span>
      </div>
      ${phoneUrl ? `<div class="qr-wrap">${qrSvgForText(phoneUrl)}<span>Scan with your phone to open this dashboard over Tailscale</span></div>
      <p class="card-text" style="margin-top:var(--space-3)">Or open <code>${esc(phoneUrl)}</code></p>` : ''}
    </article>
    <article class="card control-card">
      <div class="card-label">Pair a device</div>
      <p class="card-text">Generate a one-time code, then open the dashboard on the device (over Tailscale) and enter it. No public exposure; the session is an HttpOnly cookie.</p>
      <button class="btn" id="gen-pair" type="button">Generate pairing code</button>
      <div id="pair-out" class="pair-out"></div>
    </article>
    <article class="card control-card">
      <div class="card-label">Setup</div>
      <p class="card-text">Full walkthrough: <code>docs/tailscale-mobile-access.md</code>.</p>
    </article>`;
  const gen = document.getElementById('gen-pair');
  if (gen) gen.addEventListener('click', async () => {
    gen.disabled = true;
    try {
      const res = await fetch('/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', label: 'device' }) });
      const data = await res.json();
      const code = data.code || data.pairingCode || (data.pairing && data.pairing.code);
      document.getElementById('pair-out').innerHTML = code
        ? `<div class="pair-code">${esc(code)}</div><div class="card-text">Enter this on the device within the expiry window.</div>`
        : `<div class="card-text">Could not generate a code (${esc(data.error || res.status)}).</div>`;
    } catch {
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
  content.querySelectorAll('.seg-opt').forEach((b) => b.classList.toggle('is-active', b.dataset.theme === pref));
}

// ---- render dispatch ----
function renderScreen() {
  content.removeAttribute('aria-busy');
  renderSidebar(lastData);
  const r = route();
  if (r === 'settings') renderSettings();
  else if (r === 'remote') renderRemote();
  else renderHome(lastData);
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

// ---- interactions ----
sideProjects.addEventListener('click', (e) => {
  const btn = e.target.closest('.sidebar-project');
  if (!btn) return;
  selectedProjectId = btn.dataset.pid || null;
  if (route() !== 'home') location.hash = ''; else renderScreen();
});
document.querySelector('.sidebar-footer').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-nav]');
  if (btn) location.hash = btn.dataset.nav;
});
content.addEventListener('click', async (e) => {
  if (e.target.closest('[data-back]')) { location.hash = ''; return; }
  const opt = e.target.closest('.seg-opt');
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
