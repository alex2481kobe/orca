// v2 read-only dashboard — rendered on the shared Orca design system (styles.css):
// app-topbar + .ops-shell grid + .ops-sidebar (full collapse via body.sidebar-collapsed)
// + .ops-main/.ops-content. Screens: Home (ONE project → orchestrators → executors
// tree), Settings, Remote devices. Hash-routed. CSP: script-src 'self'.
//
// Home is SCOPED TO ONE PROJECT. It used to draw every project the projection
// returned, which over the owner's real state is 3 projects, 11 orchestrators
// and 50 lanes in a single flat tree — a dead animation project and Orca's own
// project mixed in with the work in hand. The other projects are reached by
// switching (the scope control in the canvas topbar, or the sidebar), never by
// being merged into the same tree. The rules that decide the scope are pure and
// live in scope.js so they can be tested; this file only draws them.
import { icon, FOLDER_ICON } from './icons.js';
import { qrSvgForText } from './qr.js';
import { chooseProjectId, partitionProject, otherProjectCount } from './scope.js';

const body = document.body;
const sideProjects = document.getElementById('sidebar-projects');
const topbarTitle = document.getElementById('topbar-title');
const content = document.getElementById('content');
const fenceBanner = document.getElementById('fence-banner');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- state ----
// The project the viewer picked in THIS session. null means "no explicit pick" —
// scope.js then falls back to what this browser remembered, then to the
// projection's own nomination. It never means "show every project".
let selectedProjectId = null;
// Retired work inside the scoped project. TRI-STATE, and the null default is the
// important one: null lets scope.js decide, and it only collapses retired work
// when there is live work for the collapse to protect — so a project where
// nothing has run for hours still draws its finished lanes instead of an empty
// canvas. true/false are the viewer's explicit toggle. Never persisted, so a new
// tab always opens on the automatic choice.
let showRetired = null;
let collapsingRetired = false; // what the last render actually did, for the toggle
const REMEMBERED_PROJECT_KEY = 'orca.project';
const rememberedProjectId = () => {
  try { return localStorage.getItem(REMEMBERED_PROJECT_KEY); } catch { return null; }
};
const rememberProjectId = (id) => {
  try { if (id) localStorage.setItem(REMEMBERED_PROJECT_KEY, id); } catch { /* */ }
};
// The one place the scope is decided. Everything that draws Home goes through it,
// so there is no second path that could resolve to "all projects" or to nothing.
const scopedProjectId = (data) => chooseProjectId(data, {
  selected: selectedProjectId,
  remembered: rememberedProjectId(),
});
const scopedProject = (data) => (data.projects || []).find((p) => p.id === scopedProjectId(data)) || null;
const armed = new Set();
let lastData = { projects: [] };
// An unpaired remote device (a phone over Tailscale) gets a 401 from /api/overview.
// When that happens we take over the whole screen with the pairing GATE below
// instead of leaving the device stuck on "Connecting…". Cleared once pairing sets
// the session cookie and /api/overview returns 200.
let accessBlocked = false;
// The daemon is unreachable (fetch throws — server down, not an HTTP error). We
// take over the screen with the reconnecting "Start Orca" panel IN THE CURRENT
// design rather than letting a stale/legacy shell show through on a hard reload.
// Any successful HTTP response clears it and the poll loop reconnects on its own.
let offline = false;
let sawFirstResponse = false;
function route() { return (location.hash.replace(/^#\/?/, '') || 'home'); }

// The fence (src/fence.js): the directories agents may work in. While Orca is
// not set up (or its roots are invalid) no agent can register and no executor
// launches, and a whole-home fence stays flagged even once acknowledged. Shown
// on every screen with the one workstation command that fixes it: the dashboard
// itself cannot change the fence.
function renderFenceBanner(fence) {
  if (!fenceBanner) return;
  const blocking = Boolean(fence) && fence.status !== 'configured';
  const warning = Boolean(fence) && fence.status === 'configured' && fence.homeWide;
  fenceBanner.hidden = !(blocking || warning);
  if (fenceBanner.hidden) { fenceBanner.innerHTML = ''; return; }
  const title = blocking
    ? (fence.status === 'invalid' ? 'Orca’s approved roots are invalid' : 'Orca is not set up')
    : 'Agents may work anywhere in your home directory';
  const text = blocking ? fence.summary : (fence.warnings || []).join(' ');
  fenceBanner.classList.toggle('is-blocking', blocking);
  fenceBanner.innerHTML = `<strong>${esc(title)}</strong><span>${esc(text)}</span>`
    + (blocking && fence.fix ? `<span class="fence-banner-label">Run on the Orca workstation:</span><code>${esc(fence.fix)}</code>` : '');
}

// ---- sidebar collapse (desktop: body.sidebar-collapsed; mobile: body.nav-open drawer) ----
const isMobile = () => window.matchMedia('(max-width: 880px)').matches;
// Offline heuristic only: with no server data, a loopback host is the workstation
// itself; anything else (a tailnet hostname on a phone) is a remote client.
const isLoopbackHost = () => /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/.test(window.location.hostname);
const closeMobileNav = () => { if (isMobile()) body.classList.remove('nav-open'); };
// The collapsed state is a DESKTOP-only affordance. On a phone the sidebar is a
// drawer, and body.sidebar-collapsed applies pointer-events:none to it — so a stale
// 'collapsed' value (e.g. set while wide in landscape, then rotated to portrait)
// would make the drawer untappable. Never apply it at phone widths.
try { if (!isMobile() && localStorage.getItem('orca.sidebar') === 'collapsed') body.classList.add('sidebar-collapsed'); } catch { /* */ }
document.addEventListener('click', (e) => {
  // A click outside the ⋯ menu (and not on a menu button) closes it.
  if (openMenuId && !e.target.closest('.ov-node-menu, [data-menu]')) closeNodeMenu();
  // Same for the project switcher popover.
  if (projectsOpen && !e.target.closest('.ov-projects, [data-canvas="projects"]')) {
    projectsOpen = false;
    if (canvasEls) canvasEls.projects.hidden = true;
  }
  // Backdrop tap closes the mobile drawer.
  if (e.target.closest('#sidebar-backdrop')) { body.classList.remove('nav-open'); return; }
  // A click anywhere outside an open device-card dropdown closes it (not just
  // re-clicking the card). Clicks inside the cards/dropdown are left alone.
  if (openDeviceCard && !e.target.closest('.device-cards-wrap')) { openDeviceCard = null; paintRemote(remoteAccessCache); }
  const toggle = e.target.closest('[data-action="toggleNav"]');
  if (!toggle) return;
  // On a phone the sidebar is a fixed drawer keyed on body.nav-open; on desktop
  // it fully collapses via body.sidebar-collapsed.
  // Defensively drop the desktop collapsed state before opening the drawer, so a
  // stale 'collapsed' class can never make the phone drawer pointer-events:none.
  if (isMobile()) { body.classList.remove('sidebar-collapsed'); body.classList.toggle('nav-open'); return; }
  body.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('orca.sidebar', body.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open'); } catch { /* */ }
});
// The brand returns Home to the project the projection nominates — dropping the
// session's pick, NOT widening the screen to every project.
document.getElementById('brand-home').addEventListener('click', (e) => { e.preventDefault(); selectedProjectId = null; showRetired = null; closeMobileNav(); location.hash = ''; renderScreen(); });

// ---- sidebar project list ----
function renderSidebar(data) {
  const r = route();
  // The sidebar is how the OTHER projects stay reachable now that Home shows one
  // of them, so it marks the scoped project and says how big each one is: a live
  // count when something is running, otherwise the total lane count. A project
  // with nothing in it still gets a row — an empty project is a visible project.
  const current = scopedProjectId(data);
  sideProjects.innerHTML = data.projects.map((p) => {
    const sel = (r === 'home' && p.id === current) ? ' is-selected' : '';
    const live = Number(p.liveExecutorCount) || 0;
    const count = live
      ? `<span class="sidebar-count is-live" title="${live} running">${live}</span>`
      : `<span class="sidebar-count" title="${Number(p.executorCount) || 0} lanes, none running">${Number(p.executorCount) || 0}</span>`;
    return `<button class="sidebar-link sidebar-project${sel}" data-pid="${esc(p.id)}" type="button" title="${esc(p.cwd)}">
      <span class="sidebar-folder" aria-hidden="true">${FOLDER_ICON}</span>
      <span>${esc(p.name)}</span>
      ${count}
    </button>`;
  }).join('') || '<div class="sidebar-empty">No projects yet.</div>';
  // Nav active state (Remote devices pair-button + Settings footer row)
  document.querySelectorAll('#sidebar [data-nav]').forEach((b) => b.classList.toggle('is-selected', b.dataset.nav === r));
}

// ================= Home: live agent node-graph canvas =================
// The main area is an interactive orchestration tree — orchestrator roots →
// executor lanes, connected by edges, pan/zoom + auto-layout. Built ONCE and
// then patched: the 2s poll must NEVER rebuild the canvas or it would reset the
// viewport / kill an in-progress drag (the [[render-ephemeral-state-invariant]]
// bug class). Pan/zoom is a single CSS transform on .ov-scene (GPU compositing,
// no layout/paint per frame); layout only re-runs when data.revision changes.

const NODE_W = 228, NODE_H = 120, GAP_X = 44, GAP_Y = 100, PAD = 52, SUBTREE_GAP = 72;
// Viewport + drag state live at module scope so they survive every re-render.
let viewport = { x: 0, y: 0, scale: 1 };
let canvasBuilt = false;
let canvasEls = null;   // { workspace, head, canvas, scene, edges, statbar, links, menu }
let lastLayoutSig = null; // re-layout only when the tree shape/state changes
let fitPending = true;
let runtimeTimer = null;
let lastPos = null; // last computed layout, for the fit control between polls
let openMenuId = null; // which node's ⋯ action menu is open (survives the poll)

// Real lane/orchestrator state → the minimal UI vocabulary (no bloat).
function laneUi(e) {
  if (e.terminal) {
    if (e.state === 'failed') return 'failed';
    if (e.state === 'stopped') return 'stopped';
    if (e.state === 'done' || e.state === 'accepted') return 'complete';
    return 'idle';
  }
  if (e.state === 'starting') return 'spawning';
  if (e.state === 'queued') return 'queued';
  if (e.state === 'ready_for_audit' || e.state === 'auditing' || e.state === 'fix_requested' || e.state === 'blocked') return 'waiting';
  return 'running'; // running, needs_critique
}
const orchUi = (o) => (o.stale || o.resignedAt) ? 'idle' : 'running';
const UI_LABEL = { running: 'Running', spawning: 'Spawning', queued: 'Queued', waiting: 'Waiting', complete: 'Complete', idle: 'Idle', failed: 'Failed', stopped: 'Stopped' };
const UI_CLS = { running: 'st-run', spawning: 'st-spawn', queued: 'st-queue', waiting: 'st-wait', complete: 'st-done', idle: 'st-idle', failed: 'st-bad', stopped: 'st-bad' };
const INFLIGHT = new Set(['running', 'spawning', 'waiting']); // states that show a live runtime

// Live URL chip (a registered dev-server port, auto-served over Tailscale).
function previewChip(v) {
  const href = v.url || v.localUrl || '';
  if (!href) return '';
  const h = String(v.healthStatus || '').toLowerCase();
  const cls = /ok|health|reachable|up|200/.test(h) ? ' up' : /unreach|fail|down|error|refus/.test(h) ? ' down' : '';
  const remote = Boolean(v.tailnetUrl || (v.url && !v.url.includes('127.0.0.1')));
  return `<a class="ov-preview" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(v.tailnetUrl || v.localUrl || href)}${remote ? '' : ' (local only, Tailscale not detected)'}">
    <span class="ov-preview-dot${cls}"></span>${icon('external', { cls: 'ov-preview-ic', size: 13 })}<span class="ov-preview-label">${esc(v.label) || 'Preview'}</span>${v.port ? `<span class="ov-preview-port">:${esc(v.port)}</span>` : ''}
  </a>`;
}
let linksOpen = false;
let projectsOpen = false; // the project switcher popover
function collectPreviews(project) {
  return ((project && project.previews) || []).filter((v) => v.url || v.localUrl);
}

// Build the node forest (orchestrator roots → executor lanes) for the ONE
// scoped project. `orchestrators` is what partitionProject decided to draw, so
// retired agents/lanes are already collapsed out and counted; this only draws.
function buildForest(orchestrators) {
  const roots = [];
  (orchestrators || []).forEach((o) => {
    const ui = orchUi(o);
    // The projection bounds how many retired executors it sends and reports the
    // rest as executorsOmitted; say so on the node rather than quietly showing
    // a short list (see src/registry-overview.js).
    const omitted = Number(o.executorsOmitted) || 0;
    const sub = omitted
      ? `${o.focus || 'Orchestrator'} · ${omitted} older lane${omitted === 1 ? '' : 's'} not shown`
      : (o.focus || 'Orchestrator');
    roots.push({
      id: o.id, kind: 'orchestrator', title: o.title || 'Orchestrator',
      sub, cli: o.actor || '', ui, startedAt: null, terminal: false,
      children: (o.executors || []).map((e) => {
        const eui = laneUi(e);
        return {
          id: e.id, kind: 'executor', title: e.title || 'Executor',
          sub: e.statusText || 'Executor', cli: e.executorType || '', ui: eui,
          startedAt: e.startedAt || null, terminal: Boolean(e.terminal), children: [],
        };
      }),
    });
  });
  return roots;
}

// Deterministic tidy-tree layout: leaves get sequential x, parents center over
// their children. A forest lays subtrees left→right. Positions in scene coords.
function layoutForest(roots) {
  const pos = new Map();
  let cursor = 0;
  const place = (node, depth) => {
    let x;
    if (!node.children.length) { x = cursor; cursor += NODE_W + GAP_X; }
    else {
      const xs = node.children.map((c) => place(c, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    pos.set(node.id, { x, y: depth * (NODE_H + GAP_Y), node });
    return x;
  };
  // Wider gap BETWEEN orchestrator subtrees than between sibling leaves, so
  // multiple orchestrators under one project read as distinct trees, not a row.
  roots.forEach((r) => { place(r, 0); cursor += SUBTREE_GAP - GAP_X; });
  return pos;
}

// The kill action is gated behind a ⋯ menu (not an always-visible button) so it
// can't be clicked by accident. Only non-terminal nodes (something to stop) get it.
function nodeCard(node, p) {
  const cls = UI_CLS[node.ui] || 'st-idle';
  const runtime = (INFLIGHT.has(node.ui) && node.startedAt)
    ? `<span class="ov-runtime" data-started="${esc(node.startedAt)}"></span>` : '';
  const cli = node.cli ? `<span class="ov-cli" title="CLI agent">${esc(node.cli)}</span>` : '';
  const menu = node.terminal ? '' : `<button class="ov-menu-btn${openMenuId === node.id ? ' is-open' : ''}" data-menu="${esc(node.id)}" type="button" title="Actions" aria-label="Actions" aria-haspopup="menu">⋯</button>`;
  return `<div class="ov-node ov-node--${node.kind} ${cls}" data-id="${esc(node.id)}" data-kind="${node.kind}"
      style="left:${Math.round(p.x)}px;top:${Math.round(p.y)}px">
    <div class="ov-node-top">
      <span class="ov-node-title" title="${esc(node.title)}">${esc(node.title)}</span>
      ${menu}
    </div>
    <div class="ov-node-sub">${esc(node.sub)}</div>
    <div class="ov-node-foot">
      <span class="ov-pill ${cls}"><span class="ov-pill-dot"></span>${UI_LABEL[node.ui] || 'Idle'}</span>
      ${cli}${runtime}
    </div>
  </div>`;
}

// Orthogonal parent→child edges with ROUNDED elbows (down → arc → across → arc →
// down), drawn in scene coords. Straight drop when the child sits under the parent.
function edgesPath(roots, pos) {
  let d = '';
  const R = 12;
  const walk = (node) => {
    const pp = pos.get(node.id);
    node.children.forEach((c) => {
      const cp = pos.get(c.id);
      const px = pp.x + NODE_W / 2, py = pp.y + NODE_H;
      const cx = cp.x + NODE_W / 2, cy = cp.y;
      const midY = py + (cy - py) / 2;
      if (Math.abs(cx - px) < 2 * R + 1) {
        d += `M${px} ${py}V${cy}`;
      } else {
        const s = cx > px ? 1 : -1;
        d += `M${px} ${py}V${midY - R}Q${px} ${midY} ${px + s * R} ${midY}H${cx - s * R}Q${cx} ${midY} ${cx} ${midY + R}V${cy}`;
      }
      walk(c);
    });
  };
  roots.forEach(walk);
  return d;
}

function applyViewport() {
  if (!canvasEls) return;
  canvasEls.scene.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
}

function fitView(pos) {
  if (!canvasEls || !pos.size) return;
  let maxX = 0, maxY = 0;
  pos.forEach((pt) => { maxX = Math.max(maxX, pt.x + NODE_W); maxY = Math.max(maxY, pt.y + NODE_H); });
  const vw = canvasEls.canvas.clientWidth || 1000, vh = canvasEls.canvas.clientHeight || 700;
  const scale = Math.min(1, (vw - PAD * 2) / maxX, (vh - PAD * 2) / maxY);
  viewport.scale = Math.max(0.3, scale);
  // CENTER the tree in the viewport (both axes) rather than pinning it to the top —
  // a short tree in a tall canvas otherwise hugs the top edge with dead space below
  // (very visible on a phone, where the canvas is tall and the tree is wide).
  viewport.x = Math.max(PAD, (vw - maxX * viewport.scale) / 2);
  viewport.y = Math.max(PAD, (vh - maxY * viewport.scale) / 2);
  applyViewport();
}

// Live "running Xm on current task" ticker — updates in place every second, no
// layout (mirrors the pairing countdown). Runs only while Home is on screen.
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function tickRuntimes() {
  if (!canvasEls) return;
  const now = Date.now();
  canvasEls.scene.querySelectorAll('.ov-runtime[data-started]').forEach((el) => {
    const t = Date.parse(el.dataset.started);
    el.textContent = Number.isNaN(t) ? '' : fmtDur(now - t);
  });
}
function startRuntimeTicker() { if (!runtimeTimer) { tickRuntimes(); runtimeTimer = setInterval(tickRuntimes, 1000); } }
function stopRuntimeTicker() { if (runtimeTimer) { clearInterval(runtimeTimer); runtimeTimer = null; } }

// Top stat cards — Active / Queued / Idle-or-Complete agents. Pure client
// reduction over the agents DRAWN for the scoped project, so the cards always
// describe the screen; the counts for what is not drawn are on the scope row.
function renderStats(orchestrators) {
  let active = 0, queued = 0, done = 0;
  (orchestrators || []).forEach((o) => {
    if (orchUi(o) === 'idle') done++; else active++;
    (o.executors || []).forEach((e) => {
      const u = laneUi(e);
      if (u === 'queued') queued++;
      else if (u === 'complete' || u === 'idle' || u === 'failed' || u === 'stopped') done++;
      else active++;
    });
  });
  const card = (n, label, cls) => `<div class="ov-stat"><div class="ov-stat-n ${cls}">${n}</div><div class="ov-stat-l">${label}</div></div>`;
  return card(active, 'Active agents', 'st-run') + card(queued, 'Queued agents', 'st-queue') + card(done, 'Idle / complete', 'st-idle');
}

// ---- per-node ⋯ action menu: ONE shared element positioned at SCREEN coords
// (so the canvas transform never scales it) and reflecting openMenuId so it
// survives the poll re-render. Gates the destructive Stop actions. ----
function positionMenu() {
  if (!openMenuId || !canvasEls) return;
  const btn = canvasEls.scene.querySelector(`.ov-menu-btn[data-menu="${openMenuId}"]`);
  if (!btn) { closeNodeMenu(); return; }
  const b = btn.getBoundingClientRect();
  const c = canvasEls.canvas.getBoundingClientRect();
  const menu = canvasEls.menu;
  menu.hidden = false;
  const w = menu.offsetWidth || 200;
  menu.style.left = `${Math.max(8, Math.min(b.right - c.left - w, c.width - w - 8))}px`;
  menu.style.top = `${Math.min(b.bottom - c.top + 6, c.height - menu.offsetHeight - 8)}px`;
}
function openNodeMenu(id, kind) {
  openMenuId = id;
  // Orchestrator: stop the agents it runs (its executor lanes), OR close the agent
  // itself (resign it). Executor (a leaf): just stop it.
  canvasEls.menu.innerHTML = kind === 'orchestrator'
    ? `<div class="ov-menu-head">Agent</div>
       <button class="ov-menu-item danger" data-stop-orch="${esc(id)}" type="button">Stop agents under it</button>
       <button class="ov-menu-item danger" data-resign-orch="${esc(id)}" type="button">Close this agent</button>`
    : `<div class="ov-menu-head">Executor</div>
       <button class="ov-menu-item danger" data-stop-lane="${esc(id)}" type="button">Stop this executor</button>`;
  canvasEls.scene.querySelectorAll('.ov-menu-btn.is-open').forEach((b) => b.classList.remove('is-open'));
  canvasEls.scene.querySelector(`.ov-menu-btn[data-menu="${id}"]`)?.classList.add('is-open');
  positionMenu();
}
function closeNodeMenu() {
  openMenuId = null;
  if (!canvasEls) return;
  canvasEls.menu.hidden = true;
  canvasEls.scene.querySelectorAll('.ov-menu-btn.is-open').forEach((b) => b.classList.remove('is-open'));
}

function buildCanvas() {
  content.innerHTML = `
    <div class="ov-workspace">
      <div class="ov-scope" id="ov-scope"></div>
      <div class="ov-topbar">
        <div class="ov-statbar" id="ov-statbar"></div>
        <div class="ov-controls">
          <button class="ov-ctrl ov-links-btn" data-canvas="links" type="button" title="Live links">${icon('external', { cls: 'ov-preview-ic', size: 14 })}<span>Live links</span></button>
          <button class="ov-ctrl" data-canvas="fit" type="button" title="Fit to view" aria-label="Fit to view">⤢</button>
          <button class="ov-ctrl" data-canvas="zoom-out" type="button" title="Zoom out" aria-label="Zoom out">&#8722;</button>
          <button class="ov-ctrl" data-canvas="zoom-in" type="button" title="Zoom in" aria-label="Zoom in">&#43;</button>
          <button class="ov-ctrl" data-canvas="fullscreen" type="button" title="Fullscreen" aria-label="Fullscreen">⛶</button>
        </div>
      </div>
      <div class="ov-canvas" id="ov-canvas">
        <div class="ov-links" id="ov-links" hidden></div>
        <div class="ov-projects" id="ov-projects" role="listbox" aria-label="Switch project" hidden></div>
        <div class="ov-project-empty" id="ov-project-empty" hidden></div>
        <div class="ov-node-menu" id="ov-node-menu" role="menu" hidden></div>
        <div class="ov-scene" id="ov-scene">
          <svg class="ov-edges" id="ov-edges"><path fill="none"/></svg>
        </div>
      </div>
    </div>`;
  const workspace = content.querySelector('.ov-workspace');
  const canvas = document.getElementById('ov-canvas');
  const scene = document.getElementById('ov-scene');
  const edges = document.getElementById('ov-edges');
  const statbar = document.getElementById('ov-statbar');
  const links = document.getElementById('ov-links');
  const menu = document.getElementById('ov-node-menu');
  const scope = document.getElementById('ov-scope');
  const projects = document.getElementById('ov-projects');
  const projectEmpty = document.getElementById('ov-project-empty');
  canvasEls = { workspace, canvas, scene, edges, statbar, links, menu, scope, projects, projectEmpty };

  // Pan: drag the canvas background (not a node/menu/link). rAF-coalesced → one
  // transform write per frame. Pointer capture so the drag survives leaving the box.
  let drag = null, raf = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.ov-node, .ov-node-menu, .ov-links, .ov-projects, .ov-project-empty, a')) return;
    closeNodeMenu();
    drag = { px: e.clientX, py: e.clientY, x: viewport.x, y: viewport.y };
    canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    viewport.x = drag.x + (e.clientX - drag.px);
    viewport.y = drag.y + (e.clientY - drag.py);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; applyViewport(); });
  });
  const endDrag = (e) => { if (drag) { drag = null; canvas.classList.remove('grabbing'); try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ } } };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    closeNodeMenu();
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  canvasBuilt = true;
}

function zoomAt(cx, cy, factor) {
  const next = Math.min(2.2, Math.max(0.3, viewport.scale * factor));
  const k = next / viewport.scale;
  viewport.x = cx - (cx - viewport.x) * k;
  viewport.y = cy - (cy - viewport.y) * k;
  viewport.scale = next;
  applyViewport();
}

// The scope control: which project Home is showing, and the one obvious way to
// change it. Rendered into the canvas topbar and re-filled every poll; the
// project list popover is toggled by the button, mirroring the live-links one.
function renderScopeBar(data, project, partition) {
  const others = otherProjectCount(data, project.id);
  const hidden = partition.hiddenCount;
  const retiredBits = [];
  if (partition.retiredOrchestratorCount) retiredBits.push(`${partition.retiredOrchestratorCount} agent${partition.retiredOrchestratorCount === 1 ? '' : 's'}`);
  if (partition.retiredExecutorCount) retiredBits.push(`${partition.retiredExecutorCount} lane${partition.retiredExecutorCount === 1 ? '' : 's'}`);
  // Retired work is COLLAPSED, and the count says exactly how much — the same
  // contract the projection already keeps with executorsOmitted.
  const expanded = !partition.collapsingRetired;
  const retiredBtn = (partition.retiredOrchestratorCount || partition.retiredExecutorCount)
    ? `<button class="ov-ctrl ov-retired-btn${expanded ? ' is-on' : ''}" data-canvas="retired" type="button"
         title="Retired = finished or stale, with nothing running">${expanded ? `Hide retired (${retiredBits.join(' · ')})` : `Show ${retiredBits.join(' · ') || 'retired'}`}</button>`
    : '';
  const omitted = partition.omittedExecutorCount
    ? `<span class="ov-scope-note">${partition.omittedExecutorCount} older lane${partition.omittedExecutorCount === 1 ? '' : 's'} beyond the projection window</span>`
    : '';
  return `<button class="ov-scope-btn" data-canvas="projects" type="button" aria-haspopup="listbox" aria-expanded="${projectsOpen ? 'true' : 'false'}">
      <span class="ov-scope-folder" aria-hidden="true">${FOLDER_ICON}</span>
      <span class="ov-scope-name">${esc(project.name || 'Project')}</span>
      <span class="ov-scope-caret" aria-hidden="true">▾</span>
    </button>
    <span class="ov-scope-note">${others ? `${others} other project${others === 1 ? '' : 's'}` : 'the only project'}${hidden ? ` · ${hidden} not shown` : ''}</span>
    ${omitted}${retiredBtn}`;
}

// The project switcher itself: every project, always, with its size — so
// switching is a listed choice, never a guess.
function renderProjectPicker(data, currentId) {
  return data.projects.map((p) => {
    const live = Number(p.liveExecutorCount) || 0;
    const meta = live
      ? `${live} running`
      : `${Number(p.orchestratorCount) || 0} agent${(Number(p.orchestratorCount) || 0) === 1 ? '' : 's'} · ${Number(p.executorCount) || 0} lane${(Number(p.executorCount) || 0) === 1 ? '' : 's'}`;
    return `<button class="ov-project-row${p.id === currentId ? ' is-selected' : ''}" data-pick-project="${esc(p.id)}" type="button" role="option" aria-selected="${p.id === currentId}" title="${esc(p.cwd || '')}">
      <span class="ov-project-name">${esc(p.name)}</span>
      <span class="ov-project-meta${live ? ' is-live' : ''}">${esc(meta)}</span>
    </button>`;
  }).join('');
}

function renderHome(data) {
  const project = scopedProject(data);
  topbarTitle.textContent = project ? (project.name || '') : '';
  // Nothing to scope TO: no project exists at all. This is the only empty Home,
  // and it is about the daemon, not about a project. A project that exists but
  // holds no agent gets the project-level empty state further down — the
  // difference is the whole point (see docs/audits/2026-09-11-overview-empty.md).
  if (!project) {
    body.classList.remove('home-canvas');
    canvasBuilt = false; canvasEls = null; lastLayoutSig = null; fitPending = true; stopRuntimeTicker();
    content.innerHTML = `<div class="ov-empty-wrap"><div class="ov-empty">
      ${icon('agent', { size: 26 })}
      <div class="ov-empty-title">No agents registered</div>
      <div class="ov-empty-sub">Register an orchestrator from your CLI (<code>orchestrator.register</code>).</div>
    </div></div>`;
    return;
  }
  body.classList.add('home-canvas');
  if (!canvasBuilt || !document.getElementById('ov-canvas')) { buildCanvas(); lastLayoutSig = null; fitPending = true; }
  startRuntimeTicker();

  // ONE project, with its retired work collapsed behind a count. Everything the
  // canvas does not draw is in partition.hiddenCount and is stated on screen.
  const partition = partitionProject(project, { showRetired });
  collapsingRetired = partition.collapsingRetired;
  const shownOrchestrators = partition.orchestrators;

  // Stat cards: cheap, every render.
  canvasEls.statbar.innerHTML = renderStats(shownOrchestrators);
  canvasEls.scope.innerHTML = renderScopeBar(data, project, partition);
  canvasEls.projects.innerHTML = renderProjectPicker(data, project.id);
  canvasEls.projects.hidden = !projectsOpen;
  // Live-links popover contents (kept in sync; visibility toggled by the button).
  const previews = collectPreviews(project);
  canvasEls.links.innerHTML = previews.length ? previews.map(previewChip).join('') : '<span class="tiny muted">No live links yet.</span>';
  canvasEls.links.hidden = !linksOpen;

  // A project with no agent to draw is still a project: say so with its name and
  // its counts, in the canvas, rather than falling back to the daemon-level empty
  // state or silently widening the screen to other projects.
  canvasEls.projectEmpty.hidden = shownOrchestrators.length > 0;
  if (!shownOrchestrators.length) {
    const total = Number(project.orchestratorCount) || 0;
    canvasEls.projectEmpty.innerHTML = total
      ? `<div class="ov-empty-title">Nothing running in ${esc(project.name)}</div>
         <div class="ov-empty-sub">All ${total} agent${total === 1 ? '' : 's'} here are retired, and ${partition.hiddenCount} row${partition.hiddenCount === 1 ? ' is' : 's are'} collapsed. Use “Show retired” above to see them.</div>`
      : `<div class="ov-empty-title">No agents in ${esc(project.name)} yet</div>
         <div class="ov-empty-sub">Register an orchestrator from this project’s directory (<code>orchestrator.register</code>).</div>`;
  }

  // Re-layout only when the tree shape/state actually changes (revision + a
  // signature over ids/states/armed) — a mere time tick must NOT relayout.
  const forest = buildForest(shownOrchestrators);
  const sig = JSON.stringify(forest.map((r) => [r.id, r.ui, r.children.map((c) => [c.id, c.ui, c.terminal])])) + '|' + [...armed].sort().join(',') + '|' + (data.revision ?? '') + '|' + project.id + '|' + (collapsingRetired ? 'c' : 'e');
  if (sig !== lastLayoutSig) {
    lastLayoutSig = sig;
    const pos = layoutForest(forest);
    lastPos = pos;
    let maxX = 0, maxY = 0;
    pos.forEach((pt) => { maxX = Math.max(maxX, pt.x + NODE_W); maxY = Math.max(maxY, pt.y + NODE_H); });
    canvasEls.scene.style.width = `${maxX}px`;
    canvasEls.scene.style.height = `${maxY}px`;
    canvasEls.edges.setAttribute('width', maxX);
    canvasEls.edges.setAttribute('height', maxY);
    canvasEls.edges.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
    canvasEls.edges.querySelector('path').setAttribute('d', edgesPath(forest, pos));
    // Nodes: replace only the node layer (keep the persistent <svg> edges child).
    canvasEls.scene.querySelectorAll('.ov-node').forEach((n) => n.remove());
    canvasEls.scene.insertAdjacentHTML('beforeend', forest.map((r) => {
      const walk = (n) => nodeCard(n, pos.get(n.id)) + n.children.map(walk).join('');
      return walk(r);
    }).join(''));
    if (fitPending) { fitPending = false; fitView(pos); }
    tickRuntimes();
  }
  applyViewport();
  if (openMenuId) positionMenu(); // the node may have moved — keep the menu anchored
}

// ================= Settings + Remote panels (ported verbatim from the old
// experimental render-home-panels.js — EXACT markup/classes, all defined in
// styles.css). Helpers below (pairingCodeBox, pairingCodeButton, copyUrlButton,
// tailscaleServeCommand) are inlined from that file. ================

// safeText/safeAttr map to esc (the old format.js helpers); a small relative
// time formatter replaces the old formatRelative.
const safeText = esc;
const safeAttr = esc;
function formatRelative(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const MIN = 60000, HR = 3600000, DAY = 86400000;
  const unit = (n, u) => `${n} ${u}${n === 1 ? '' : 's'}`;
  let s;
  if (abs < MIN) return 'just now';
  else if (abs < HR) s = unit(Math.round(abs / MIN), 'min');
  else if (abs < DAY) s = unit(Math.round(abs / HR), 'hour');
  else s = unit(Math.round(abs / DAY), 'day');
  return diff < 0 ? `${s} ago` : `in ${s}`;
}

// Module-level pairing + remote-fetch state (replaces old shell.lastPairing /
// shell.pairingAccepted / shell.authSessions).
let lastPairing = null;
let pairingAccepted = false;
let remoteAuthSessions = [];
let openDeviceCard = null; // which summary card's dropdown is open: 'serve' | 'https' | 'devices' | null
let remoteAccessCache = {}; // last /api/private-access response, for in-place re-paint on card toggle
let pairingCountdownTimer = null; // live mins:secs countdown on the pairing code

function localServeTarget() {
  const port = (typeof window !== 'undefined' && window.location.port) ? window.location.port : '3000';
  return `http://127.0.0.1:${port || '3000'}`;
}
function tailscaleServeCommand(mode = 'http') {
  const target = localServeTarget();
  if (mode === 'https') return `tailscale serve --bg --https=443 ${target}`;
  return `tailscale serve --bg ${target}`;
}
function pairingCodeButton(label, cls = 'secondary') {
  return `<button class="${cls}" data-action="createPairingCode" type="button">${safeText(label)}</button>`;
}
function copyUrlButton(url, label, cls = 'secondary') {
  return `<button class="${cls}" data-action="copyPhoneUrl" data-url="${safeAttr(url)}" type="button">${safeText(label)}</button>`;
}
function pairingCodeBox(placeholder) {
  if (pairingAccepted) {
    // Green "Device paired" confirmation — same size as the code card
    // (styles.css .pairing-code-box.pairing-accepted = green + centered, same padding).
    return `
            <div class="pairing-code-box pairing-accepted">
              <span class="pairing-accepted-check" aria-hidden="true">✓</span>
              <strong>Device paired</strong>
            </div>`;
  }
  if (lastPairing) {
    // Code on top-left (refresh / cancel to the right); "Code expires in M:SS" at
    // the bottom-left, filled in live by startPairingCountdown().
    return `
            <div class="pairing-code-box">
              <div class="pairing-code-top">
                <strong class="pairing-code-value">${safeText(lastPairing.code)}</strong>
                <span class="pairing-code-actions">
                  <button class="icon-btn" data-action="createPairingCode" type="button" title="New code" aria-label="New code">${icon('refresh', { size: 15 })}</button>
                  <button class="icon-btn" data-action="cancelPairing" type="button" title="Cancel" aria-label="Cancel">${icon('close', { size: 15 })}</button>
                </span>
              </div>
              <span class="pairing-countdown" data-expires="${safeAttr(lastPairing.expiresAt)}">Code expires in …</span>
            </div>`;
  }
  return `<div class="tiny muted">${safeText(placeholder)}</div>`;
}

// Appearance (light/dark) control — the Settings theme control.
function renderAppearancePanel() {
  const pref = themePref();
  const opt = (mode, label) => `<button class="seg-btn${pref === mode ? ' is-on' : ''}" data-action="setTheme" data-theme-mode="${mode}" type="button" aria-pressed="${pref === mode}">${label}</button>`;
  return `
      <article class="card control-card" data-panel-card="system">
        <h3>Appearance</h3>
        <p class="muted">Light or dark theme. "System" follows your device setting.</p>
        <div class="seg-control" role="group" aria-label="Appearance">
          ${opt('system', 'System')}${opt('light', 'Light')}${opt('dark', 'Dark')}
        </div>
      </article>`;
}

// Pair-devices card (old renderPairPanel).
function renderPairPanel(ctx) {
  const { phoneUrl, phoneQr, accessModeSummary, authSessionRows, tailnet = {} } = ctx;
  const tsReady = Boolean(tailnet.binaryAvailable && tailnet.loggedIn && phoneUrl && phoneUrl.startsWith('http'));
  const tailnetStatus = tailnet.loggedIn ? 'Signed in' : tailnet.binaryAvailable ? 'Sign in' : 'Install';
  const pairedCount = remoteAuthSessions.filter((s) => s && (s.paired || s.pairedFromId) && s.active !== false).length;

  // Left card dropdown → Tailscale sign-in + Serve on/off.
  let serveDetail;
  if (!tailnet.binaryAvailable) serveDetail = `<p class="tiny muted">Tailscale isn't installed on this Mac.</p><div class="lane-row"><a class="btn" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Install Tailscale</a><a class="btn-ghost" href="https://login.tailscale.com/start" target="_blank" rel="noopener noreferrer">Create account</a></div>`;
  else if (!tailnet.loggedIn) serveDetail = `<p class="tiny muted">Installed but not signed in.</p><div class="lane-row"><a class="btn" href="https://login.tailscale.com" target="_blank" rel="noopener noreferrer">Sign in to Tailscale</a></div>`;
  else if (!tailnet.serveConfigured) serveDetail = `<div class="serve-row"><p class="tiny muted">Signed in. Turn on Tailscale Serve (HTTP, tailnet-only) so other devices can open Orca.</p><button class="btn" data-action="setupTailscaleServe" type="button">Turn on Serve</button></div>`;
  else serveDetail = `<div class="serve-row"><p class="tiny muted">Serving on your tailnet. Signed-in devices can open the URL in step 1.</p><button class="btn-ghost" data-action="disableTailscaleServe" type="button">Turn off Serve</button></div>`;

  // Right card dropdown → paired devices.
  const devicesDetail = authSessionRows ? `<div class="device-list">${authSessionRows}</div>` : '<p class="tiny muted">No paired devices yet.</p>';

  const cardBtn = (card, value, label) => `<button class="device-card${openDeviceCard === card ? ' is-open' : ''}" data-action="toggleDeviceCard" data-card="${card}" type="button"><b>${safeText(value)}</b><span>${safeText(label)}</span>${icon('chevron-down', { cls: 'device-card-caret', size: 16 })}</button>`;

  const stepRow = (num, title, bodyHtml, action = '') => `
    <div class="step">
      <span class="step-num">${num}</span>
      <div class="step-main"><div class="step-title">${safeText(title)}</div>${bodyHtml}</div>
      ${action ? `<div class="step-action">${action}</div>` : ''}
    </div>`;
  const step1Body = tsReady
    ? `<div class="url-row"><code class="copy-url">${safeText(phoneUrl)}</code>${copyUrlButton(phoneUrl, 'Copy link', 'btn-ghost')}</div>
       <div class="tiny muted">Your private Tailscale URL. Open it from any device on your tailnet.</div>
       <div class="qr-wrap step-qr">${phoneQr}<span>Scan to open the URL</span></div>`
    : `<div class="tiny muted">Turn Tailscale on from the <b>${safeText(tailnetStatus)}</b> card above. A device URL appears here once it's serving.</div>`;

  const steps = `
    <div class="steps-card">
      ${stepRow(1, 'Open this URL on your remote device', step1Body)}
      ${tsReady ? stepRow(2, 'Create a one-time code', `<div class="tiny muted">Single-use and short-lived. Pairs a browser without exposing the API token.</div>${pairingCodeBox('Create a code, then enter it on your remote device.')}`, lastPairing || pairingAccepted ? '' : pairingCodeButton('Create code', 'btn')) : ''}
      ${tsReady ? stepRow(3, 'Enter the code on your remote device', '<div class="tiny muted">Open Orca there, type the code, and the device becomes paired.</div>') : ''}
      ${tsReady ? stepRow('+', 'Install as an app', '<div class="tiny muted">Optional. After pairing, add Orca to the Home Screen or Dock.</div>') : ''}
    </div>`;

  // HTTPS lives in the "Access mode" card dropdown (consistent with the others).
  const httpsServeCommand = tailscaleServeCommand('https');
  const httpsDetail = `
    <p class="tiny muted">Plain HTTP is enough for the dashboard and previews. Switching to HTTPS unlocks two browser features that only work on secure sites: installing Orca to your phone's Home Screen as an app, and push notifications. The tradeoff: issuing the certificate publishes your <code>.ts.net</code> hostname to public certificate-transparency logs.</p>
    <div class="ts-commands"><button class="btn-ghost" data-action="copyPrivateAccessCommand" data-command="${safeAttr(httpsServeCommand)}" type="button">Copy HTTPS command</button></div>`;
  const detailFor = { serve: serveDetail, https: httpsDetail, devices: devicesDetail };

  return `
      <article class="card control-card pair-panel" data-panel-card="access">
        <h3>Pair a device</h3>
        <div class="device-cards-wrap">
          <div class="device-cards">
            ${cardBtn('serve', tailnetStatus, 'Tailnet')}
            ${cardBtn('https', accessModeSummary, 'Access mode')}
            ${cardBtn('devices', `${pairedCount} device${pairedCount === 1 ? '' : 's'}`, 'Paired devices')}
          </div>
          ${openDeviceCard && detailFor[openDeviceCard] ? `<div class="device-detail">${detailFor[openDeviceCard]}</div>` : ''}
        </div>
        ${steps}
      </article>`;
}

// ---- settings screen ----
function renderSettings() {
  topbarTitle.textContent = 'Settings';
  // .home-panels flattens the .control-card into a borderless section (760px,
  // centered, hairline dividers) — the exact old settings layout. No Back button:
  // Settings is a top-level page reachable from the sidebar.
  content.innerHTML = `
    <div class="home-panels" data-active-panel="system">
      ${renderAppearancePanel()}
    </div>`;
}

// ---- remote devices screen ----
// Build the ctx from the live read-only APIs, then compose the exact old
// Pair-devices + Private-access panels.
function buildRemoteCtx(access) {
  const tailnet = access.tailnet || {};
  const privateSettings = access.settings || {};
  const accessModeSummary = privateSettings.preferredMode === 'tailnet-https-serve' ? 'Tailscale HTTPS' : 'Tailscale HTTP';
  const phoneUrl = tailnet.servedUrl || (tailnet.hostname ? `http://${tailnet.hostname}:${location.port || '3000'}/` : '');
  const phoneQr = phoneUrl ? qrSvgForText(phoneUrl) : '';
  const authSessionRows = remoteAuthSessions
    .filter((session) => session && (session.paired || session.pairedFromId) && session.active !== false)
    .map((session) => `
    <div class="provider-row device-row">
      <div class="device-row-info">
        <strong>${safeText(session.label || 'Paired device')}</strong>
        <div class="tiny muted">${session.active ? 'active' : 'inactive'} · paired ${safeText(formatRelative(session.createdAt))} · expires ${safeText(formatRelative(session.expiresAt))}</div>
        ${session.userAgent ? `<div class="tiny muted device-row-ua">${safeText(session.userAgent)}</div>` : ''}
      </div>
      <button class="device-revoke" data-action="revokePairing" data-id="${safeAttr(session.id)}" type="button" ${session.active ? '' : 'disabled'}>Revoke</button>
    </div>
  `).join('');
  return { tailnet, accessModeSummary, phoneUrl, phoneQr, authSessionRows };
}

async function fetchRemote() {
  let access = {};
  try { access = await (await fetch('/api/private-access', { headers: { accept: 'application/json' } })).json(); } catch { /* */ }
  try {
    const s = await (await fetch('/api/auth/sessions', { headers: { accept: 'application/json' } })).json();
    remoteAuthSessions = Array.isArray(s.sessions) ? s.sessions : [];
  } catch { remoteAuthSessions = []; }
  return access || {};
}

// Live "Expires in M:SS" countdown on the pairing code (ticks every second).
function startPairingCountdown() {
  if (pairingCountdownTimer) { clearInterval(pairingCountdownTimer); pairingCountdownTimer = null; }
  // No live code on screen → don't spin up an interval at all (keeps create/cancel
  // and constant refresh leak-free: at most one countdown timer ever exists).
  if (!content.querySelector('.pairing-countdown[data-expires]')) return;
  const tick = () => {
    const els = content.querySelectorAll('.pairing-countdown[data-expires]');
    if (!els.length) { clearInterval(pairingCountdownTimer); pairingCountdownTimer = null; return; }
    const now = Date.now();
    els.forEach((el) => {
      const remain = Math.max(0, Math.floor((Date.parse(el.dataset.expires) - now) / 1000));
      if (remain <= 0) { el.textContent = 'Code expired'; el.classList.add('expired'); return; }
      el.textContent = `Code expires in ${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}`;
    });
  };
  tick();
  pairingCountdownTimer = setInterval(tick, 1000);
}

function paintRemote(access) {
  remoteAccessCache = access || {};
  const bodyEl = document.getElementById('remote-body');
  if (!bodyEl) return;
  // On the workstation itself (loopback), Remote devices is the operator PAIR panel
  // (create codes, Tailscale, revoke devices). On a remote client (a phone/laptop
  // over the tailnet) those actions are admin-only and 401 — so a remote gets a
  // device panel instead: its own connection + unlink + switch workstation.
  if (isLoopbackHost()) {
    const ctx = buildRemoteCtx(remoteAccessCache);
    bodyEl.innerHTML = renderPairPanel(ctx);
    startPairingCountdown();
  } else {
    bodyEl.innerHTML = renderRemoteClient();
  }
}

// Remote-client "Remote devices" screen (phone / any browser away from the
// workstation): this device's connection + an unlink button. Each workstation is
// its own Tailscale URL, so "switching" is just opening a different link — no
// in-app switcher. No workstation admin actions here (they'd 401).
function renderRemoteClient() {
  const activeHost = window.location.host || 'this workstation';
  return `
    <section class="card control-card" data-panel-card="access">
      <h3>This device</h3>
      <p class="muted">Paired to <strong>${safeText(activeHost)}</strong> over Tailscale. To use a different workstation, open its Tailscale URL.</p>
      <div class="lane-row">
        <button class="btn" data-action="unlinkThisDevice" type="button">Unlink this device</button>
      </div>
    </section>`;
}

async function renderRemote() {
  topbarTitle.textContent = 'Remote devices';
  // .home-panels[data-active-panel=access] flattens the cards into the exact old
  // borderless sections (760px, centered, dividers) and shows only the access
  // panels. No Back button: Remote devices is a top-level sidebar page.
  content.innerHTML = `<div id="remote-body" class="home-panels" data-active-panel="access"><div class="ov-empty-sub" style="padding:var(--space-5)">Loading…</div></div>`;
  // A remote client doesn't need the admin /api/private-access fetch (it 401s);
  // paint immediately from local state. The workstation still fetches.
  if (isLoopbackHost()) {
    const access = await fetchRemote();
    paintRemote(access);
  } else {
    paintRemote({});
  }
}

// Re-fetch the read-only APIs and repaint the remote body in place (used after a
// mutating data-action succeeds).
async function refreshRemote() {
  const access = await fetchRemote();
  paintRemote(access);
}

// ---- theme ----
function themePref() { try { return localStorage.getItem('orca.theme') || 'system'; } catch { return 'system'; } }
function applyTheme(pref) {
  try { if (pref === 'system') localStorage.removeItem('orca.theme'); else localStorage.setItem('orca.theme', pref); } catch { /* */ }
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  content.querySelectorAll('.seg-btn[data-theme-mode]').forEach((b) => {
    const on = b.dataset.themeMode === pref;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

// When Appearance is "System", follow LIVE OS theme changes — the user flipping the
// phone to dark (or auto-dark at night) while the app is open. Without this the app
// only reads prefers-color-scheme once at load/apply and never updates.
if (window.matchMedia) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemThemeChange = () => { if (themePref() === 'system') applyTheme('system'); };
  if (systemDark.addEventListener) systemDark.addEventListener('change', onSystemThemeChange);
  else if (systemDark.addListener) systemDark.addListener(onSystemThemeChange); // older Safari
}

// Brief "Copied" affordance on a copy button.
async function copyToClipboard(text, btn) {
  try { await navigator.clipboard.writeText(text || ''); } catch { /* */ }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { if (btn.isConnected) btn.textContent = prev; }, 1200);
  }
}

// ---- remote-device pairing GATE ----
// What an unpaired device (a phone that opened the tailnet URL) sees INSTEAD of
// the dashboard: the workstation 401s all data until the device is paired, so the
// gate is the only way in. Ported from experimental render-shell.js
// (renderMobilePairGate) — same connect-* markup, all classes already in
// styles.css. Tauri/multi-workstation bits dropped (v2 is web-only, one origin).
// The device that loaded this URL is already "connected" (step 1 done); it just
// needs the one-time code the operator creates under Remote devices.
function renderPairGate(errorText = '') {
  const host = (typeof window !== 'undefined' ? window.location.host : '');
  const defaultLabel = isMobile() ? 'Phone browser' : 'Browser';
  return `
    <section class="connect-shell connect-gate">
      <div class="connect-brand">
        <img class="connect-logo" src="/orca-mark.png" alt="" width="40" height="40" />
        <span class="connect-wordmark">Orca</span>
      </div>
      <h1 class="connect-title">Pair this device</h1>
      <p class="connect-sub">You're connected to your workstation over Tailscale. Enter the one-time pairing code to finish.</p>
      <ol class="connect-steps">
        <li class="connect-step is-done">
          <span class="connect-step-mark" aria-hidden="true">✓</span>
          <div class="connect-step-body">
            <strong>Connected to workstation</strong>
            <span class="connect-step-host">${safeText(host)}</span>
          </div>
        </li>
        <li class="connect-step is-active">
          <span class="connect-step-mark" aria-hidden="true">2</span>
          <div class="connect-step-body">
            <strong>Enter the pairing code</strong>
            <span class="connect-step-hint">On your Mac: Orca → Remote devices → Create a one-time code.</span>
          </div>
        </li>
      </ol>
      <div class="connect-card">
        <label class="connect-label" for="pairing-code-input">Pairing code</label>
        <input id="pairing-code-input" class="connect-input" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX" />
        <label class="connect-label" for="pairing-label-input">Device label</label>
        <input id="pairing-label-input" class="connect-input" value="${safeAttr(defaultLabel)}" />
        <button class="connect-go" data-action="pairBrowserSession" type="button">Pair device</button>
        ${errorText ? `<div class="connect-error tiny" role="alert">${safeText(errorText)}</div>` : ''}
      </div>
    </section>`;
}

// Server-down / reconnecting takeover, rendered in the current design (never a
// legacy shell). The poll loop keeps running, so this clears itself the moment
// the daemon answers; the button just forces an immediate retry.
function renderOffline() {
  const onWorkstation = isLoopbackHost();
  return `
    <section class="connect-shell connect-offline">
      <div class="connect-brand">
        <img class="connect-logo" src="/orca-mark.png" alt="" width="40" height="40" />
        <span class="connect-wordmark">Orca</span>
      </div>
      <div class="app-loading" role="status" aria-label="Reconnecting to Orca">
        <span class="app-loading-spinner" aria-hidden="true"></span>
      </div>
      <h1 class="connect-title">${onWorkstation ? 'Start Orca' : 'Waiting for your workstation'}</h1>
      <p class="connect-sub">${onWorkstation
        ? 'The Orca daemon isn’t responding. Start it on this machine and the dashboard reconnects automatically.'
        : 'Your workstation’s Orca isn’t responding right now. This reconnects automatically once it’s back.'}</p>
      <div class="connect-card">
        ${onWorkstation ? '<code class="connect-cmd">PORT=3000 node src/server.js</code>' : ''}
        <button class="connect-go" data-action="retryConnect" type="button">Retry now</button>
      </div>
    </section>`;
}

// ---- render dispatch ----
function renderScreen() {
  content.removeAttribute('aria-busy');
  // Leaving Home (or a full-screen takeover): drop the wide-canvas layout + the
  // runtime ticker; renderHome re-establishes both when it rebuilds the canvas.
  body.classList.remove('home-canvas');
  stopRuntimeTicker();
  // Daemon unreachable: full-screen reconnect takeover (chrome hidden via body
  // class), takes precedence over everything else.
  body.classList.toggle('app-offline', offline && !accessBlocked);
  if (offline && !accessBlocked) { topbarTitle.textContent = ''; content.innerHTML = renderOffline(); return; }
  // Unpaired remote: full-screen gate takeover (chrome hidden via body class), no
  // sidebar/topbar — there's nothing to navigate to until this device pairs.
  body.classList.toggle('access-gated', accessBlocked);
  if (accessBlocked) { topbarTitle.textContent = ''; content.innerHTML = renderPairGate(); return; }
  renderSidebar(lastData);
  const r = route();
  if (r === 'settings') renderSettings();
  else if (r === 'remote') renderRemote();
  else renderHome(lastData);
}

async function poll() {
  try {
    const res = await fetch('/api/overview', { headers: { accept: 'application/json' } });
    // Any HTTP response (even a 401) proves the daemon is up — leave the offline
    // reconnect screen if we were on it.
    sawFirstResponse = true;
    if (offline) { offline = false; renderScreen(); }
    if (res.status === 401) {
      // Unpaired remote device. Render the gate ONCE on the transition into the
      // blocked state so the 2s poll never clobbers a half-typed code (the
      // "opens then wipes" ephemeral-state bug class). It clears when the pair
      // handler sets the cookie and the next poll gets a 200.
      if (!accessBlocked) { accessBlocked = true; renderScreen(); }
      renderFenceBanner(null);
      return;
    }
    if (!res.ok) return;
    lastData = await res.json();
    renderFenceBanner(lastData.fence);
    if (accessBlocked) { accessBlocked = false; renderScreen(); } // just got paired → leave the gate
    renderSidebar(lastData);
    if (route() === 'home') renderHome(lastData); // only the tree auto-refreshes
  } catch {
    // Daemon unreachable (network error, not an HTTP status). Take over with the
    // reconnect "Start Orca" screen ONCE on transition, so a hard reload with the
    // server down never falls through to a cached/legacy shell.
    if (!offline) { offline = true; renderScreen(); }
    renderFenceBanner(null);
    return;
  }
  // On the Remote screen, watch paired sessions so a code being accepted flips
  // the card to green instantly and the device count updates (see auth audit).
  if (!accessBlocked && route() === 'remote') {
    const before = remoteAuthSessions.length;
    try {
      const s = await (await fetch('/api/auth/sessions', { headers: { accept: 'application/json' } })).json();
      remoteAuthSessions = Array.isArray(s.sessions) ? s.sessions : remoteAuthSessions;
    } catch { /* */ }
    const acceptedNow = lastPairing && !pairingAccepted
      && remoteAuthSessions.some((x) => x && x.pairedFromId === lastPairing.id && x.active !== false);
    if (acceptedNow) {
      // Flip the code card to the green "Device paired" state, then auto-collapse
      // it after 2s (back to the "Create code" button). Guard on the accepted id
      // so a code created during the window isn't cleared.
      pairingAccepted = true;
      const acceptedId = lastPairing.id;
      setTimeout(() => {
        if (pairingAccepted && lastPairing && lastPairing.id === acceptedId) {
          pairingAccepted = false;
          lastPairing = null;
          if (route() === 'remote') paintRemote(remoteAccessCache);
        }
      }, 2000);
    }
    if (acceptedNow || remoteAuthSessions.length !== before) paintRemote(remoteAccessCache);
  }
}

// ---- interactions ----
sideProjects.addEventListener('click', (e) => {
  const btn = e.target.closest('.sidebar-project');
  if (!btn) return;
  selectedProjectId = btn.dataset.pid || null;
  rememberProjectId(selectedProjectId);
  showRetired = null; projectsOpen = false; fitPending = true;
  closeMobileNav();
  if (route() !== 'home') location.hash = ''; else renderScreen();
});
document.getElementById('sidebar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-nav]');
  if (btn) { closeMobileNav(); location.hash = btn.dataset.nav; }
});
// Show a small inline note when a mutating action fails / hits an endpoint that
// rejects the read-only phone (e.g. admin-only 401), rather than crashing.
function remoteNote(text) {
  const bodyEl = document.getElementById('remote-body');
  if (!bodyEl) return;
  let note = bodyEl.querySelector('.remote-inline-note');
  if (!note) {
    note = document.createElement('div');
    note.className = 'tiny muted remote-inline-note';
    bodyEl.prepend(note);
  }
  note.textContent = text;
}

