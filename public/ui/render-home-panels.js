// Home-view panel renderers, split out of render-home.js so that file stays a
// thin data-prep + composition layer. Each function takes the prepared `ctx`
// (built once in renderHome) and returns the exact HTML for one panel/section.

import { safeAttr, safeText, formatRelative } from './format.js';
import { browserNotificationsSupported } from './notifications.js';
import { MCP_TOOL_SCOPE_ALLOWLIST } from './constants.js';
import { shell } from './state.js';

const selected = (actual, expected) => String(actual || '') === String(expected || '') ? 'selected' : '';
const checked = (value) => value ? 'checked' : '';

export function renderSimpleSection(ctx) {
  const { showMainHome, phoneUrl, phoneQr, accessModeSummary, projectRows, unreadNotifications } = ctx;
  return `
    <section class="simple-section ${showMainHome ? '' : 'is-hidden'}">
      <article class="card onboarding-card">
        <div>
          <div class="card-kicker">Phone and laptop setup</div>
          <h3>Open Orca from another device</h3>
          <p class="muted">Use a device on the same tailnet, open this private URL, then enter a one-time pairing code from this workstation. API tokens stay on trusted admin browsers.</p>
          <code class="copy-url">${safeText(phoneUrl)}</code>
          <div class="lane-row">
            <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy link</button>
            <button class="secondary" data-action="createPairingCode" type="button">Create pairing code</button>
            <a class="secondary" href="#setup">Setup wizard</a>
            <a class="secondary" href="#private-access">Tailscale setup</a>
          </div>
          <div class="tiny muted">Access preference: ${safeText(accessModeSummary)}</div>
          <details class="disclosure compact-disclosure">
            <summary><span>Add to Home Screen</span><small>iPhone/iPad</small></summary>
            <div class="disclosure-body tiny muted">Open the private URL in Safari, tap Share, then tap Add to Home Screen. HTTPS Serve gives the best PWA behavior; HTTP over Tailscale is private but may show browser warnings.</div>
          </details>
        </div>
        <div class="qr-wrap">${phoneQr}<span>Scan from phone</span></div>
      </article>
      <h3>Projects</h3>
      <a class="simple-row" href="#setup">
        <span class="row-icon">◎</span>
        <span>Phone setup wizard</span>
      </a>
      <a class="simple-row" href="#create">
        <span class="row-icon">＋</span>
        <span>New project</span>
      </a>
      ${projectRows || '<div class="muted">No projects yet.</div>'}
      <a class="simple-row" href="#private-access">
        <span class="row-icon">◌</span>
        <span>Private access</span>
      </a>
      <a class="simple-row" href="#providers">
        <span class="row-icon">◇</span>
        <span>Providers</span>
      </a>
      <a class="simple-row" href="#effective-settings">
        <span class="row-icon">✓</span>
        <span>Effective settings</span>
      </a>
      <a class="simple-row" href="#notifications">
        <span class="row-icon">•</span>
        <span>Notifications</span>
        ${unreadNotifications ? `<small>${safeText(unreadNotifications)} unread</small>` : ''}
      </a>
      <a class="simple-row" href="#backup">
        <span class="row-icon">⇄</span>
        <span>Backup and support</span>
      </a>
    </section>
    <div class="stat-grid compact-stats settings-stats is-hidden">
      <div class="stat">
        <b>${shell.projects.length}</b>
        <span>Projects</span>
      </div>
    </div>`;
}

