// Home-view panel renderers, split out of render-home.js so that file stays a
// thin data-prep + composition layer. Each function takes the prepared `ctx`
// (built once in renderHome) and returns the exact HTML for one panel/section.

import { safeAttr, safeText, formatRelative } from './format.js';
import { browserNotificationsSupported } from './notifications.js';
import { MCP_TOOL_SCOPE_ALLOWLIST } from './constants.js';
import { shell } from './state.js';
import { getThemePref } from './theme.js';
import { readWorkstations, activeWorkstationUrl, isActiveWorkstation, workstationLabel } from './workstations.js';

// Shared list of known workstations, newest first. The one this device is
// currently connected to (its own origin) is marked with a green check + the
// "Connected" tag; the others are one-tap switch targets, each with a Forget (×).
// Used by the connect screen, the pair-gate switcher, and remote Settings so the
// behavior is identical everywhere. Returns '' when there are no known stations.
export function renderWorkstationList({ heading = '' } = {}) {
  const recents = readWorkstations();
  if (!recents.length) return '';
  const rows = recents.map((url) => {
    const active = isActiveWorkstation(url);
    return `
      <div class="ws-row${active ? ' is-active' : ''}">
        <button class="ws-pick" data-action="connectWorkstation" data-url="${safeAttr(url)}" type="button">
          <span class="ws-check" aria-hidden="true">${active ? '✓' : ''}</span>
          <span class="ws-host">${safeText(workstationLabel(url))}</span>
          ${active ? '<span class="ws-tag">Connected</span>' : '<span class="ws-go-hint">Switch</span>'}
        </button>
        <button class="ws-forget" data-action="forgetWorkstation" data-url="${safeAttr(url)}" type="button" aria-label="Forget ${safeAttr(workstationLabel(url))}" title="Forget">×</button>
      </div>`;
  }).join('');
  return `
    <div class="ws-switcher">
      ${heading ? `<div class="ws-switcher-head">${safeText(heading)}</div>` : ''}
      <div class="ws-list">${rows}</div>
    </div>`;
}

// Settings panel for CONNECTED REMOTE devices (phone/laptop on the tailnet) to
// switch or add a workstation without closing the app. The workstation itself is
// local, so this panel is remote-only (composed behind !onWorkstation in render-home).
export function renderRemoteConnectionPanel() {
  const active = activeWorkstationUrl();
  const activeHost = active
    ? workstationLabel(active)
    : (typeof window !== 'undefined' ? window.location.host : '');
  return `
      <article class="card control-card" data-panel-card="system" data-panel-key="connection">
        <h3>Workstation</h3>
        <p class="muted">Connected to <strong>${safeText(activeHost)}</strong>. Switch to another saved workstation or add a new one — no need to close the app.</p>
        ${renderWorkstationList({ heading: 'Your workstations' })}
        <label class="connect-label" for="workstation-url-input">Connect to a different workstation</label>
        <input id="workstation-url-input" class="connect-input" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="your-mac.your-tailnet.ts.net" />
        <button class="secondary" data-action="connectWorkstation" type="button">Connect</button>
      </article>`;
}