content.addEventListener('click', async (e) => {
  // ---- Settings / Remote data-action handlers ----
  const act = e.target.closest('[data-action]');
  if (act) {
    const action = act.dataset.action;
    if (action === 'setTheme') { applyTheme(act.dataset.themeMode); return; }
    if (action === 'retryConnect') { e.preventDefault(); poll(); return; }
    if (action === 'pairBrowserSession') {
      // Remote-device gate: submit the one-time code. No auth needed — the whole
      // point is to let an UNpaired device pair itself (server sets the cookie).
      e.preventDefault(); act.disabled = true;
      const code = (document.getElementById('pairing-code-input')?.value || '').trim();
      const label = (document.getElementById('pairing-label-input')?.value || '').trim() || 'Paired device';
      if (!code) { content.innerHTML = renderPairGate('Enter the pairing code from your workstation.'); return; }
      try {
        const res = await fetch('/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', code, label }) });
        if (res.ok) { accessBlocked = false; await poll(); renderScreen(); } // cookie set → 200 → dashboard
        else { const d = await res.json().catch(() => ({})); content.innerHTML = renderPairGate(d.error || 'Could not pair. Create a new code and try again.'); }
      } catch { content.innerHTML = renderPairGate('Could not reach Orca. Check your Tailscale connection and try again.'); }
      return;
    }
    if (action === 'toggleDeviceCard') {
      openDeviceCard = openDeviceCard === act.dataset.card ? null : act.dataset.card;
      paintRemote(remoteAccessCache);
      return;
    }
    if (action === 'copyPhoneUrl') { e.preventDefault(); copyToClipboard(act.dataset.url, act); return; }
    if (action === 'copyPrivateAccessCommand') { e.preventDefault(); copyToClipboard(act.dataset.command, act); return; }
    if (action === 'createPairingCode') {
      e.preventDefault(); act.disabled = true;
      try {
        const res = await fetch('/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', label: 'Phone/browser pairing' }) });
        const data = await res.json();
        const pairing = data.pairing || data;
        if (pairing && pairing.code) { lastPairing = { id: pairing.id, code: pairing.code, expiresAt: pairing.expiresAt }; pairingAccepted = false; await refreshRemote(); }
        else remoteNote(`Could not create a pairing code (${esc(data.error || res.status)}).`);
      } catch { remoteNote('Could not reach Orca to create a pairing code.'); }
      act.disabled = false;
      return;
    }
    if (action === 'cancelPairing') {
      e.preventDefault();
      lastPairing = null; pairingAccepted = false;
      paintRemote(remoteAccessCache);
      return;
    }
    if (action === 'setupTailscaleServe' || action === 'disableTailscaleServe') {
      e.preventDefault(); act.disabled = true;
      const enable = action === 'setupTailscaleServe';
      try {
        const res = await fetch('/api/private-access/serve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: enable ? 'enable' : 'disable', port: Number(location.port) || 3000, actor: 'dashboard' }) });
        if (!res.ok) { const d = await res.json().catch(() => ({})); remoteNote(`Could not ${enable ? 'enable' : 'disable'} Serve (${esc(d.error || res.status)}).`); }
        await refreshRemote();
      } catch { remoteNote('Could not reach Orca to configure Tailscale Serve.'); act.disabled = false; }
      return;
    }
    if (action === 'revokePairing') {
      e.preventDefault(); act.disabled = true;
      const id = act.dataset.id;
      try {
        const res = await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, actor: 'dashboard' }) });
        if (!res.ok) { const d = await res.json().catch(() => ({})); remoteNote(`Could not revoke device (${esc(d.error || res.status)}).`); act.disabled = false; }
        else await refreshRemote();
      } catch { remoteNote('Could not reach Orca to revoke the device.'); act.disabled = false; }
      return;
    }
    if (action === 'unlinkThisDevice') {
      // Self-unlink from a remote client: own-cookie logout (NO sessionId, so it
      // doesn't hit the admin gate). Clears the cookie → next poll 401s → pair gate.
      e.preventDefault(); act.disabled = true;
      try {
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard' }) });
      } catch { /* best effort */ }
      location.hash = '';
      await poll();
      renderScreen();
      return;
    }
    return;
  }

  // ---- canvas controls (zoom / fit / fullscreen / live links) ----
  const ctrl = e.target.closest('[data-canvas]');
  if (ctrl) {
    e.preventDefault();
    const k = ctrl.dataset.canvas;
    const canvas = canvasEls && canvasEls.canvas;
    if (k === 'zoom-in' || k === 'zoom-out') { closeNodeMenu(); const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, k === 'zoom-in' ? 1.15 : 1 / 1.15); }
    else if (k === 'fit') { closeNodeMenu(); if (lastPos) fitView(lastPos); }
    else if (k === 'fullscreen') { const el = canvasEls && canvasEls.workspace; if (document.fullscreenElement) document.exitFullscreen(); else if (el && el.requestFullscreen) el.requestFullscreen(); }
    else if (k === 'links') { linksOpen = !linksOpen; if (canvasEls) canvasEls.links.hidden = !linksOpen; ctrl.classList.toggle('is-on', linksOpen); }
    // Switching project and expanding retired work are the two scope controls.
    // Both re-render Home rather than patching, because both change the tree.
    else if (k === 'projects') { projectsOpen = !projectsOpen; if (canvasEls) canvasEls.projects.hidden = !projectsOpen; ctrl.setAttribute('aria-expanded', projectsOpen ? 'true' : 'false'); }
    else if (k === 'retired') { closeNodeMenu(); showRetired = collapsingRetired; fitPending = true; renderHome(lastData); }
    return;
  }

  // ---- project switcher: an explicit, listed choice; remembered per browser --
  const pick = e.target.closest('[data-pick-project]');
  if (pick) {
    e.preventDefault();
    selectedProjectId = pick.dataset.pickProject;
    rememberProjectId(selectedProjectId);
    projectsOpen = false; showRetired = null; fitPending = true;
    closeNodeMenu();
    renderSidebar(lastData);
    renderHome(lastData);
    return;
  }

  // ---- ⋯ node menu: toggle the per-node action menu (gates the Stop actions) ----
  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) {
    e.preventDefault();
    const id = menuBtn.dataset.menu;
    if (openMenuId === id) { closeNodeMenu(); return; }
    const node = menuBtn.closest('.ov-node');
    openNodeMenu(id, node ? node.dataset.kind : 'executor');
    return;
  }

  // ---- ⋯ menu actions (the menu is the deliberate gate → fire directly):
  //   stop one executor · stop the agents an orchestrator runs · close (resign) an agent.
  const stopAct = e.target.closest('[data-stop-lane], [data-stop-orch], [data-resign-orch]');
  if (stopAct) {
    e.preventDefault();
    const laneId = stopAct.dataset.stopLane;
    const stopOrch = stopAct.dataset.stopOrch;
    const resignOrch = stopAct.dataset.resignOrch;
    if (!laneId && !stopOrch && !resignOrch) return;
    stopAct.disabled = true;
    closeNodeMenu();
    try {
      if (laneId) await fetch('/api/emergency-stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ laneId }) });
      else if (stopOrch) await fetch(`/api/orchestrators/${encodeURIComponent(stopOrch)}/emergency-stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', approved: true }) });
      else await fetch(`/api/orchestrators/${encodeURIComponent(resignOrch)}/resign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'dashboard', reason: 'closed from dashboard' }) });
    } catch { /* */ }
    poll();
  }
});

window.addEventListener('hashchange', renderScreen);
poll().then(renderScreen);
setInterval(poll, 2000);