export function renderPairPanel(ctx) {
  const { phoneUrl, phoneQr, accessModeSummary, authSessionRows } = ctx;
  return `
      <article class="card control-card pair-panel" id="section-pair" data-panel-card="pair">
        <div class="card-kicker">Pair a device</div>
        <h3>Pair with remote device</h3>
        <p class="muted">Open Orca on a laptop or phone, then connect it to this workstation. Scan the QR code or open the private URL on the other device, then enter a one-time pairing code. The code grants workflow access without ever exposing the API token.</p>
        <div class="onboarding-card">
          <div>
            <strong>1. Open this URL on the other device</strong>
            <code class="copy-url">${safeText(phoneUrl)}</code>
            <div class="lane-row">
              <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy link</button>
              <a class="secondary" href="#private-access">Tailscale setup</a>
            </div>
            <div class="tiny muted">Access preference: ${safeText(accessModeSummary)}. On the same tailnet use the private URL; on the same LAN the local URL works without Tailscale.</div>
          </div>
          <div class="qr-wrap">${phoneQr}<span>Scan from phone or laptop</span></div>
        </div>
        <div class="pair-step">
          <strong>2. Create a one-time pairing code</strong>
          <div class="lane-row">
            <button data-action="createPairingCode" type="button">Create pairing code</button>
          </div>
          ${shell.lastPairing ? `
            <div class="pairing-code-box">
              <div class="tiny muted">One-time pairing code. Do not screenshot or paste into URLs.</div>
              <strong>${safeText(shell.lastPairing.code)}</strong>
              <span>Expires ${safeText(formatRelative(shell.lastPairing.expiresAt))}</span>
            </div>
          ` : '<div class="tiny muted">Create a code here, then type it into the access screen on the other device. Codes are single-use and expire quickly.</div>'}
        </div>
        <div class="pair-step">
          <strong>3. Enter the code on the other device</strong>
          <div class="tiny muted">On the laptop/phone access screen, paste the code to pair that browser. Paired devices get workflow access; API tokens stay on trusted admin browsers only.</div>
        </div>
        <details class="disclosure compact-disclosure">
          <summary><span>Paired devices</span><small>${safeText((shell.authSessions || []).length)} session${(shell.authSessions || []).length === 1 ? '' : 's'}</small></summary>
          <div class="disclosure-body">${authSessionRows || '<div class="muted">No paired browser sessions yet.</div>'}</div>
        </details>
        <div class="lane-row">
          <a class="secondary" href="#setup">Full setup wizard</a>
          <a class="secondary" href="#system">Access &amp; token settings</a>
        </div>
      </article>`;
}

export function renderDesktopControlPanel(ctx) {
  const { phoneUrl, desktopBootstrapMarkup } = ctx;
  return `
      <article class="card control-card desktop-control-card" id="section-desktop-control" data-panel-card="desktop-control">
        <div class="card-kicker">Desktop app control</div>
        <h3>Drive Orca from Codex app or Claude Desktop</h3>
        <p class="muted">Two complementary ways to control this dashboard from a desktop AI app:</p>
        <div class="pair-step">
          <strong>A. In-app browser (visual)</strong>
          <div class="tiny muted">Open this dashboard URL in the desktop app's built-in browser to use Orca's UI and chats directly.</div>
          <code class="copy-url">${safeText(phoneUrl)}</code>
          <div class="lane-row">
            <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy dashboard URL</button>
          </div>
        </div>
        <div class="pair-step">
          <strong>B. MCP tooling (programmatic)</strong>
          <div class="tiny muted">Generate a scoped orchestrator MCP config. The desktop agent then acts as the Orca orchestrator with full tooling (spawn/stop lanes, tasks, approvals, mode/permission/goal/plan, evidence, audit).</div>
          <div class="lane-row">
            <button data-action="connectDesktopApp" type="button">Generate desktop-app config</button>
          </div>
          ${desktopBootstrapMarkup}
        </div>
      </article>`;
}

