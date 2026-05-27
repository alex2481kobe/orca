const shell = {
  route: {
    projectSlug: null,
    sessionId: null,
    laneId: null,
  },
  projects: [],
  sessions: [],
  lanes: [],
  policy: {},
  alerts: [],
  mobileManifest: null,
  apiToken: '',
};

const refs = {
  breadcrumbs: document.getElementById('breadcrumbs'),
  alerts: document.getElementById('alerts'),
  actions: document.getElementById('mainActions'),
  content: document.getElementById('content'),
};
const API_TOKEN_STORAGE_KEY = 'commandDeckApiToken';

function parseRoute() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const route = { projectSlug: null, sessionId: null, laneId: null };
  if (parts.length >= 2 && parts[0] === 'projects') {
    route.projectSlug = parts[1];
    if (parts[2] === 'sessions' && parts[3]) {
      route.sessionId = parts[3];
      if (parts[4] === 'lanes' && parts[5]) {
        route.laneId = parts[5];
      }
    }
  }
  return route;
}

function initializeApiToken() {
  const saved = window.sessionStorage.getItem(API_TOKEN_STORAGE_KEY);
  shell.apiToken = saved || '';
  const params = new URLSearchParams(window.location.search);
  const queryToken = (params.get('apiToken') || params.get('token') || '').trim();
  if (queryToken) {
    shell.apiToken = queryToken;
    window.sessionStorage.setItem(API_TOKEN_STORAGE_KEY, queryToken);
  }
}

function setApiToken(token) {
  const nextToken = (token || '').trim();
  shell.apiToken = nextToken;
  if (nextToken) {
    window.sessionStorage.setItem(API_TOKEN_STORAGE_KEY, nextToken);
  } else {
    window.sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
  }
}