// Appearance (light/dark) control — per-device, shown on every device in Settings.
export function renderAppearancePanel() {
  const pref = getThemePref();
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

const selected = (actual, expected) => String(actual || '') === String(expected || '') ? 'selected' : '';
const checked = (value) => value ? 'checked' : '';
function localServeTarget() {
  const port = (typeof window !== 'undefined' && window.location.port) ? window.location.port : '3000';
  return `http://127.0.0.1:${port || '3000'}`;
}

function tailscaleServeCommand(mode = 'http') {
  const target = localServeTarget();
  if (mode === 'https') return `tailscale serve --bg --https=443 ${target}`;
  return `tailscale serve --bg ${target}`;
}

// Count of REAL paired remote devices (workstation token-bootstrap sessions are
// not devices). Returns null while the session list is still loading so callers
// can show a "…" placeholder instead of flashing a misleading "0".
function pairedDeviceCount() {
  if (!Array.isArray(shell.authSessions)) return null;
  return shell.authSessions.filter((s) => s && (s.paired || s.pairedFromId) && s.active !== false).length;
}
// Summary label for the "Paired devices" disclosure: a pluralized "N <unit>".
// A not-yet-loaded list counts as 0 (never a placeholder glyph — "0 devices" is
// the honest answer, and the real count fills in on the next poll).
function pairedDeviceSummary(unit = 'device') {
  const n = pairedDeviceCount() ?? 0;
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

// The "Paired devices" disclosure — one definition shared by every pairing
// surface (pair panel, token panel, access panel) so the structure/styling lives
// in one place. Callers vary only the uikey, summary, empty text, and an optional
// body prefix note.
// Pairing-code + copy-URL buttons recur across the setup panels with only the
// button class and label varying — one definition each keeps the data-action and
// markup in a single place.
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

// The pairing-code display: a live one-time code, OR a transient "Accepted"
// confirmation once a device consumes it (so the workstation sees it land), OR a
// placeholder prompt. Shared by every pairing surface so the behavior is uniform.
function pairingCodeBox(placeholder) {
  if (shell.pairingAccepted) {
    return `
            <div class="pairing-code-box pairing-accepted">
              <span class="pairing-accepted-check" aria-hidden="true">✓</span>
              <strong>Device paired</strong>
              <span class="tiny muted">The code was accepted and is now used up. Create a new one to pair another device.</span>
            </div>`;
  }
  if (shell.lastPairing) {
    return `
            <div class="pairing-code-box">
              <div class="tiny muted">One-time pairing code. Do not screenshot or paste into URLs.</div>
              <strong class="pairing-code-value">${safeText(shell.lastPairing.code)}</strong>
              <span class="pairing-countdown" data-expires="${safeAttr(shell.lastPairing.expiresAt)}">Expires ${safeText(formatRelative(shell.lastPairing.expiresAt))}</span>
            </div>`;
  }
  return `<div class="tiny muted">${safeText(placeholder)}</div>`;
}

export function renderSimpleSection(ctx) {
  const { showMainHome } = ctx;
  const hasProjects = (shell.projects || []).length > 0;
  return `
    <section class="home-welcome ${showMainHome ? '' : 'is-hidden'}">
      <div class="home-hero">
        <img class="home-hero-logo" src="/orca-mark.png" alt="" width="56" height="56" />
        <h1 class="home-hero-title">Welcome to Orca</h1>
        <p class="home-hero-sub">${hasProjects ? 'Open a project from the sidebar, or start a new one.' : 'Orchestrate your coding agents from one place. Create a project to get started.'}</p>
        <div class="home-hero-actions">
          <button class="home-cta" data-action="newProject" type="button">
            <span aria-hidden="true">+</span>
            <span>New project</span>
          </button>
        </div>
      </div>
    </section>`;
}

export function renderPairPanel(ctx) {
  const { phoneUrl, phoneQr, phoneDeepLinkQr, accessModeSummary, authSessionRows, tailnet = {} } = ctx;
  // A remote device can only reach this Mac over Tailscale — localhost never works
  // off-machine. Show the real tailnet device URL when Tailscale is set up; otherwise
  // hard-emphasize installing/signing in to Tailscale first.
  const tsReady = Boolean(tailnet.binaryAvailable && tailnet.loggedIn && phoneUrl && phoneUrl.startsWith('http'));
  const step1 = tsReady ? `
          <div>
            <strong>1. Open this URL on the other device</strong>
            <div class="url-row">
              <code class="copy-url">${safeText(phoneUrl)}</code>
              ${copyUrlButton(phoneUrl, 'Copy link', 'btn')}
            </div>
            <div class="tiny muted">Your private Tailscale URL — open it from any device signed in to your tailnet.</div>
          </div>
          <div class="qr-wrap">${phoneDeepLinkQr}<span>Scan with your iPhone to open the Orca app</span></div>`
    : `
          <div>
            <strong>1. Set up Tailscale first ${tailnet.binaryAvailable ? '(sign in)' : '(required)'}</strong>
            <div class="tiny muted">${tailnet.binaryAvailable
              ? 'Tailscale is installed but not signed in. Sign in so this Mac gets a private device URL other devices can reach.'
              : 'Pairing needs Tailscale so other devices can privately reach this Mac. A localhost URL only works on this machine.'}</div>
            <div class="lane-row">
              ${tailnet.binaryAvailable
                ? '<a class="btn" href="https://login.tailscale.com" target="_blank" rel="noopener noreferrer">Sign in to Tailscale</a>'
                : '<a class="btn" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Install Tailscale</a><a class="btn-ghost" href="https://login.tailscale.com/start" target="_blank" rel="noopener noreferrer">Create account</a>'}
            </div>
            <div class="tiny muted">After signing in, refresh Orca — step 1 will show your private device URL automatically.</div>
          </div>`;
  // The pairing-code steps only make sense once Tailscale is up (a remote device
  // can't reach this Mac otherwise). Until then, show only the Tailscale setup.
  const tailnetStatus = tailnet.loggedIn ? 'Signed in' : tailnet.binaryAvailable ? 'Sign in' : 'Install';
  const pairingSteps = tsReady ? settingsActionRows([
    {
      kicker: 'Step 2',
      title: 'Create a one-time code',
      detail: 'Single-use and short-lived. The code pairs a browser without exposing the API token.',
      actions: pairingCodeButton(shell.lastPairing ? 'New code' : 'Create code', 'btn'),
      content: pairingCodeBox('Create a code here, then type it into the access screen on the other device.'),
    },
    {
      kicker: 'Step 3',
      title: 'Finish on the other device',
      detail: 'Open Orca there, enter the code, and the device becomes paired.',
    },
    {
      kicker: 'Optional',
      title: 'Install as an app',
      detail: 'After pairing, the device can add Orca to its Home Screen or Dock.',
    },
  ]) : '';
  return `
      <article class="card control-card pair-panel" id="section-pair" data-panel-card="access">
        <details class="disclosure">
          <summary>
            <span>Pair devices</span>
            <small>${safeText(tsReady ? 'Tailscale ready' : 'Tailscale setup')}</small>
          </summary>
          <div class="disclosure-body">
            ${settingsSummaryGrid([
              { label: 'Tailnet', value: tailnetStatus },
              { label: 'Access mode', value: accessModeSummary },
              { label: 'Paired devices', value: pairedDeviceSummary('device') },
            ])}
            <div class="onboarding-card">${step1}
            </div>
            ${pairingSteps}
            ${pairedDevicesDisclosure({ uikey: 'pair-paired-devices', summary: pairedDeviceSummary('device'), rows: authSessionRows, emptyText: 'No paired devices yet.' })}
            <p class="tiny muted">Prefer to drive Orca from a desktop AI app? <a class="settings-inline-link" href="/#mcp" data-route="mcp">Desktop app control</a></p>
          </div>
        </details>
      </article>`;
}

export function renderDesktopControlPanel(ctx) {
  const { phoneUrl, desktopBootstrapMarkup } = ctx;
  return `
      <article class="card control-card desktop-control-card" id="section-desktop-control" data-panel-card="mcp">
        <details class="disclosure">
          <summary>
            <span>Desktop app control</span>
            <small>Codex app / Claude Desktop</small>
          </summary>
          <div class="disclosure-body">
            ${settingsActionRows([
              {
                kicker: 'Visual',
                title: 'Open the dashboard in a desktop app',
                detail: 'Use the same Orca UI and chats inside Codex app or Claude Desktop.',
                content: `<code class="copy-url">${safeText(phoneUrl)}</code>`,
                actions: copyUrlButton(phoneUrl, 'Copy URL'),
              },
              {
                kicker: 'MCP',
                title: 'Register an external orchestrator',
                detail: 'Generates a scoped lease for Orca tools. The desktop agent must enroll before mutating sessions.',
                actions: '<button data-action="connectDesktopApp" type="button">Generate config</button>',
                content: desktopBootstrapMarkup,
              },
            ])}
          </div>
        </details>
      </article>`;
}

export function renderSetupPanel(ctx) {
  const { tailnet, phoneUrl, browserPaired, tokenConfigured, phoneQr, accessModeSummary, accessModeOptions, privateSettings, authSessionRows } = ctx;
  const httpServeCommand = tailscaleServeCommand('http');
  const httpsServeCommand = tailscaleServeCommand('https');
  return `
      <article class="card control-card setup-wizard" id="section-setup" data-panel-card="access">
        <details class="disclosure">
          <summary>
            <span>First-run access setup</span>
            <small>${safeText(accessModeSummary)}</small>
          </summary>
          <div class="disclosure-body">
            ${settingsSummaryGrid([
              { label: 'Tailnet', value: tailnet.loggedIn ? 'Signed in' : tailnet.binaryAvailable ? 'Sign in' : 'Install' },
              { label: 'Private URL', value: phoneUrl.startsWith('http') ? 'Ready' : 'Pending' },
              { label: 'Browser access', value: browserPaired ? 'Paired' : tokenConfigured ? 'Token set' : 'Needs code' },
            ])}
            <div class="setup-steps">
          <div class="setup-step ${tailnet.binaryAvailable ? 'ok' : 'warn'}">
            <span>1</span>
            <div><strong>Tailscale installed</strong><small>${tailnet.binaryAvailable ? 'Detected on this workstation.' : 'Install and sign in to Tailscale on this workstation.'}</small></div>
          </div>
          <div class="setup-step ${tailnet.loggedIn ? 'ok' : 'warn'}">
            <span>2</span>
            <div><strong>Tailnet session</strong><small>${tailnet.loggedIn ? 'This workstation is signed in.' : 'Sign in, then refresh Orca.'}</small></div>
          </div>
          <div class="setup-step ${phoneUrl.startsWith('http') ? 'ok' : 'warn'}">
            <span>3</span>
            <div><strong>Private URL</strong><small>${safeText(phoneUrl)}</small></div>
          </div>
          <div class="setup-step ${browserPaired || tokenConfigured ? 'ok' : 'warn'}">
            <span>4</span>
            <div><strong>Browser access</strong><small>${browserPaired ? 'This browser is paired.' : tokenConfigured ? 'API token is set in this tab.' : 'Pair remote devices with one-time codes; keep API token fallback on trusted browsers.'}</small></div>
          </div>
            </div>
            <div class="onboarding-card mini">
          <div>
            <strong>Scan or open this from your phone or laptop</strong>
            <code class="copy-url">${safeText(phoneUrl)}</code>
            <div class="lane-row">
              ${copyUrlButton(phoneUrl, 'Copy link')}
              ${pairingCodeButton('Create one-time code')}
            </div>
            ${pairingCodeBox('Create a pairing code from the trusted workstation browser, then enter it on the phone access screen.')}
          </div>
          <div class="qr-wrap">${phoneQr}<span>Scan from trusted device</span></div>
            </div>
            <details class="disclosure compact-disclosure">
          <summary><span>HTTP vs HTTPS Serve</span><small>${safeText(accessModeSummary)}</small></summary>
          <div class="disclosure-body">
            ${settingsSummaryGrid([
              { label: 'Recommended', value: 'HTTP' },
              { label: 'Privacy', value: 'Tailnet-only' },
              { label: 'HTTPS', value: 'Optional' },
            ])}
            <form id="setup-private-access-settings-form">
              <label>Access mode
                <select name="preferredMode">
                  ${accessModeOptions}
                </select>
              </label>
              <label>Open links
                <select name="openTarget">
                  <option value="external" ${selected(privateSettings.openTarget, 'external')}>External browser/tab</option>
                  <option value="in_app" ${selected(privateSettings.openTarget, 'in_app')}>In-app preview</option>
                </select>
              </label>
              <label>Notifications
                <select name="notificationMode">
                  <option value="in_app" ${selected(privateSettings.notificationMode, 'in_app')}>In-app only</option>
                  <option value="browser" ${selected(privateSettings.notificationMode, 'browser')}>Browser where supported</option>
                  <option value="off" ${selected(privateSettings.notificationMode, 'off')}>Off</option>
                </select>
              </label>
              <button type="submit">Save access settings</button>
            </form>
            <div class="lane-row">
              <button class="secondary" data-action="copyPrivateAccessCommand" data-command="${safeAttr(httpServeCommand)}" type="button">Copy HTTP Serve</button>
              <button class="secondary" data-action="copyPrivateAccessCommand" data-command="${safeAttr(httpsServeCommand)}" type="button">Copy HTTPS Serve</button>
              <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve reset" type="button">Copy disable Serve</button>
            </div>
          </div>
            </details>
          </div>
        </details>
      </article>`;
}

export function renderTokenPanel(ctx) {
  const { tokenConfigured, browserPaired, authSessionRows } = ctx;
  return `
      <article class="card control-card" id="section-token" data-panel-card="access">
        <details class="disclosure">
          <summary>
            <span>API token and browser session</span>
            <small>${safeText(browserPaired ? 'paired browser' : tokenConfigured ? 'token in tab' : 'not paired')}</small>
          </summary>
          <div class="disclosure-body">
            ${settingsSummaryGrid([
              { label: 'API token', value: tokenConfigured ? 'In memory' : 'Not set' },
              { label: 'Browser session', value: browserPaired ? 'Paired' : 'Not paired' },
              { label: 'Preferred access', value: 'Pairing code' },
            ])}
            <label>Token
          <input id="api-token-input" type="password" placeholder="Enter token" autocomplete="off" />
            </label>
            <div class="lane-row">
          <button class="secondary" data-action="setApiToken" type="button">Save token</button>
          <button class="secondary" data-action="clearApiToken" type="button">Clear token</button>
          ${pairingCodeButton('Create pairing code')}
          ${browserPaired ? '<button class="secondary" data-action="logoutBrowserSession" type="button">Log out paired browser</button>' : ''}
            </div>
            ${pairedDevicesDisclosure({ uikey: 'token-paired-devices', summary: pairedDeviceSummary('session'), rows: authSessionRows, emptyText: 'No paired browser sessions yet.' })}
            <details class="disclosure compact-disclosure">
          <summary><span>Packaged app credential storage</span><small>Tauri scope</small></summary>
          <div class="disclosure-body">
            ${settingsActionRows([
              {
                title: 'Desktop app',
                detail: 'Generate the server token on first run and store it in the OS credential store.',
              },
              {
                title: 'Phone and laptop browsers',
                detail: 'Use one-time pairing codes so raw API tokens never live in page storage.',
              },
              {
                title: 'Automation',
                detail: 'Use API tokens only for trusted automation and emergency manual setup.',
              },
            ])}
          </div>
            </details>
            <details class="disclosure compact-disclosure">
          <summary><span>Pair this browser</span><small>one-time code</small></summary>
          <div class="disclosure-body">
            <label>Pairing code
              <input id="pairing-code-input" placeholder="ABCD-1234-EF56" autocomplete="one-time-code" />
            </label>
            <label>Device label
              <input id="pairing-label-input" placeholder="My phone" />
            </label>
            <button class="secondary" data-action="pairBrowserSession" type="button">Pair browser</button>
          </div>
            </details>
          </div>
        </details>
      </article>`;
}

export function renderAccessPanel(ctx) {
  const { accessModeSummary, accessModeOptions, privateSettings, phoneUrl, phoneQr, authSessionRows } = ctx;
  return `
      <article class="card control-card" id="section-settings-access" data-panel-card="access">
        <details class="disclosure">
          <summary>
            <span>Access and paired devices</span>
            <small>${safeText(accessModeSummary)}</small>
          </summary>
          <div class="disclosure-body">
            ${settingsSummaryGrid([
              { label: 'Private access', value: accessModeSummary },
              { label: 'Pairing', value: 'One-time code' },
              { label: 'Remote browsers', value: 'Pairing gate' },
            ])}
            <form id="settings-private-access-settings-form">
              <label>Access mode
                <select name="preferredMode">
                  ${accessModeOptions}
                </select>
              </label>
              <label>Open links
                <select name="openTarget">
                  <option value="external" ${selected(privateSettings.openTarget, 'external')}>External browser/tab</option>
                  <option value="in_app" ${selected(privateSettings.openTarget, 'in_app')}>In-app preview</option>
                </select>
              </label>
              <label>Notifications
                <select name="notificationMode">
                  <option value="in_app" ${selected(privateSettings.notificationMode, 'in_app')}>In-app only</option>
                  <option value="browser" ${selected(privateSettings.notificationMode, 'browser')}>Browser where supported</option>
                  <option value="off" ${selected(privateSettings.notificationMode, 'off')}>Off</option>
                </select>
              </label>
              <button type="submit">Save access settings</button>
            </form>
            <div class="onboarding-card mini">
              <div>
                <strong>Pair a phone or laptop</strong>
                <div class="tiny muted">Create a fresh code only from this authenticated workstation, then enter it on the unpaired device. Codes are one-time use and expire quickly.</div>
                <div class="lane-row">
                  ${pairingCodeButton('Create one-time code')}
                  ${copyUrlButton(phoneUrl, 'Copy private URL')}
                </div>
                ${(shell.lastPairing || shell.pairingAccepted) ? pairingCodeBox('') : ''}
              </div>
              <div class="qr-wrap">${phoneQr}<span>Trusted setup QR</span></div>
            </div>
            ${pairedDevicesDisclosure({ uikey: 'access-paired-devices', summary: `${pairedDeviceCount() ?? 0} active`, rows: authSessionRows, emptyText: 'No paired browser sessions yet.', bodyPrefix: '<div class="tiny muted">Rotate access by revoking old devices, clearing this browser token if needed, then creating a fresh pairing code.</div>' })}
          </div>
        </details>
      </article>`;
}

export function renderExecutorProfilesPanel(ctx) {
  const { profileRows } = ctx;
  return `
      <article class="card control-card" id="section-system" data-panel-card="agents">
        <details class="disclosure">
          <summary>
            <span>Executor profiles</span>
            <small>Defaults, binaries, workdirs</small>
          </summary>
          <div class="disclosure-body">
            <div class="provider-list">${profileRows || '<div class="muted">No executor profiles loaded yet.</div>'}</div>
          </div>
        </details>
      </article>`;
}

export function renderCapturePanel(ctx) {
  const { captureSummary, captureDetail, captureReady } = ctx;
  return `
      <article class="card control-card" data-panel-card="agents">
        <details class="disclosure">
          <summary>
            <span>Evidence capture backend</span>
            <small>${safeText(captureSummary)}</small>
          </summary>
          <div class="disclosure-body">
            ${settingsSummaryGrid([
              { label: 'Status', value: captureSummary },
              { label: 'Video capture', value: captureReady ? 'Ready' : 'Needs setup' },
            ])}
            <div class="lane-row">
              <button class="secondary" data-action="setupCapture" type="button">${captureReady ? 'Reconfigure capture' : 'Enable screenshots &amp; video'}</button>
            </div>
            ${settingsCallout('Governed setup', `${captureDetail} Dry-run first; install only after confirmation.`)}
          </div>
        </details>
      </article>`;
}

export function renderCliHealthPanel(ctx) {
  const { cliRows } = ctx;
  return `
      <article class="card control-card" id="section-cli-setup" data-panel-card="agents">
        <details class="disclosure">
          <summary>
            <span>Agent CLIs &amp; setup</span>
            <small>Codex, Claude, Gemini · how discovery works</small>
          </summary>
          <div class="disclosure-body">
            ${settingsActionRows([
              {
                title: 'Discovery source',
                detail: 'Orca runs which <cli> against the PATH it was launched from.',
              },
              {
                title: 'Add a CLI',
                detail: 'Install the official CLI, confirm it resolves in that shell, then relaunch Orca or refresh.',
              },
              {
                title: 'Installed but missing',
                detail: 'Usually means Orca started from a shell that did not have the CLI on PATH.',
              },
            ])}
            <div class="provider-list">${cliRows || '<div class="muted">No CLI data yet.</div>'}</div>
          </div>
        </details>
      </article>`;
}

export function renderCleanupPanel(ctx) {
  const { schedule, cleanupNext, scheduleApiUrl, scheduleRunApiUrl } = ctx;
  return `
      <article class="card control-card" id="section-cleanup" data-panel-card="operations">
        <details class="disclosure">
          <summary>
            <span>Artifact cleanup schedule</span>
            <small>${schedule.enabled ? `Enabled · next ${safeText(cleanupNext)}` : 'Disabled'}</small>
          </summary>
          <div class="disclosure-body">
        ${settingsSummaryGrid([
          { label: 'Status', value: schedule.enabled ? 'Enabled' : 'Disabled' },
          { label: 'Next run', value: schedule.enabled ? cleanupNext : 'Not scheduled' },
          { label: 'Retention', value: schedule.olderThanDays ? `${schedule.olderThanDays} days` : 'Default' },
        ])}
        <form id="cleanup-schedule-form" data-url="${safeAttr(scheduleApiUrl)}" data-action-source="cleanup-schedule">
          <label><input type="checkbox" name="enabled" ${schedule.enabled ? 'checked' : ''}> Enable periodic cleanup</label>
          <label>Interval hours
            <input name="intervalHours" type="number" min="1" max="720" step="0.5" value="${safeAttr(schedule.intervalHours || 24)}" />
          </label>
        <label>Prune older than (days)
            <input name="olderThanDays" type="number" min="1" placeholder="default session retention" value="${safeAttr(schedule.olderThanDays || "")}" />
          </label>
          <label>Target session id (optional)
            <input name="sessionId" placeholder="leave blank for all sessions" value="${safeAttr(schedule.sessionId || "")}" />
          </label>
          <label><input type="checkbox" name="dryRun" ${schedule.dryRun ? 'checked' : ''}> Dry run mode</label>
          <button type="submit">Save cleanup schedule</button>
        </form>
        <div class="lane-row">
          <button class="secondary" data-action="cleanupArtifactsRunNow" data-url="${safeAttr(scheduleRunApiUrl)}" type="button">Run cleanup now</button>
        </div>
          </div>
        </details>
      </article>`;
}

export function renderMcpPanel(ctx) {
  const { visibleMcpTools, mcpOptions } = ctx;
  const customCount = Array.isArray(visibleMcpTools) ? visibleMcpTools.length : 0;
  return `
      <article class="card control-card" id="section-mcp" data-panel-card="mcp">
        <details class="disclosure">
          <summary>
            <span>Advanced MCP tools</span>
            <small>${safeText(customCount)} custom</small>
          </summary>
          <div class="disclosure-body">
        ${settingsSummaryGrid([
          { label: 'Custom tools', value: customCount },
          { label: 'Scope model', value: 'Allowlist' },
        ])}
        ${settingsCallout('Operator-only surface', 'Most users should use Desktop app control. Custom tools are for explicitly approved local commands and stay scoped by allowlist.')}
        <div class="provider-list">${mcpOptions || '<div class="muted">No custom MCP tools configured.</div>'}</div>
        <details class="disclosure compact-disclosure">
          <summary>
            <span>Add custom tool</span>
            <small>Advanced</small>
          </summary>
          <div class="disclosure-body">
            <form id="create-mcp-tool-form">
              <label>Name
                <input name="name" placeholder="eg: files" required />
              </label>
              <label>Command
                <input name="command" placeholder="single executable token, eg: node" required />
                <div class="tiny muted">Examples: node, npx, python</div>
              </label>
              <label>Args
                <input name="args" placeholder="comma separated args" />
              </label>
              <label>Scope
                <input name="scope" placeholder="${safeAttr(MCP_TOOL_SCOPE_ALLOWLIST.slice(0, 3).join(','))}" />
                <div class="tiny muted">Allowed scopes: ${safeText(MCP_TOOL_SCOPE_ALLOWLIST.join(', '))}</div>
              </label>
              <label>Notes
                <input name="notes" />
              </label>
              <label class="settings-checkbox"><input type="checkbox" name="enabled" checked> <span>Available to agents</span></label>
              <div class="tiny muted">When unavailable, the tool is saved but cannot be attached to agent sessions.</div>
              <button type="submit">Add MCP tool</button>
            </form>
          </div>
        </details>
          </div>
        </details>
      </article>`;
}

export function renderSupervisorPanel(ctx) {
  const { supervisorOverview, supervisorBootstrapMarkup } = ctx;
  const projects = Array.isArray(supervisorOverview?.projects) ? supervisorOverview.projects : [];
  const activeSupervisors = Array.isArray(supervisorOverview?.activeSupervisors) ? supervisorOverview.activeSupervisors : [];
  const sessionRows = projects.flatMap((project) =>
    (Array.isArray(project.sessions) ? project.sessions : []).map((session) => {
      const active = Boolean(session.activeOrchestrator?.active);
      const backlog = session.backlog || {};
      const counts = backlog.counts || {};
      const review = session.supervisorReview || null;
      const route = session.route || project.route || '/';
      const reviewStatus = String(review?.status || review?.verdict || '').toLowerCase();
      const pendingApprovals = Number.parseInt(session.approvals?.pending, 10) || 0;
      const rowTags = [
        active ? '<span class="tag ok">Active</span>' : '<span class="tag warn">Idle</span>',
        pendingApprovals ? `<span class="tag warn">${safeText(pendingApprovals)} approval${pendingApprovals === 1 ? '' : 's'}</span>` : '',
        backlog.stalled ? '<span class="tag bad">Stalled</span>' : '',
        counts.blocked ? `<span class="tag bad">${safeText(counts.blocked)} blocked</span>` : '',
        reviewStatus === 'fix_requested' ? '<span class="tag warn">Fix requested</span>' : '',
        reviewStatus === 'blocked' ? '<span class="tag bad">Supervisor blocked</span>' : '',
        reviewStatus === 'accepted' ? '<span class="tag ok">Accepted</span>' : '',
      ].filter(Boolean).join('');
      return `
        <div class="provider-row">
          <div>
            <strong>${safeText(project.name)} / ${safeText(session.name)}</strong>
            <div>${rowTags}</div>
            <div class="tiny muted">
              ${active ? `orchestrator: ${safeText(session.activeOrchestrator?.actor || session.activeOrchestrator?.source || 'active')}` : 'orchestrator: idle'}
              · next: ${safeText(session.nextRequiredTool || 'none')}
              · worktree: ${safeText(session.worktreeMode || 'isolated')}
            </div>
            <div class="tiny muted">
              backlog: ${safeText(counts.accepted || 0)} accepted / ${safeText(counts.total || 0)} total
              ${backlog.stalled ? ` · stalled: ${safeText((backlog.stallReasons || []).join(', ') || 'yes')}` : ''}
              ${review ? ` · supervisor: ${safeText(review.status || review.verdict)}` : ''}
            </div>
            ${(backlog.warnings || []).length ? `<div class="tiny muted">${safeText(backlog.warnings.join(' '))}</div>` : ''}
          </div>
          <div class="lane-row">
            <a class="secondary" href="${safeAttr(route)}">Open</a>
            <button class="secondary" data-action="supervisorAudit" data-session-id="${safeAttr(session.id)}" data-verdict="accept" type="button">Accept</button>
            <button class="secondary" data-action="supervisorAudit" data-session-id="${safeAttr(session.id)}" data-verdict="request_fix" type="button">Request fix</button>
            <button class="danger" data-action="supervisorAudit" data-session-id="${safeAttr(session.id)}" data-verdict="block" type="button">Block</button>
          </div>
        </div>`;
    })
  ).join('');
  const totalSessions = projects.reduce((sum, project) => sum + (Array.isArray(project.sessions) ? project.sessions.length : 0), 0);
  const activeCount = projects.reduce((sum, project) =>
    sum + (Array.isArray(project.sessions) ? project.sessions.filter((session) => session.activeOrchestrator?.active).length : 0), 0);
  const triageCounts = projects.reduce((acc, project) => {
    for (const session of Array.isArray(project.sessions) ? project.sessions : []) {
      const reviewStatus = String(session.supervisorReview?.status || session.supervisorReview?.verdict || '').toLowerCase();
      const counts = session.backlog?.counts || {};
      if (session.backlog?.stalled) acc.stalled += 1;
      if (counts.blocked) acc.blocked += Number(counts.blocked) || 0;
      if (session.approvals?.pending) acc.approvals += Number(session.approvals.pending) || 0;
      if (reviewStatus === 'fix_requested') acc.fixRequested += 1;
    }
    return acc;
  }, { stalled: 0, blocked: 0, approvals: 0, fixRequested: 0 });
  const hasSupervisorBlockers = triageCounts.stalled || triageCounts.blocked || triageCounts.approvals || triageCounts.fixRequested;
  return `
      <article class="card control-card" id="section-supervisor" data-panel-card="supervisor">
        <div class="settings-panel-head">
          <div>
            <h3>Supervisor agent</h3>
            <p class="muted">${safeText(projects.length)} projects · ${safeText(totalSessions)} sessions · ${safeText(activeCount)} active orchestrator${activeCount === 1 ? '' : 's'} · ${safeText(activeSupervisors.length)} supervisor${activeSupervisors.length === 1 ? '' : 's'}</p>
            <div>
              ${triageCounts.stalled ? `<span class="tag bad">${safeText(triageCounts.stalled)} stalled</span>` : ''}
              ${triageCounts.blocked ? `<span class="tag bad">${safeText(triageCounts.blocked)} blocked</span>` : ''}
              ${triageCounts.approvals ? `<span class="tag warn">${safeText(triageCounts.approvals)} approval${triageCounts.approvals === 1 ? '' : 's'}</span>` : ''}
              ${triageCounts.fixRequested ? `<span class="tag warn">${safeText(triageCounts.fixRequested)} fix requested</span>` : ''}
              ${hasSupervisorBlockers ? '' : '<span class="tag ok">No supervisor blockers</span>'}
            </div>
          </div>
          <button data-action="connectSupervisorApp" type="button">Connect supervisor</button>
        </div>
        ${supervisorBootstrapMarkup}
        <div class="provider-list">${sessionRows || '<div class="muted">No active sessions yet.</div>'}</div>
      </article>`;
}

export function renderPrivateAccessPanel(ctx) {
  const { accessModeSummary, tailnet, accessModeOptions, privateSettings, phoneUrl, commandRows, privateTargets, targetRows } = ctx;
  const httpsServeCommand = tailscaleServeCommand('https');
  const targetCount = Array.isArray(privateTargets) ? privateTargets.filter((target) => !target.hidden).length : 0;
  return `
      <article class="card control-card" id="section-private-access" data-panel-card="access">
        <details class="disclosure">
          <summary>
            <span>Private access</span>
            <small>${safeText(accessModeSummary)} · ${safeText(targetCount)} target${targetCount === 1 ? '' : 's'}</small>
          </summary>
          <div class="disclosure-body">
            <div class="access-summary">
              <div class="stat">
                <b>${tailnet.binaryAvailable ? 'Yes' : 'No'}</b>
                <span>Tailscale detected</span>
              </div>
              <div class="stat">
                <b>${tailnet.loggedIn ? 'Yes' : 'No'}</b>
                <span>Tailnet login</span>
              </div>
              <div class="stat">
                <b>${safeText(tailnet.serveMode || 'Pending')}</b>
                <span>Serve mode</span>
              </div>
            </div>
            ${!tailnet.binaryAvailable ? `
            <div class="ts-setup-callout">
              <strong>Tailscale isn't installed on this Mac.</strong>
              <div class="tiny muted">Tailscale is what lets your other devices reach Orca privately. Install it and sign in, then refresh.</div>
              <div class="lane-row">
                <a class="btn" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Install Tailscale</a>
                <a class="btn-ghost" href="https://login.tailscale.com/start" target="_blank" rel="noopener noreferrer">Create an account</a>
              </div>
            </div>` : !tailnet.loggedIn ? `
            <div class="ts-setup-callout">
              <strong>Tailscale is installed but not signed in.</strong>
              <div class="lane-row"><a class="btn" href="https://login.tailscale.com" target="_blank" rel="noopener noreferrer">Sign in to Tailscale</a></div>
            </div>` : (tailnet.serveConfigured ? `
            <div class="ts-setup-callout">
              <strong>✓ Tailscale Serve is active</strong>
              <div class="tiny muted">Your device URL works from any device on your tailnet.</div>
              <div class="lane-row"><button class="btn-ghost" data-action="disableTailscaleServe" type="button">Turn off Serve</button></div>
            </div>` : `
            <div class="ts-setup-callout">
              <strong>Make Orca reachable from your other devices</strong>
              <div class="tiny muted">One tap runs Tailscale Serve (HTTP, tailnet-only) so a phone/laptop can open Orca — no commands to copy. You can still do it manually in Terminal if you prefer.</div>
              <div class="lane-row"><button class="btn" data-action="setupTailscaleServe" type="button">Set up Tailscale Serve</button></div>
            </div>`)}
            ${settingsCallout(
              'HTTP over Tailscale is the default',
              'Private, encrypted by the tailnet, and avoids public certificate-transparency metadata.',
            )}
            <form id="private-access-settings-form">
              <label>Access mode
                <select name="preferredMode">
                  ${accessModeOptions}
                </select>
              </label>
              <label>Open links
                <select name="openTarget">
                  <option value="external" ${selected(privateSettings.openTarget, 'external')}>External browser/tab</option>
                  <option value="in_app" ${selected(privateSettings.openTarget, 'in_app')}>In-app preview</option>
                </select>
              </label>
              <label>Notifications
                <select name="notificationMode">
                  <option value="in_app" ${selected(privateSettings.notificationMode, 'in_app')}>In-app only</option>
                  <option value="browser" ${selected(privateSettings.notificationMode, 'browser')}>Browser where supported</option>
                  <option value="off" ${selected(privateSettings.notificationMode, 'off')}>Off</option>
                </select>
              </label>
              <button type="submit">Save private access settings</button>
            </form>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Saved private targets</span>
                <small>${safeText(targetCount)} configured</small>
              </summary>
              <div class="disclosure-body">
                ${targetRows || '<div class="muted">No private targets saved yet.</div>'}
              </div>
            </details>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Add private target</span>
                <small>Project or dev server</small>
              </summary>
              <div class="disclosure-body">
                <form id="private-access-target-form">
                  <label>Label
                    <input name="label" placeholder="Example app" required />
                  </label>
                  <label>Mode
                    <select name="mode">
                      <option value="tailnet-http">Tailnet HTTP</option>
                      <option value="tailnet-https-serve">Tailnet HTTPS Serve</option>
                      <option value="local">Local only</option>
                    </select>
                  </label>
                  <label>Local URL
                    <input name="localUrl" inputmode="url" placeholder="http://127.0.0.1:5173" />
                  </label>
                  <label>Tailnet HTTP URL
                    <input name="tailnetHttpUrl" inputmode="url" placeholder="http://mac.tailnet.ts.net:5173" />
                  </label>
                  <label>HTTPS Serve URL
                    <input name="httpsServeUrl" inputmode="url" placeholder="https://mac.tailnet.ts.net" />
                  </label>
                  <label class="settings-checkbox"><input type="checkbox" name="favorite" checked> <span>Show as a preferred private link</span></label>
                  <button type="submit">Add target</button>
                </form>
              </div>
            </details>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Phone URL and HTTPS wizard</span>
                <small>Tailscale Serve</small>
              </summary>
              <div class="disclosure-body">
                <div class="access-command">
                  <div>
                    <strong>Your Tailscale device URL</strong>
                    <div class="tiny muted">${phoneUrl && phoneUrl.startsWith('http') ? 'Open this from any device signed in to your tailnet. localhost only works on this Mac.' : 'Sign in to Tailscale above to get a device URL other devices can reach.'}</div>
                    ${phoneUrl && phoneUrl.startsWith('http') ? `<code>${safeText(phoneUrl)}</code>` : ''}
                  </div>
                  ${phoneUrl && phoneUrl.startsWith('http') ? copyUrlButton(phoneUrl, 'Copy', 'btn-ghost') : ''}
                </div>
                <div class="settings-subsection">
                  <h3>Optional: enable HTTPS Serve</h3>
                  ${settingsActionRows([
                    {
                      title: 'Enable certificates in Tailscale admin',
                      detail: 'DNS -> HTTPS Certificates must be enabled before the HTTPS Serve command works.',
                    },
                    {
                      title: 'Run the HTTPS Serve command yourself',
                      detail: 'Orca only copies commands here; it does not run HTTPS setup for you.',
                      actions: `<button class="btn-ghost" data-action="copyPrivateAccessCommand" data-command="${safeAttr(httpsServeCommand)}" type="button">Copy HTTPS command</button>`,
                    },
                    {
                      title: 'Disable HTTPS Serve',
                      detail: 'Use reset if you no longer need browser secure-context behavior.',
                      actions: '<button class="btn-ghost" data-action="copyPrivateAccessCommand" data-command="tailscale serve reset" type="button">Copy reset command</button>',
                    },
                  ])}
                </div>
                <div class="settings-subsection">
                  <h3>Rotate or rename hostname</h3>
                  ${settingsActionRows([
                    {
                      title: 'Rename before issuing certs',
                      detail: 'Use Tailscale admin if the current Mac name should not appear in certificate metadata.',
                    },
                    {
                      title: 'Update saved links afterward',
                      detail: 'Tailnet DNS suffix changes can break existing private URLs.',
                    },
                  ])}
                </div>
              </div>
            </details>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Manual setup commands</span>
                <small>Copy only</small>
              </summary>
              <div class="disclosure-body">
                ${commandRows || '<div class="muted">No setup commands available for the current Tailscale state.</div>'}
              </div>
            </details>
            <div class="tiny muted">Project live links still live on each project; private targets here are reusable workstation access entries.</div>
          </div>
        </details>
      </article>`;
}

export function renderProvidersPanel(ctx) {
  const { providerProfiles, providerCatalog, providerRows } = ctx;
  return `
      <article class="card control-card" id="section-providers" data-panel-card="providers">
        <div class="settings-panel-head">
          <div>
            <h3>Provider profiles</h3>
            <p class="muted">${safeText(providerProfiles.length)} configured · credentials ${safeText(providerCatalog.credentialBackend || 'unknown')}</p>
          </div>
        </div>
        ${settingsSummaryGrid([
          { label: 'Profile config', value: 'Non-secret' },
          { label: 'Credential values', value: 'Never echoed' },
          { label: 'Installs', value: 'Plan-only' },
        ])}
        <div class="provider-list">${providerRows || '<div class="muted">No provider profiles loaded.</div>'}</div>
        <details class="disclosure compact-disclosure">
          <summary>
            <span>Import/export</span>
            <small>No secrets included</small>
          </summary>
          <div class="disclosure-body">
            <div class="lane-row">
              <button class="secondary" data-action="exportProviderProfiles" type="button">Export profiles</button>
              <button class="secondary" data-action="dryRunProviderImport" type="button">Dry-run import</button>
            </div>
            <textarea id="provider-import-json" rows="8" placeholder='{"schemaVersion":1,"profiles":[]}'></textarea>
            <pre id="provider-export-output" aria-live="polite"></pre>
          </div>
        </details>
      </article>`;
}

export function renderEffectiveSettingsPanel(ctx) {
  const { effectiveSummary, effectiveSources, effectiveSourcesText, effectiveSettingsText } = ctx;
  return `
      <article class="card control-card" id="section-effective-settings" data-panel-card="operations">
        <details class="disclosure">
          <summary>
            <span>Effective settings</span>
            <small>global -> project -> session -> lane -> action</small>
          </summary>
          <div class="disclosure-body">
            ${settingsCallout('Resolved server truth', 'Secret values are excluded; this view shows the effective policy after overrides.')}
            <div class="access-summary">
              <div class="stat">
                <b>${safeText(effectiveSummary.spawn?.approvedCapacity ?? 2)}</b>
                <span>Approved capacity</span>
              </div>
              <div class="stat">
                <b>${safeText(effectiveSummary.spawn?.worktreeMode || 'isolated')}</b>
                <span>Worktree mode</span>
              </div>
              <div class="stat">
                <b>${safeText(effectiveSummary.critique?.mode || 'suggested')}</b>
                <span>Critique</span>
              </div>
              <div class="stat">
                <b>${safeText(effectiveSummary.privateAccess?.preferredMode || 'auto')}</b>
                <span>Private access</span>
              </div>
            </div>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Sources applied</span>
                <small>${safeText(effectiveSources.length)} source${effectiveSources.length === 1 ? '' : 's'}</small>
              </summary>
              <pre>${safeText(effectiveSourcesText || 'global:defaults')}</pre>
            </details>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Resolved JSON</span>
                <small>secret-free</small>
              </summary>
              <pre>${safeText(effectiveSettingsText)}</pre>
            </details>
          </div>
        </details>
      </article>`;
}

export function renderNotificationsPanel(ctx) {
  const { unreadNotifications, browserPermission, notificationSettings, notificationRows } = ctx;
  return `
      <article class="card control-card" id="section-notifications" data-panel-card="operations">
        <details class="disclosure">
          <summary>
            <span>Notifications</span>
            <small>${safeText(unreadNotifications)} unread · browser ${safeText(browserPermission)}</small>
          </summary>
          <div class="disclosure-body">
            ${settingsSummaryGrid([
              { label: 'Unread', value: unreadNotifications },
              { label: 'Browser permission', value: browserPermission },
              { label: 'Payloads', value: 'Secret-free' },
            ])}
            <form id="notification-settings-form">
              <label><input type="checkbox" name="inAppEnabled" ${checked(notificationSettings.inAppEnabled !== false)}> Enable in-app notifications</label>
              <label><input type="checkbox" name="browserEnabled" ${checked(Boolean(notificationSettings.browserEnabled))}> Enable browser notifications where supported</label>
              <label>Minimum severity
                <select name="minSeverity">
                  <option value="info" ${selected(notificationSettings.minSeverity, 'info')}>Info and up</option>
                  <option value="warning" ${selected(notificationSettings.minSeverity, 'warning')}>Warnings and errors</option>
                  <option value="error" ${selected(notificationSettings.minSeverity, 'error')}>Errors only</option>
                </select>
              </label>
              <label><input type="checkbox" name="muted" ${checked(Boolean(notificationSettings.muted))}> Mute notifications</label>
              <div class="lane-row">
                <button type="submit">Save notifications</button>
                ${browserNotificationsSupported()
                  ? '<button class="secondary" data-action="requestBrowserNotifications" type="button">Browser permission</button>'
                  : '<button class="secondary" type="button" disabled title="This browser does not support Notification API">Browser unavailable</button>'}
                ${unreadNotifications ? '<button class="secondary" data-action="markAllNotificationsRead" type="button">Mark all read</button>' : '<button class="secondary" type="button" disabled title="There are no unread notifications to mark read.">No unread notifications</button>'}
              </div>
            </form>
            <div class="provider-list">${notificationRows || '<div class="muted">No notifications yet.</div>'}</div>
          </div>
        </details>
      </article>`;
}

export function renderBackupPanel() {
  return `
      <article class="card control-card" id="section-backup" data-panel-card="operations">
        <details class="disclosure">
          <summary>
            <span>Backup and support</span>
            <small>Local-only export · redacted support bundle</small>
          </summary>
          <div class="disclosure-body">
            ${settingsSummaryGrid([
              { label: 'Includes', value: 'Metadata' },
              { label: 'Secrets', value: 'Excluded' },
              { label: 'Artifacts/logs', value: 'Excluded' },
            ])}
            <div class="lane-row">
              <button class="secondary" data-action="exportAppBackup" type="button">Export app backup</button>
              <button class="secondary" data-action="exportSupportBundle" type="button">Export support bundle</button>
            </div>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Import backup</span>
                <small>dry-run before apply</small>
              </summary>
              <div class="disclosure-body">
                <textarea id="app-import-json" rows="8" placeholder='{"schemaVersion":1,"kind":"orca.app-export"}'></textarea>
                <div class="lane-row">
                  <button class="secondary" data-action="dryRunAppImport" type="button">Dry-run import</button>
                  <button class="danger" data-action="applyAppImport" type="button">Apply import</button>
                </div>
              </div>
            </details>
            <pre id="app-export-output" aria-live="polite"></pre>
            <div class="about-links">
              <a href="https://github.com/alex2481kobe/orca" target="_blank" rel="noreferrer noopener">Source</a>
              <span aria-hidden="true">·</span>
              <a href="https://github.com/alex2481kobe/orca/blob/main/LICENSE" target="_blank" rel="noreferrer noopener">Apache 2.0 License</a>
            </div>
          </div>
        </details>
      </article>`;
}

export function renderArchivePanel() {
  const archive = shell.archive || { projects: [], sessions: [] };
  const archivedProjects = Array.isArray(archive.projects) ? archive.projects : [];
  const archivedSessions = Array.isArray(archive.sessions) ? archive.sessions : [];
  const projectRows = archivedProjects.map((project) => `
    <div class="archive-row">
      <div class="archive-row-info">
        <strong>${safeText(project.name)}</strong>
        <div class="tiny muted">Project</div>
      </div>
      <div class="archive-row-actions">
        <button class="btn-ghost" data-action="restoreProject" data-project-id="${safeAttr(project.id)}" type="button">Restore</button>
        <button class="device-revoke" data-action="deleteProjectPermanent" data-project-id="${safeAttr(project.id)}" data-project-name="${safeAttr(project.name)}" type="button">Delete permanently</button>
      </div>
    </div>
  `).join('');
  const sessionRows = archivedSessions.map((session) => `
    <div class="archive-row">
      <div class="archive-row-info">
        <strong>${safeText(session.name)}</strong>
        <div class="tiny muted">${safeText(session.projectName || 'Project')}</div>
      </div>
      <div class="archive-row-actions">
        <button class="btn-ghost" data-action="restoreSession" data-session-id="${safeAttr(session.id)}" type="button">Restore</button>
        <button class="device-revoke" data-action="deleteSessionPermanent" data-session-id="${safeAttr(session.id)}" data-session-name="${safeAttr(session.name)}" type="button">Delete permanently</button>
      </div>
    </div>
  `).join('');
  const empty = !archivedProjects.length && !archivedSessions.length;
  return `
      <article class="card control-card" data-panel-card="operations">
        <details class="disclosure" data-uikey="archive">
          <summary>
            <span>Archive</span>
            <small>${safeText(archivedProjects.length + archivedSessions.length)} archived</small>
          </summary>
          <div class="disclosure-body">
            ${settingsCallout('Archive keeps work out of the sidebar', 'Restore brings items back. Permanent delete requires an explicit action.')}
            ${empty ? '<div class="muted tiny">Nothing archived.</div>' : `<div class="archive-list">${projectRows}${sessionRows}</div>`}
          </div>
        </details>
      </article>`;
}

export function renderProjectListPanel(ctx) {
  const { primaryProjectCards, verificationProjects, verificationProjectCards } = ctx;
  return `
      <div class="card" data-panel-card="projects">
        <h3>Project list</h3>
        <div class="card-grid">${primaryProjectCards || '<div class="muted">No projects yet.</div>'}</div>
        ${verificationProjectCards ? `
          <details class="disclosure compact-disclosure">
            <summary>
              <span>Verification runs</span>
              <small>${safeText(verificationProjects.length)} smoke project${verificationProjects.length === 1 ? '' : 's'}</small>
            </summary>
            <div class="card-grid">${verificationProjectCards}</div>
          </details>
        ` : ''}
      </div>`;
}

export function renderSystemActionsPanel(ctx) {
  const { artifactCleanupUrl } = ctx;
  return `
      <article class="card" data-panel-card="operations">
        <h3>System actions</h3>
        <button
          class="secondary"
          data-action="cleanupArtifacts"
          data-url="${safeAttr(artifactCleanupUrl)}"
          type="button"
        >Run artifact cleanup</button>
      </article>`;
}