export function renderSetupPanel(ctx) {
  const { tailnet, phoneUrl, browserPaired, tokenConfigured, phoneQr, accessModeSummary, accessModeOptions, privateSettings, authSessionRows } = ctx;
  return `
      <article class="card control-card setup-wizard" id="section-setup" data-panel-card="setup">
        <div class="card-kicker">First-run wizard</div>
        <h3>Connect phone or PWA</h3>
        <p class="muted">The secure flow is tailnet access first, then Orca pairing. Tailnet membership alone is not enough to control the dashboard.</p>
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
              <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy link</button>
              <button class="secondary" data-action="createPairingCode" type="button">Create one-time code</button>
            </div>
            ${shell.lastPairing ? `
              <div class="pairing-code-box">
                <div class="tiny muted">One-time pairing code. Do not screenshot or paste into URLs.</div>
                <strong>${safeText(shell.lastPairing.code)}</strong>
                <span>Expires ${safeText(formatRelative(shell.lastPairing.expiresAt))}</span>
              </div>
            ` : '<div class="tiny muted">Create a pairing code from the trusted workstation browser, then enter it on the phone access screen.</div>'}
          </div>
          <div class="qr-wrap">${phoneQr}<span>Scan from trusted device</span></div>
        </div>
        <details class="disclosure compact-disclosure" open>
          <summary><span>HTTP vs HTTPS Serve</span><small>${safeText(accessModeSummary)}</small></summary>
          <div class="disclosure-body">
            <p>HTTP over Tailscale is private inside the encrypted tailnet and avoids certificate transparency metadata. HTTPS Serve improves Safari/PWA behavior and secure-cookie semantics, but can publish the machine/tailnet DNS name in public certificate logs. Funnel remains off-limits for v1.</p>
            <form id="setup-private-access-settings-form">
              <label>Default access mode
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
              <label><input type="checkbox" name="pwaMode" ${checked(privateSettings.pwaMode !== 'disabled')}> Enable PWA static shell</label>
              <button type="submit">Save access settings</button>
            </form>
            <div class="lane-row">
              <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve --bg http://127.0.0.1:3000" type="button">Copy HTTP Serve</button>
              <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve --bg --https=443 http://127.0.0.1:3000" type="button">Copy HTTPS Serve</button>
              <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve reset" type="button">Copy disable Serve</button>
            </div>
          </div>
        </details>
        <details class="disclosure compact-disclosure" open>
          <summary><span>Paired devices</span><small>${safeText((shell.authSessions || []).length)} session${(shell.authSessions || []).length === 1 ? '' : 's'}</small></summary>
          <div class="disclosure-body">${authSessionRows || '<div class="muted">No paired browser sessions yet.</div>'}</div>
        </details>
        <details class="disclosure compact-disclosure" open>
          <summary><span>Add to Home Screen</span><small>PWA</small></summary>
          <div class="disclosure-body">
            <ol class="setup-list">
              <li>Open the private URL in Safari on iPhone or Chrome on Android.</li>
              <li>Pair the browser once with a one-time code from this workstation.</li>
              <li>iPhone: tap Share, then Add to Home Screen. Android: tap browser menu, then Install app or Add to Home screen.</li>
              <li>Later opens reuse the paired browser session until it expires or is revoked.</li>
            </ol>
          </div>
        </details>
      </article>`;
}