function safeText(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function stateBadge(state) {
  const map = {
    queued: ['Queued', 'warn'],
    starting: ['Starting', 'warn'],
    running: ['Running', 'ok'],
    done: ['Done', 'ok'],
    stopped: ['Stopped', 'bad'],
    failed: ['Failed', 'bad'],
  };
  const [label, tone] = map[state] || [state, 'warn'];
  return `<span class="tag ${tone}">${label}</span>`;
}

function laneDetailRoute(project, session, lane) {
  if (!project || !session || !lane) return '';
  return lane.route || `/projects/${project.slug}/sessions/${session.id}/lanes/${lane.id}`;
}

function formatMeta(timeString) {
  if (!timeString) return 'n/a';
  return new Date(timeString).toLocaleTimeString();
}

function renderAlert(text, level = 'info') {
  refs.alerts.innerHTML = `<div class="card ${level}">${safeText(text)}</div>`;
  clearTimeout(renderAlert.timer);
  renderAlert.timer = setTimeout(() => {
    if (refs.alerts) refs.alerts.innerHTML = '';
  }, 3500);
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (shell.apiToken) {
    headers['x-commanddeck-token'] = shell.apiToken;
  }
  const resp = await fetch(path, {
    headers,
    ...options,
    body: options.body ? JSON.stringify(options.body) : options.body,
  });
  const bodyText = await resp.text();
  const bodyJson = bodyText ? JSON.parse(bodyText) : null;
  return { ok: resp.ok, status: resp.status, data: bodyJson };
}

function renderBreadcrumbs(project, session) {
  const links = ['<a href="/">Home</a>'];
  if (project) {
    links.push(`<a href="${project.route}">${safeText(project.name)}</a>`);
  }
  if (session) {
    links.push(`<a href="${session.route}">${safeText(session.name)}</a>`);
  }
  refs.breadcrumbs.innerHTML = `<div>${links.join(' / ')}</div>`;
}

function renderHome() {
  const artifactCleanupUrl = shell.mobileManifest?.artifactCleanupUrl || '/api/artifacts/cleanup';
  const tokenConfigured = Boolean(shell.apiToken);
  const cards = shell.projects.map((project) => {
    const quickLinks = project.quickLinks.map((quick) => `
      <div><a href="${safeText(quick.url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.label)}</a></div>
    `).join('');
    return `
      <article class="card">
        <h3>${safeText(project.name)}</h3>
        <p>Slug: ${safeText(project.slug)}</p>
        <p>Route: <a href="${project.route}">${project.route}</a></p>
        <div class="lane-row">${quickLinks || '<div class="muted">No quick links yet.</div>'}</div>
        <div class="lane-row">
          <a class="button-secondary" href="${project.route}">Open project</a>
        </div>
      </article>
    `;
  }).join('');

  refs.content.innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <b>${shell.projects.length}</b>
        <span>Projects</span>
      </div>
      <div class="stat">
        <b>${shell.sessions.length}</b>
        <span>Sessions</span>
      </div>
      <div class="stat">
        <b>${shell.lanes.length}</b>
        <span>Lanes</span>
      </div>
    </div>
    <section class="grid-2">
      <article class="card">
        <h3>API token</h3>
        <div class="tiny muted">${tokenConfigured ? 'Configured for mutating requests.' : 'No token configured.'}</div>
        <label>Token
          <input id="api-token-input" type="password" placeholder="Enter token" autocomplete="off" />
        </label>
        <div class="lane-row">
          <button class="secondary" data-action="setApiToken" type="button">Save token</button>
          <button class="secondary" data-action="clearApiToken" type="button">Clear token</button>
        </div>
      </article>
      <div class="card">
        <h3>Create project</h3>
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
          <label><input type="checkbox" name="approved" /> Mark as approved (high-risk control)</label>
          <button type="submit">Create project</button>
        </form>
      </div>
      <div class="card">
        <h3>Project list</h3>
        <div class="card-grid">${cards || '<div class="muted">No projects yet.</div>'}</div>
      </div>
      <article class="card">
        <h3>System actions</h3>
        <button
          class="secondary"
          data-action="cleanupArtifacts"
          data-url="${artifactCleanupUrl}"
          type="button"
        >Run artifact cleanup</button>
      </article>
    </section>
  `;
}

function renderProject(project) {
  const sessionsMarkup = shell.sessions.map((session) => {
    const route = session.route;
    return `
      <article class="card">
        <h3>${safeText(session.name)}</h3>
        <p>Leader: ${safeText(session.leader)}</p>
        <p>Concurrency limit: ${session.laneConcurrencyLimit}</p>
        <a href="${route}" class="secondary">Open session</a>
      </article>
    `;
  }).join('');

  refs.content.innerHTML = `
    <section>
      <div class="card">
        <h3>${safeText(project.name)} project</h3>
        <p>Quick links and dev routes can be added directly in the session lane workflows.</p>
        <div class="lane-row">
          ${project.quickLinks.map((quick) => `<a href="${safeText(quick.url)}" target="_blank" rel="noopener noreferrer">${safeText(quick.label)}</a>`).join('') || '<span class="muted">No quick links.</span>'}
        </div>
      </div>
      <div class="grid-2">
        <article class="card">
          <h3>Create session</h3>
          <form id="create-session-form" data-project-id="${project.id}">
            <label>Session name
              <input name="name" required />
            </label>
            <label>Leader
              <select name="leader">
                <option value="codex">Codex-led</option>
                <option value="claude">Claude-led</option>
                <option value="mixed">Mixed</option>
              </select>
            </label>
            <label>Max parallel lanes
              <input name="laneConcurrencyLimit" type="number" min="1" max="4" value="1" />
            </label>
            <button type="submit">Create session</button>
          </form>
        </article>
        <article class="card">
          <h3>Sessions</h3>
          <div class="card-grid">${sessionsMarkup || '<div class="muted">No sessions yet.</div>'}</div>
        </article>
      </div>
    </section>
  `;
}

function renderLaneCard(lane) {
  const artifactsLink = `/api/lanes/${lane.id}/artifacts`;
  const evidenceLatestUrl = `/api/lanes/${lane.id}/evidence/latest`;
  const stopButton = ['running', 'starting', 'queued'].includes(lane.state)
    ? `<button data-action="stopLane" data-lane-id="${lane.id}" type="button">Stop lane</button>` : '';
  const retryButton = ['failed', 'stopped'].includes(lane.state)
    ? `<button class="secondary" data-action="retryLane" data-lane-id="${lane.id}" type="button">Retry lane</button>` : '';
  const laneLink = lane.route ? `<a class="secondary" href="${safeText(lane.route)}">Lane detail</a>` : '';
  return `
    <article class="lane-list-item">
      <div class="row">
        <h4>${safeText(lane.title)}</h4>
        ${stateBadge(lane.state)}
      </div>
      <p>${safeText(lane.taskDescription || 'No task description')}</p>
      <div class="tiny">
        Executor: ${safeText(lane.executorType)} / Owner: ${safeText(lane.owner)} / Started: ${formatMeta(lane.startedAt)} / Heartbeat: ${formatMeta(lane.heartbeatAt)}
      </div>
      <div class="lane-row">
        ${stopButton}
        ${retryButton}
        ${laneLink}
        <button class="secondary" data-action="captureEvidence" data-lane-id="${lane.id}" type="button">Capture evidence</button>
        <button class="secondary" data-action="clearEvidence" data-lane-id="${lane.id}" type="button">Clear evidence</button>
        <button class="secondary" data-action="auditLane" data-lane-id="${lane.id}" type="button">Audit now</button>
        <button class="secondary" data-action="showArtifacts" data-lane-id="${lane.id}" type="button">Artifacts</button>
        <a class="secondary" href="${artifactsLink}" target="_blank" rel="noopener noreferrer">Artifact API</a>
        <a class="secondary" href="${evidenceLatestUrl}" target="_blank" rel="noopener noreferrer">Latest evidence</a>
      </div>
      <div class="tiny muted">Last evidence: ${safeText(lane.lastEvidenceCaptureAt || 'never')} (${safeText(lane.lastEvidence?.status || 'not captured')})</div>
      <div class="muted tiny">Path: ${safeText(lane.artifactPath || '')}</div>
      <div id="lane-artifacts-${lane.id}" class="tiny"></div>
    </article>
  `;
}

function renderSession(project, session) {
  const laneList = shell.lanes.map((lane) => renderLaneCard(lane)).join('');
  refs.content.innerHTML = `
    <section>
      <div class="card">
        <h3>${safeText(session.name)}</h3>
        <p>Project: ${safeText(project.name)} — leader ${safeText(session.leader)}</p>
      </div>
      <div class="grid-2">
        <article class="card">
          <h3>Create lane</h3>
          <form id="create-lane-form" data-session-id="${session.id}">
            <label>Title
              <input name="title" required />
            </label>
            <label>Task description
              <textarea name="taskDescription" rows="3"></textarea>
            </label>
            <label>Command (for codex/claude lanes)
              <input name="command" placeholder="e.g., codex run --help" />
            </label>
            <label>Command args
              <input name="commandArgs" placeholder="quoted optional args or tokenized words" />
            </label>
            <label>Executor binary override
              <input name="executorBinary" placeholder="e.g., codex, claude, node, ./scripts/run.sh" />
            </label>
            <label>Working directory
              <input name="workdir" placeholder="optional absolute path" />
            </label>
            <label>Executor
              <select name="executorType">
                <option value="mock">mock</option>
                <option value="codex">codex</option>
                <option value="claude">claude</option>
              </select>
            </label>
            <label><input type="checkbox" name="approved" /> explicit approval override</label>
            <button type="submit">Queue lane</button>
          </form>
        </article>
        <article class="card">
          <h3>Session actions</h3>
          <button class="secondary" data-action="auditDone" data-session-id="${session.id}" type="button">Audit all done lanes</button>
          <button data-action="refresh" type="button">Refresh</button>
        </article>
      </div>
      <section class="card">
        <h3>Lane queue</h3>
        <div class="card-grid">${laneList || '<div class="muted">No lanes yet.</div>'}</div>
      </section>
    </section>
  `;
}

function renderLane(project, session, lane) {
  if (!lane) {
    return `
      <section>
        <div class="card">
          <h3>Lane not found</h3>
          <p>The selected lane is not in this session yet.</p>
          <a class="secondary" href="${session.route}">Back to session</a>
        </div>
      </section>
    `;
  }

  const stopButton = ['running', 'starting', 'queued'].includes(lane.state)
    ? `<button data-action="stopLane" data-lane-id="${lane.id}" type="button">Stop lane</button>` : '';
  const retryButton = ['failed', 'stopped'].includes(lane.state)
    ? `<button class="secondary" data-action="retryLane" data-lane-id="${lane.id}" type="button">Retry lane</button>` : '';
  const artifactUrl = `/api/lanes/${lane.id}/artifacts`;
  const evidenceUrl = `/api/lanes/${lane.id}/evidence`;
  const evidenceLatestUrl = `/api/lanes/${lane.id}/evidence/latest`;
  const laneLogs = Array.isArray(lane.logs) ? lane.logs.slice(-8) : [];

  return `
    <section>
      <div class="card">
        <p><a href="${session.route}" class="secondary">Back to session</a></p>
        <h3>${safeText(lane.title)} (lane)</h3>
        <p>${safeText(lane.taskDescription || 'No task description')}</p>
        <div class="tiny muted">Route: ${safeText(laneDetailRoute(project, session, lane))}</div>
        <div class="tiny">Owner: ${safeText(lane.owner)} / Executor: ${safeText(lane.executorType)} / State: ${safeText(lane.state)}</div>
        <div class="tiny">Created: ${formatMeta(lane.createdAt)} / Started: ${formatMeta(lane.startedAt)} / Completed: ${formatMeta(lane.completedAt)}</div>
      </div>
      <div class="card">
        <h4>Actions</h4>
        <div class="lane-row">
          ${stopButton}
          ${retryButton}
          <button class="secondary" data-action="captureEvidence" data-lane-id="${lane.id}" type="button">Capture evidence</button>
          <button class="secondary" data-action="clearEvidence" data-lane-id="${lane.id}" type="button">Clear evidence</button>
          <button class="secondary" data-action="auditLane" data-lane-id="${lane.id}" type="button">Audit now</button>
          <button class="secondary" data-action="showArtifacts" data-lane-id="${lane.id}" type="button">Artifacts</button>
          <a class="secondary" href="${artifactUrl}" target="_blank" rel="noopener noreferrer">Artifacts API</a>
          <a class="secondary" href="${evidenceUrl}" target="_blank" rel="noopener noreferrer">Evidence API</a>
          <a class="secondary" href="${evidenceLatestUrl}" target="_blank" rel="noopener noreferrer">Latest evidence API</a>
        </div>
      </div>
      <div class="card">
        <h4>Recent lane logs</h4>
        <pre>${safeText(JSON.stringify(laneLogs, null, 2))}</pre>
      </div>
      <div class="card">
        <h4>Last evidence</h4>
        <div class="tiny muted">Captured: ${safeText(lane.lastEvidenceCaptureAt || 'never')}</div>
        <div class="tiny muted">Result: ${safeText(lane.lastEvidence?.status || 'not captured')}</div>
      </div>
      <div id="lane-artifacts-${lane.id}" class="card tiny"></div>
    </section>
  `;
}

function renderAuditLog() {
  api('/api/audit/events?status=pending')
    .then(({ data }) => {
      if (!data || !Array.isArray(data)) return;
      if (!data.length) return;
      const rows = data.map((event) => {
        const project = shell.projects.find((value) => value.id === event.projectId);
        const laneRoute = project && event.sessionId && event.laneId
          ? `${project.route}/sessions/${event.sessionId}/lanes/${event.laneId}`
          : '';
        return `
          <article class="card">
            <p><strong>${safeText(event.summary || event.type || 'Audit event')}</strong></p>
            <div class="tiny">Type: ${safeText(event.type || 'unknown')}</div>
            <div class="tiny">Project: ${safeText(event.projectId || 'unknown')}</div>
            <div class="tiny">Lane: ${safeText(event.laneId || 'n/a')}</div>
            ${laneRoute ? `<a class="secondary" href="${laneRoute}">Open lane</a>` : ''}
            <div class="lane-row" style="margin-top:0.75rem">
              <button class="secondary" data-action="ackAuditEvent" data-event-id="${safeText(event.id)}" type="button">Mark reviewed</button>
            </div>
          </article>
        `;
      }).join('');
      refs.actions.innerHTML = `<div class="card"><h3>Open audit queue</h3><div class="card-grid">${rows}</div></div>`;
    })
    .catch(() => {});
}

function render() {
  const project = shell.projects.find((value) => value.slug === shell.route.projectSlug || value.id === shell.route.projectSlug);
  const sessions = project ? shell.sessions : [];
  const session = sessions.find((value) => value.id === shell.route.sessionId);
  const lane = shell.lanes.find((value) => value.id === shell.route.laneId);

  renderBreadcrumbs(project, session);
  if (!project) {
    renderHome();
  } else if (!session) {
    renderProject(project);
  } else if (shell.route.laneId) {
    renderLane(project, session, lane);
  } else {
    renderSession(project, session);
  }
  renderAuditLog();
}

function renderMobileManifest() {
  api('/api/mobile/manifest')
    .then(({ data }) => {
      if (!data) return;
      shell.mobileManifest = data;
    })
    .catch(() => {});
}

async function refresh() {
  shell.route = parseRoute();
  shell.alerts = [];
  const policyResp = await api('/api/policy');
  if (policyResp.ok && policyResp.data) {
    shell.policy = policyResp.data.policies;
  }

  const projectsResp = await api('/api/projects');
  shell.projects = projectsResp.ok && Array.isArray(projectsResp.data) ? projectsResp.data : [];
  const allSessions = [];
  const allLanes = [];
  for (const project of shell.projects) {
    const sessionsResp = await api(`/api/projects/${project.id}/sessions`);
    if (sessionsResp.ok && Array.isArray(sessionsResp.data)) {
      allSessions.push(...sessionsResp.data);
    }
  }
  shell.sessions = allSessions;

  const project = shell.projects.find((value) => value.slug === shell.route.projectSlug || value.id === shell.route.projectSlug);
  if (project) {
    const sessions = await api(`/api/projects/${project.id}/sessions`);
    if (sessions.ok && Array.isArray(sessions.data)) {
      shell.sessions = sessions.data;
      if (shell.route.sessionId) {
        const selected = sessions.data.find((session) => session.id === shell.route.sessionId);
        if (selected) {
          const lanesResp = await api(`/api/sessions/${selected.id}/lanes`);
          shell.lanes = lanesResp.ok && Array.isArray(lanesResp.data) ? lanesResp.data : [];
        } else {
          shell.lanes = [];
        }
      } else {
        shell.lanes = [];
      }
    }
  }
  render();
}

function buildApprovedBody(formData, extras = {}) {
  const body = { ...extras };
  for (const [key, value] of Object.entries(formData)) {
    body[key] = value;
  }
  body.approved = body.approved === true || body.approved === 'on';
  body.actor = 'dashboard';
  return body;
}

function toObj(form) {
  const data = new FormData(form);
  const output = {};
  for (const [key, value] of data.entries()) {
    output[key] = value;
  }
  return output;
}

async function showArtifacts(laneId) {
  const response = await api(`/api/lanes/${laneId}/artifacts`);
  const target = document.getElementById(`lane-artifacts-${laneId}`);
  if (!target) return;
  if (!response.ok) {
    target.textContent = response.data?.error || 'Could not load artifacts.';
    return;
  }
  const files = response.data.files;
  if (!files.length) {
    target.textContent = 'No artifacts yet.';
    return;
  }
  target.innerHTML = files.map((file) => `<div><a href="${safeText(file.url)}" target="_blank">${safeText(file.name)}</a></div>`).join('');
}

async function handleCreateProject(event) {
  event.preventDefault();
  const payload = buildApprovedBody(toObj(event.currentTarget));
  const quick = (payload.quickLink || '').trim();
  const body = {
    name: payload.name,
    slug: payload.slug,
    owner: 'dashboard',
    approved: payload.approved,
    quickLinks: quick ? [{ label: 'Primary', url: quick }] : [],
  };
  const response = await api('/api/projects', { method: 'POST', body });
  if (response.ok) {
    renderAlert('Project created.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Project creation failed.', 'bad');
  }
}

async function handleCreateSession(event) {
  event.preventDefault();
  const projectId = event.currentTarget.dataset.projectId;
  const payload = toObj(event.currentTarget);
  const response = await api(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    body: {
      name: payload.name,
      leader: payload.leader,
      laneConcurrencyLimit: payload.laneConcurrencyLimit ? Number(payload.laneConcurrencyLimit) : 1,
      actor: 'dashboard',
    },
  });
  if (response.ok) {
    renderAlert('Session created.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Session creation failed.', 'bad');
  }
}

async function handleCreateLane(event) {
  event.preventDefault();
  const sessionId = event.currentTarget.dataset.sessionId;
  const payload = buildApprovedBody(toObj(event.currentTarget));
  const response = await api(`/api/sessions/${sessionId}/lanes`, {
    method: 'POST',
    body: {
      title: payload.title,
      taskDescription: payload.taskDescription,
      executorType: payload.executorType || 'mock',
      command: payload.command || null,
      commandArgs: payload.commandArgs || null,
      executorBinary: payload.executorBinary || null,
      workdir: payload.workdir || null,
      owner: 'dashboard',
      approved: payload.approved,
    },
  });
  if (response.ok) {
    renderAlert('Lane queued.');
    await refresh();
  } else if (response.data?.requiresApproval) {
    renderAlert('Approval required for this action.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Lane creation failed.', 'bad');
  }
}

async function handleLaneActions(event) {
  const action = event.currentTarget.dataset.action;
  const laneId = event.currentTarget.dataset.laneId;
  if (action === 'showArtifacts') {
    await showArtifacts(laneId);
    return;
  }
  const routeMap = {
    stopLane: { url: `/api/lanes/${laneId}/stop`, method: 'POST' },
    retryLane: { url: `/api/lanes/${laneId}/retry`, method: 'POST' },
    auditLane: { url: `/api/lanes/${laneId}/audit`, method: 'POST' },
    captureEvidence: { url: `/api/lanes/${laneId}/evidence`, method: 'POST' },
    clearEvidence: { url: `/api/lanes/${laneId}/evidence/clear`, method: 'POST' },
  };
  if (!routeMap[action]) return;
  const endpoint = routeMap[action];
  const policyKey = {
    stopLane: 'stopLane',
    retryLane: 'retryLane',
    auditLane: 'auditLane',
    captureEvidence: 'captureEvidence',
    clearEvidence: 'clearEvidenceArtifacts',
  }[action];
  const policy = shell.policy[policyKey] || { requiresApproval: false };
  const approved = policy.requiresApproval
    ? window.confirm('This is a higher-risk action. Continue?')
      : true;

  if (action === 'captureEvidence') {
    const providedUrl = window.prompt('Target URL for evidence capture (example: http://localhost:4173)');
    if (!providedUrl) {
      renderAlert('Evidence capture canceled.');
      return;
    }
    const modes = [];
    if (window.confirm('Capture screenshot?')) modes.push('screenshot');
    if (window.confirm('Capture trace (more expensive)?')) modes.push('trace');
    if (window.confirm('Capture video (heavier)?')) modes.push('video');
    const response = await api(endpoint.url, {
      method: endpoint.method,
      body: {
        approved,
        actor: 'dashboard',
        url: providedUrl,
        modes: modes.length ? modes : ['screenshot'],
      },
    });
    if (response.ok) {
      renderAlert(response.data?.captured ? 'Evidence captured.' : `Evidence attempt finished: ${response.data?.reason || 'queued/degraded'}`);
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required. Retry with approval enabled.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Evidence capture failed.', 'bad');
    }
    return;
  }

  if (action === 'clearEvidence') {
    const confirmed = window.confirm('Clear evidence files for this lane?');
    if (!confirmed) {
      renderAlert('Evidence clear canceled.');
      return;
    }
    const response = await api(endpoint.url, {
      method: endpoint.method,
      body: {
        approved,
        actor: 'dashboard',
      },
    });
    if (response.ok) {
      renderAlert('Evidence files cleared.');
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required. Retry with approval enabled.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not clear evidence.', 'bad');
    }
    return;
  }

  const response = await api(endpoint.url, {
    method: endpoint.method,
    body: {
      approved: action === 'auditLane' ? true : approved,
      actor: 'dashboard',
    },
  });
  if (response.ok) {
    if (action === 'auditLane' && response.data?.alreadyQueued) {
      renderAlert('Audit for this lane is already queued.');
    } else {
      renderAlert(`${action} submitted.`);
    }
    await refresh();
  } else if (response.data?.requiresApproval) {
    renderAlert('Approval required. Retry with approval enabled.', 'bad');
  } else {
    renderAlert(response.data?.error || `${action} failed.`, 'bad');
  }
}
}

async function handleAuditEventAction(event) {
  const eventId = event.currentTarget.dataset.eventId;
  const response = await api(`/api/audit/events/${eventId}/ack`, {
    method: 'POST',
    body: { actor: 'dashboard' },
  });
  if (response.ok) {
    renderAlert('Audit event marked reviewed.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not acknowledge audit event.', 'bad');
  }
}

async function handleSessionActions(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'refresh') {
    await refresh();
    return;
  }
  if (action === 'auditDone') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const response = await api(`/api/sessions/${sessionId}/audit-done-lanes`, {
      method: 'POST',
      body: { actor: 'dashboard', approved: true },
    });
    if (response.ok) {
      const queuedNew = response.data?.enqueuedNew ?? response.data?.enqueued ?? 0;
      const alreadyQueued = response.data?.alreadyQueued || 0;
      const message = alreadyQueued
        ? `Queued ${queuedNew} new audit(s). ${alreadyQueued} already queued.`
        : `Queued audit for ${queuedNew || response.data?.enqueued || 0} lane(s).`;
      renderAlert(message);
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not queue audit.', 'bad');
    }
  }
}

async function handleSystemActions(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'setApiToken') {
    const tokenInput = document.getElementById('api-token-input');
    const token = tokenInput?.value || '';
    setApiToken(token);
    renderAlert(token ? 'API token saved for session.' : 'Token cleared (empty input).');
    await refresh();
    return;
  }
  if (action === 'clearApiToken') {
    setApiToken('');
    renderAlert('Saved API token cleared.');
    await refresh();
    return;
  }
  if (action === 'cleanupArtifacts') {
    const dryRun = window.confirm('Run cleanup as dry run first? Press Cancel to perform deletion.');
    const response = await api(event.currentTarget.dataset.url || '/api/artifacts/cleanup', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun,
      },
    });
    if (response.ok) {
      if (dryRun) {
        renderAlert(`Artifact cleanup dry run: ${response.data?.candidates || 0} candidates.`);
      } else {
        renderAlert(`Artifact cleanup complete: removed ${response.data?.removed || 0} lanes.`);
      }
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Cleanup failed.', 'bad');
    }
    return;
  }
}

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'create-project-form') {
    await handleCreateProject(event);
    return;
  }
  if (event.target.id === 'create-session-form') {
    await handleCreateSession(event);
    return;
  }
  if (event.target.id === 'create-lane-form') {
    await handleCreateLane(event);
    return;
  }
});

document.addEventListener('click', async (event) => {
  const action = event.target?.dataset?.action;
  if (!action) return;

  if (['stopLane', 'retryLane', 'auditLane', 'captureEvidence', 'clearEvidence'].includes(action)) {
    await handleLaneActions({ currentTarget: event.target });
    return;
  }

  if (action === 'ackAuditEvent') {
    await handleAuditEventAction({ currentTarget: event.target });
    return;
  }

  if (['refresh', 'auditDone'].includes(action)) {
    await handleSessionActions({ currentTarget: event.target });
    return;
  }

  if (['setApiToken', 'clearApiToken', 'cleanupArtifacts'].includes(action)) {
    await handleSystemActions({ currentTarget: event.target });
    return;
  }

  if (action === 'showArtifacts') {
    await handleLaneActions({ currentTarget: event.target });
  }
});

setInterval(refresh, 3000);
initializeApiToken();
renderMobileManifest();
refresh();
