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
  // Nav active state (Remote devices pair-button + Settings footer row)
  document.querySelectorAll('#sidebar [data-nav]').forEach((b) => b.classList.toggle('is-selected', b.dataset.nav === r));
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
      <div class="ov-empty-sub">Register an orchestrator from your CLI (<code>orchestrator.register</code>).</div>
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

// ================= Settings + Remote panels (ported verbatim from the old
// experimental render-home-panels.js — EXACT markup/classes, all defined in
// styles.css). Helpers below (settingsSummaryGrid, settingsActionRows,
// settingsCallout, pairedDevicesDisclosure, pairingCodeBox, pairingCodeButton,
// copyUrlButton, tailscaleServeCommand) are inlined from that file. ================

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
let openDeviceCard = null; // which summary card's dropdown is open: 'serve' | 'devices' | null
let remoteAccessCache = {}; // last /api/private-access response, for in-place re-paint on card toggle

const selectedOpt = (actual, expected) => String(actual || '') === String(expected || '') ? 'selected' : '';
function localServeTarget() {
  const port = (typeof window !== 'undefined' && window.location.port) ? window.location.port : '3000';
  return `http://127.0.0.1:${port || '3000'}`;
}
function tailscaleServeCommand(mode = 'http') {
  const target = localServeTarget();
  if (mode === 'https') return `tailscale serve --bg --https=443 ${target}`;
  return `tailscale serve --bg ${target}`;
}
function pairedDeviceCount() {
  if (!Array.isArray(remoteAuthSessions)) return null;
  return remoteAuthSessions.filter((s) => s && (s.paired || s.pairedFromId) && s.active !== false).length;
}
function pairedDeviceSummary(unit = 'device') {
  const n = pairedDeviceCount() ?? 0;
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
function pairingCodeButton(label, cls = 'secondary') {
  return `<button class="${cls}" data-action="createPairingCode" type="button">${safeText(label)}</button>`;
}
function copyUrlButton(url, label, cls = 'secondary') {
  return `<button class="${cls}" data-action="copyPhoneUrl" data-url="${safeAttr(url)}" type="button">${safeText(label)}</button>`;
}
function settingsSummaryGrid(items = []) {
  const rows = items
    .filter((item) => item && item.label)
    .map((item) => `
      <div class="settings-summary-item">
        <strong>${safeText(item.value ?? '')}</strong>
        <span>${safeText(item.label)}</span>
      </div>
    `).join('');
  return rows ? `<div class="settings-summary-grid">${rows}</div>` : '';
}
function settingsActionRows(rows = []) {
  const html = rows
    .filter((row) => row && row.title)
    .map((row) => `
      <div class="settings-action-row">
        <div class="settings-action-main">
          ${row.kicker ? `<span class="settings-row-kicker">${safeText(row.kicker)}</span>` : ''}
          <strong>${safeText(row.title)}</strong>
          ${row.detail ? `<span class="tiny muted">${safeText(row.detail)}</span>` : ''}
          ${row.content || ''}
        </div>
        ${row.actions ? `<div class="settings-action-controls">${row.actions}</div>` : ''}
      </div>
    `).join('');
  return html ? `<div class="settings-action-list">${html}</div>` : '';
}
function settingsCallout(title, detail, actions = '') {
  return `
    <div class="settings-callout">
      <div>
        <strong>${safeText(title)}</strong>
        ${detail ? `<span class="tiny muted">${safeText(detail)}</span>` : ''}
      </div>
      ${actions ? `<div class="lane-row">${actions}</div>` : ''}
    </div>`;
}
function pairedDevicesDisclosure({ uikey, summary, rows, emptyText, bodyPrefix = '' }) {
  return `
        <details class="disclosure compact-disclosure" data-uikey="${uikey}">
          <summary><span>Paired devices</span><small>${safeText(summary)}</small></summary>
          <div class="disclosure-body">${bodyPrefix}${rows || `<div class="muted">${safeText(emptyText)}</div>`}</div>
        </details>`;
}
function pairingCodeBox(placeholder) {
  if (pairingAccepted) {
    return `
            <div class="pairing-code-box pairing-accepted">
              <span class="pairing-accepted-check" aria-hidden="true">✓</span>
              <strong>Device paired</strong>
              <span class="tiny muted">The code was accepted and is now used up. Create a new one to pair another device.</span>
            </div>`;
  }
  if (lastPairing) {
    return `
            <div class="pairing-code-box">
              <div class="tiny muted">One-time pairing code. Do not screenshot or paste into URLs.</div>
              <strong class="pairing-code-value">${safeText(lastPairing.code)}</strong>
              <span class="pairing-countdown" data-expires="${safeAttr(lastPairing.expiresAt)}">Expires ${safeText(formatRelative(lastPairing.expiresAt))}</span>
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
  else if (!tailnet.serveConfigured) serveDetail = `<p class="tiny muted">Signed in. Turn on Tailscale Serve (HTTP, tailnet-only) so other devices can open Orca.</p><div class="lane-row"><button class="btn" data-action="setupTailscaleServe" type="button">Turn on Serve</button></div>`;
  else serveDetail = `<p class="tiny muted">Serving on your tailnet — signed-in devices can open the URL in step 1.</p><div class="lane-row"><button class="btn-ghost" data-action="disableTailscaleServe" type="button">Turn off Serve</button></div>`;

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
       <div class="tiny muted">Your private Tailscale URL — open it from any device on your tailnet.</div>
       <div class="qr-wrap step-qr">${phoneQr}<span>Scan to open Orca on your phone</span></div>`
    : `<div class="tiny muted">Turn Tailscale on from the <b>${safeText(tailnetStatus)}</b> card above — a device URL appears here once it's serving.</div>`;

  const steps = `
    <div class="steps-card">
      ${stepRow(1, 'Open this URL on the other device', step1Body)}
      ${tsReady ? stepRow(2, 'Create a one-time code', `<div class="tiny muted">Single-use and short-lived — pairs a browser without exposing the API token.</div>${pairingCodeBox('Create a code, then enter it on the other device.')}`, pairingCodeButton(lastPairing ? 'New code' : 'Create code', 'btn')) : ''}
      ${tsReady ? stepRow(3, 'Finish on the other device', '<div class="tiny muted">Open Orca there, enter the code, and it becomes paired.</div>') : ''}
      ${tsReady ? stepRow('+', 'Install as an app', '<div class="tiny muted">Optional — after pairing, add Orca to the Home Screen or Dock.</div>') : ''}
    </div>`;

  return `
      <article class="card control-card pair-panel" data-panel-card="access">
        <h3>Pair a device</h3>
        <div class="device-cards">
          ${cardBtn('serve', tailnetStatus, 'Tailnet')}
          <div class="device-card static"><b>${safeText(accessModeSummary)}</b><span>Access mode</span></div>
          ${cardBtn('devices', `${pairedCount} device${pairedCount === 1 ? '' : 's'}`, 'Paired devices')}
        </div>
        ${openDeviceCard === 'serve' ? `<div class="device-detail">${serveDetail}</div>` : ''}
        ${openDeviceCard === 'devices' ? `<div class="device-detail">${devicesDetail}</div>` : ''}
        ${steps}
      </article>`;
}

// HTTPS-optional info block (serve on/off lives in the Pair "Tailnet" card).
function renderPrivateAccessPanel() {
  const httpsServeCommand = tailscaleServeCommand('https');
  return `
      <article class="card control-card" data-panel-card="access">
        <div class="ts-subhead">HTTPS <span class="tiny muted">optional</span></div>
        <p class="tiny muted">HTTP over the tailnet is enough for the dashboard and previews. HTTPS adds secure-context browser features (installing the PWA, web push) — but issuing a certificate publishes the <code>.ts.net</code> hostname to public certificate-transparency logs.</p>
        <div class="ts-commands">
          <button class="btn-ghost" data-action="copyPrivateAccessCommand" data-command="${safeAttr(httpsServeCommand)}" type="button">Copy HTTPS command</button>
        </div>
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
  const privateTargets = Array.isArray(access.targets) ? access.targets : [];
  const httpsSelected = privateSettings.preferredMode === 'tailnet-https-serve';
  const accessModeSummary = httpsSelected ? 'Tailscale HTTPS' : 'Tailscale HTTP';
  const accessModeOptions = `
    <option value="tailnet-http" ${httpsSelected ? '' : 'selected'}>HTTP — recommended</option>
    <option value="tailnet-https-serve" ${httpsSelected ? 'selected' : ''}>HTTPS</option>
  `;
  const phoneUrl = tailnet.servedUrl || (tailnet.hostname ? `http://${tailnet.hostname}:${location.port || '3000'}/` : '');
  // v2 has no orca:// deep link — reuse the same tailnet-URL QR for both slots.
  const phoneQr = phoneUrl ? qrSvgForText(phoneUrl) : '';
  const phoneDeepLinkQr = phoneQr;
  const setupCommands = Array.isArray(access.setupPlan?.commands) ? access.setupPlan.commands : [];
  const commandRows = setupCommands.map((item) => `
    <div class="access-command">
      <div>
        <strong>${safeText(item.label)}</strong>
        <div class="tiny muted">${safeText(item.note || '')}</div>
        <code>${safeText(item.copyText || 'No command needed')}</code>
      </div>
      <button class="secondary" data-action="copyPrivateAccessCommand" data-command="${safeAttr(item.copyText || '')}" type="button">Copy</button>
    </div>
  `).join('');
  const targetUrlForMode = (t) => (t.mode === 'tailnet-https-serve' ? t.httpsServeUrl : t.mode === 'tailnet-http' ? t.tailnetHttpUrl : t.localUrl)
    || t.localUrl || t.tailnetHttpUrl || t.httpsServeUrl || '';
  const targetRows = privateTargets.map((target) => {
    const targetUrl = targetUrlForMode(target);
    return `
      <div class="access-target">
        <div>
          <strong>${safeText(target.label)}</strong>
          <div class="tiny muted">${safeText(target.mode)} · ${safeText(target.healthStatus || 'configured_unchecked')} · ${safeText(targetUrl)}</div>
          ${target.lastHealthDetail ? `<div class="tiny muted">${safeText(target.lastHealthDetail)}</div>` : ''}
        </div>
        <div class="lane-row">
          ${targetUrl && /^https?:\/\//i.test(targetUrl) ? `<a class="secondary" href="${safeAttr(targetUrl)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}
          <button class="secondary" data-action="checkPrivateAccessTarget" data-target-id="${safeAttr(target.id)}" type="button">Check</button>
          <button class="secondary" data-action="deletePrivateAccessTarget" data-target-id="${safeAttr(target.id)}" type="button">Remove</button>
        </div>
      </div>
    `;
  }).join('');
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
  return {
    tailnet, privateSettings, privateTargets, accessModeSummary, accessModeOptions,
    phoneUrl, phoneQr, phoneDeepLinkQr, commandRows, targetRows, authSessionRows,
  };
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

function paintRemote(access) {
  remoteAccessCache = access || {};
  const bodyEl = document.getElementById('remote-body');
  if (!bodyEl) return;
  const ctx = buildRemoteCtx(remoteAccessCache);
  bodyEl.innerHTML = `${renderPairPanel(ctx)}${renderPrivateAccessPanel()}`;
}

async function renderRemote() {
  topbarTitle.textContent = 'Remote devices';
  // .home-panels[data-active-panel=access] flattens the cards into the exact old
  // borderless sections (760px, centered, dividers) and shows only the access
  // panels. No Back button: Remote devices is a top-level sidebar page.
  content.innerHTML = `<div id="remote-body" class="home-panels" data-active-panel="access"><div class="ov-empty-sub" style="padding:var(--space-5)">Loading…</div></div>`;
  const access = await fetchRemote();
  paintRemote(access);
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

// Brief "Copied" affordance on a copy button.
async function copyToClipboard(text, btn) {
  try { await navigator.clipboard.writeText(text || ''); } catch { /* */ }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { if (btn.isConnected) btn.textContent = prev; }, 1200);
  }
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
document.getElementById('sidebar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-nav]');
  if (btn) location.hash = btn.dataset.nav;
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
  if (e.target.closest('[data-back]')) { location.hash = ''; return; }
  const opt = e.target.closest('.seg-opt');
  if (opt) { applyTheme(opt.dataset.theme); return; }

  // ---- Settings / Remote data-action handlers ----
  const act = e.target.closest('[data-action]');
  if (act) {
    const action = act.dataset.action;
    if (action === 'setTheme') { applyTheme(act.dataset.themeMode); return; }
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
        if (pairing && pairing.code) { lastPairing = { code: pairing.code, expiresAt: pairing.expiresAt }; pairingAccepted = false; await refreshRemote(); }
        else remoteNote(`Could not create a pairing code (${esc(data.error || res.status)}).`);
      } catch { remoteNote('Could not reach Orca to create a pairing code.'); }
      act.disabled = false;
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
    return;
  }

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