export function renderTokenPanel(ctx) {
  const { tokenConfigured, browserPaired, authSessionRows } = ctx;
  return `
      <article class="card control-card" id="section-token" data-panel-card="token">
        <h3>API token</h3>
        <div class="tiny muted">${tokenConfigured ? 'Token configured for this tab.' : 'No raw token stored in this tab.'}</div>
        <div class="tiny">Browser session: <span class="tag ${browserPaired ? 'ok' : 'warn'}">${browserPaired ? 'paired' : 'not paired'}</span></div>
        <p class="muted">Use browser pairing for phone/PWA access when possible. It stores an HttpOnly session cookie instead of exposing the API token to page scripts.</p>
        <label>Token
          <input id="api-token-input" type="password" placeholder="Enter token" autocomplete="off" />
        </label>
        <div class="lane-row">
          <button class="secondary" data-action="setApiToken" type="button">Save token</button>
          <button class="secondary" data-action="clearApiToken" type="button">Clear token</button>
          <button class="secondary" data-action="createPairingCode" type="button">Create pairing code</button>
          ${browserPaired ? '<button class="secondary" data-action="logoutBrowserSession" type="button">Log out paired browser</button>' : ''}
        </div>
        <details class="disclosure compact-disclosure" open>
          <summary><span>Paired devices</span><small>${safeText((shell.authSessions || []).length)} session${(shell.authSessions || []).length === 1 ? '' : 's'}</small></summary>
          <div class="disclosure-body">${authSessionRows || '<div class="muted">No paired browser sessions yet.</div>'}</div>
        </details>
        <details class="disclosure compact-disclosure">
          <summary><span>Packaged app credential storage</span><small>Tauri scope</small></summary>
          <div class="disclosure-body tiny muted">In the future desktop app, the server API token should be generated on first run and stored in the OS credential store by the app shell. Browser/PWA users should use pairing; API tokens are for automation and emergency manual setup.</div>
        </details>
        <details class="disclosure">
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
      </article>`;
}

export function renderAccessPanel(ctx) {
  const { accessModeSummary, accessModeOptions, privateSettings, phoneUrl, phoneQr, authSessionRows } = ctx;
  return `
      <article class="card control-card" id="section-settings-access" data-panel-card="system">
        <details class="disclosure" open>
          <summary>
            <span>Access and paired devices</span>
            <small>${safeText(accessModeSummary)}</small>
          </summary>
          <div class="disclosure-body">
            <p class="muted">Settings is the trusted workstation surface for HTTP/HTTPS preference, one-time pairing, browser session revocation, and token rotation. Unpaired phone and laptop browsers only see the pairing screen.</p>
            <form id="settings-private-access-settings-form">
              <label>Default access mode
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
              <label><input type="checkbox" name="pwaMode" ${checked(privateSettings.pwaMode !== 'disabled')}> Enable PWA static shell</label>
              <button type="submit">Save access settings</button>
            </form>
            <div class="onboarding-card mini">
              <div>
                <strong>Pair a phone or laptop</strong>
                <div class="tiny muted">Create a fresh code only from this authenticated workstation, then enter it on the unpaired device. Codes are one-time use and expire quickly.</div>
                <div class="lane-row">
                  <button class="secondary" data-action="createPairingCode" type="button">Create one-time code</button>
                  <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy private URL</button>
                </div>
                ${shell.lastPairing ? `
                  <div class="pairing-code-box">
                    <div class="tiny muted">One-time pairing code. Do not screenshot or paste into URLs.</div>
                    <strong>${safeText(shell.lastPairing.code)}</strong>
                    <span>Expires ${safeText(formatRelative(shell.lastPairing.expiresAt))}</span>
                  </div>
                ` : ''}
              </div>
              <div class="qr-wrap">${phoneQr}<span>Trusted setup QR</span></div>
            </div>
            <details class="disclosure compact-disclosure" open>
              <summary><span>Paired devices</span><small>${safeText((shell.authSessions || []).length)} active</small></summary>
              <div class="disclosure-body">
                <p class="tiny muted">Rotate session state by revoking old devices, clearing this browser token if needed, then creating a new one-time pairing code.</p>
                ${authSessionRows || '<div class="muted">No paired browser sessions yet.</div>'}
              </div>
            </details>
          </div>
        </details>
      </article>`;
}

export function renderExecutorProfilesPanel(ctx) {
  const { profileRows } = ctx;
  return `
      <article class="card control-card" id="section-system" data-panel-card="system">
        <details class="disclosure">
          <summary>
            <span>Executor profiles</span>
            <small>Defaults, binaries, workdirs</small>
          </summary>
          <div class="disclosure-body">${profileRows || '<div class="muted">No executor profiles loaded yet.</div>'}</div>
        </details>
      </article>`;
}

export function renderCapturePanel(ctx) {
  const { captureSummary, captureDetail, captureReady } = ctx;
  return `
      <article class="card control-card" data-panel-card="system">
        <details class="disclosure">
          <summary>
            <span>Evidence capture backend</span>
            <small>${safeText(captureSummary)}</small>
          </summary>
          <div class="disclosure-body">
            <div class="tiny muted">${safeText(captureDetail)}</div>
            <div class="lane-row">
              <button class="secondary" data-action="setupCapture" type="button">${captureReady ? 'Reconfigure capture' : 'Enable screenshots &amp; video'}</button>
            </div>
            <div class="tiny muted">Setup is governed: it runs a dry-run first, then installs only after you confirm. The desktop app can also capture screenshots natively (no download) on macOS.</div>
          </div>
        </details>
      </article>`;
}

export function renderCliHealthPanel(ctx) {
  const { cliRows } = ctx;
  return `
      <article class="card control-card" data-panel-card="system">
        <details class="disclosure">
          <summary>
            <span>Executor CLI health and updates</span>
            <small>Codex, Claude, reinstall dry-runs</small>
          </summary>
          <div class="disclosure-body">${cliRows || '<div class="muted">No CLI data yet.</div>'}</div>
        </details>
      </article>`;
}

export function renderCleanupPanel(ctx) {
  const { schedule, cleanupNext, scheduleApiUrl, scheduleRunApiUrl } = ctx;
  return `
      <article class="card control-card" id="section-cleanup" data-panel-card="cleanup">
        <details class="disclosure">
          <summary>
            <span>Artifact cleanup schedule</span>
            <small>${schedule.enabled ? `Enabled · next ${safeText(cleanupNext)}` : 'Disabled'}</small>
          </summary>
          <div class="disclosure-body">
        <div class="tiny muted">Status: ${schedule.enabled ? `Enabled · next run ${cleanupNext}` : 'Disabled'}</div>
        <form id="cleanup-schedule-form" data-url="${scheduleApiUrl}" data-action-source="cleanup-schedule">
          <label><input type="checkbox" name="enabled" ${schedule.enabled ? 'checked' : ''}> Enable periodic cleanup</label>
          <label>Interval hours
            <input name="intervalHours" type="number" min="1" max="720" step="0.5" value="${safeText(schedule.intervalHours || 24)}" />
          </label>
        <label>Prune older than (days)
            <input name="olderThanDays" type="number" min="1" placeholder="default session retention" value="${safeText(schedule.olderThanDays || '')}" />
          </label>
          <label>Target session id (optional)
            <input name="sessionId" placeholder="leave blank for all sessions" value="${safeText(schedule.sessionId || '')}" />
          </label>
          <label><input type="checkbox" name="dryRun" ${schedule.dryRun ? 'checked' : ''}> Dry run mode</label>
          <button type="submit">Save cleanup schedule</button>
        </form>
        <div class="lane-row" style="margin-top:0.65rem">
          <button class="secondary" data-action="cleanupArtifactsRunNow" data-url="${scheduleRunApiUrl}" type="button">Run cleanup now</button>
        </div>
          </div>
        </details>
      </article>`;
}

export function renderMcpPanel(ctx) {
  const { mcpTools, mcpOptions } = ctx;
  return `
      <article class="card control-card" id="section-mcp" data-panel-card="mcp">
        <details class="disclosure">
          <summary>
            <span>Custom MCP tools</span>
            <small>${safeText(mcpTools.length)} configured</small>
          </summary>
          <div class="disclosure-body">
        <div class="tiny muted">Configured tools: ${safeText(mcpTools.length)}</div>
        <div>${mcpOptions || '<div class="muted">No MCP tools yet.</div>'}</div>
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
          <label><input type="checkbox" name="enabled" checked> enabled</label>
          <button type="submit">Add MCP tool</button>
        </form>
          </div>
        </details>
      </article>`;
}

export function renderPrivateAccessPanel(ctx) {
  const { accessModeSummary, tailnet, accessModeOptions, privateSettings, phoneUrl, commandRows, privateTargets, targetRows } = ctx;
  return `
      <article class="card control-card" id="section-private-access" data-panel-card="private-access">
        <details class="disclosure" open>
          <summary>
            <span>Private access</span>
            <small>${safeText(accessModeSummary)} · ${safeText(tailnet.setupStatus || 'setup_pending')}</small>
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
            <p>HTTP over Tailscale is private and encrypted by Tailscale but may not enable browser secure-context APIs. HTTPS Serve enables PWA features but can expose .ts.net hostname metadata through certificate transparency. Funnel is forbidden.</p>
            <form id="private-access-settings-form">
              <label>Default access mode
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
              <label><input type="checkbox" name="pwaMode" ${checked(privateSettings.pwaMode !== 'disabled')}> Enable PWA static shell</label>
              <button type="submit">Save private access settings</button>
            </form>
            <details class="disclosure compact-disclosure" open>
              <summary>
                <span>Phone URL and HTTPS wizard</span>
                <small>Serve, not Funnel</small>
              </summary>
              <div class="disclosure-body">
                <div class="access-command">
                  <div>
                    <strong>Current phone URL</strong>
                    <div class="tiny muted">Use this from a device on the same tailnet.</div>
                    <code>${safeText(phoneUrl)}</code>
                  </div>
                  <button class="secondary" data-action="copyPhoneUrl" data-url="${safeAttr(phoneUrl)}" type="button">Copy</button>
                </div>
                <div class="card">
                  <h3>HTTPS Serve decision</h3>
                  <p>HTTPS Serve improves Safari/PWA behavior and secure-cookie semantics. It can publish the machine/tailnet DNS name in certificate transparency logs. Rotate or rename the host first if hostname privacy matters.</p>
                  <div class="lane-row">
                    <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve --bg --https=443 http://127.0.0.1:3000" type="button">Copy HTTPS Serve command</button>
                    <button class="secondary" data-action="copyPrivateAccessCommand" data-command="tailscale serve reset" type="button">Copy disable command</button>
                  </div>
                </div>
                <div class="card">
                  <h3>Rotate or rename hostname</h3>
                  <p>Rename the device in Tailscale admin before enabling HTTPS certs if you do not want the current Mac name in certificate metadata. Tailnet DNS suffix rotation is an admin-level Tailscale setting and may break existing links.</p>
                  <div class="tiny muted">Orca does not run these changes automatically. Make the change in Tailscale, then update the private access target URL here.</div>
                </div>
              </div>
            </details>
            <details class="disclosure compact-disclosure">
              <summary>
                <span>Dry-run setup commands</span>
                <small>No command runs from here</small>
              </summary>
              <div class="disclosure-body">${commandRows || '<div class="muted">No setup commands available.</div>'}</div>
            </details>
            <details class="disclosure compact-disclosure" open>
              <summary>
                <span>Project URLs</span>
                <small>${safeText(privateTargets.length)} target${privateTargets.length === 1 ? '' : 's'}</small>
              </summary>
              <div class="disclosure-body">
                ${targetRows || '<div class="muted">No private access targets yet.</div>'}
                <form id="private-access-target-form">
                  <label>Label
                    <input name="label" placeholder="Local dev server" required />
                  </label>
                  <label>Mode
                    <select name="mode">
                      <option value="local">Local</option>
                      <option value="tailnet-http">Tailscale HTTP</option>
                      <option value="tailnet-https-serve">Tailscale HTTPS Serve</option>
                    </select>
                  </label>
                  <label>Local URL
                    <input name="localUrl" placeholder="http://127.0.0.1:3000" required />
                  </label>
                  <label>Tailnet HTTP URL
                    <input name="tailnetHttpUrl" placeholder="http://device.tailnet.ts.net:3000" />
                  </label>
                  <label>HTTPS Serve URL
                    <input name="httpsServeUrl" placeholder="https://device.tailnet.ts.net" />
                  </label>
                  <label><input type="checkbox" name="favorite"> Favorite</label>
                  <button type="submit">Add project URL</button>
                </form>
              </div>
            </details>
          </div>
        </details>
      </article>`;
}

export function renderProvidersPanel(ctx) {
  const { providerProfiles, providerCatalog, providerRows } = ctx;
  return `
      <article class="card control-card" id="section-providers" data-panel-card="providers">
        <details class="disclosure" open>
          <summary>
            <span>Provider profiles</span>
            <small>${safeText(providerProfiles.length)} configured · credentials ${safeText(providerCatalog.credentialBackend || 'unknown')}</small>
          </summary>
          <div class="disclosure-body">
            <p>Profiles store non-secret config only. Dashboard secret entry stores into the server credential backend and never echoes values back. Installs and updates are plan-only by default.</p>
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
          </div>
        </details>
      </article>`;
}

export function renderEffectiveSettingsPanel(ctx) {
  const { effectiveSummary, effectiveSources, effectiveSourcesText, effectiveSettingsText } = ctx;
  return `
      <article class="card control-card" id="section-effective-settings" data-panel-card="effective-settings">
        <details class="disclosure" open>
          <summary>
            <span>Effective settings</span>
            <small>global -> project -> session -> lane -> action</small>
          </summary>
          <div class="disclosure-body">
            <p class="muted">Resolved provider, spawn, critique, evidence, cleanup, notification, private-access, URL-opening, and mobile policy. Secret values are never part of this response.</p>
            <div class="access-summary">
              <div class="stat">
                <b>${safeText(effectiveSummary.spawn?.approvedCapacity ?? 2)}</b>
                <span>Approved capacity</span>
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
      <article class="card control-card" id="section-notifications" data-panel-card="notifications">
        <details class="disclosure" open>
          <summary>
            <span>Notifications</span>
            <small>${safeText(unreadNotifications)} unread · browser ${safeText(browserPermission)}</small>
          </summary>
          <div class="disclosure-body">
            <p class="muted">Notifications are short, secret-free status updates with safe deep links. Browser notifications require permission and are optional.</p>
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
      <article class="card control-card" id="section-backup" data-panel-card="backup">
        <details class="disclosure" open>
          <summary>
            <span>Backup and support</span>
            <small>Local-only export · redacted support bundle</small>
          </summary>
          <div class="disclosure-body">
            <p class="muted">App exports include projects, sessions, lane metadata, provider config, private-access targets, MCP tools, cleanup schedule, and notification settings. They exclude secret values, auth sessions, pairing codes, artifacts, logs, screenshots, videos, and traces.</p>
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
              <a href="https://github.com/alex2481kobe/orca/blob/main/LICENSE" target="_blank" rel="noreferrer noopener">AGPL License</a>
            </div>
          </div>
        </details>
      </article>`;
}

export function renderCreateProjectPanel() {
  return `
      <div class="card control-card" data-panel-card="create">
        <details class="disclosure">
          <summary>
            <span>Create project</span>
            <small>Add a new command surface</small>
          </summary>
          <div class="disclosure-body">
        <form id="create-project-form">
          <label>Project name
            <input name="name" required placeholder="Project name" />
          </label>
          <label>Slug
            <input name="slug" placeholder="optional" />
          </label>
          <label>Local quick link
            <input name="quickLink" placeholder="http://localhost:3000" />
          </label>
          <button type="submit">Create project</button>
        </form>
          </div>
        </details>
      </div>`;
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
      <article class="card" data-panel-card="cleanup">
        <h3>System actions</h3>
        <button
          class="secondary"
          data-action="cleanupArtifacts"
          data-url="${artifactCleanupUrl}"
          type="button"
        >Run artifact cleanup</button>
      </article>`;
}
