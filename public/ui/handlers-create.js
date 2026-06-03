// Split from handlers.js.

import { buildApprovedActionBody, buildMcpToolBody, toObj } from './handlers-config.js';
import { safeText } from './format.js';
import { renderAlert } from './dom.js';
import { api } from './api.js';
import { refresh } from './controller.js';
import { render } from './render-views.js';
import { shell } from './state.js';
import { executorTargetsBinary, executorTargetsCommand, findMcpTool, getExecutorScopedMcpTools, normalizeExecutorType, normalizeMcpToolScopes, parseCommandParts } from './executor.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES } from './constants.js';

export async function handleCreateProject(event) {
  event.preventDefault();
  const payload = toObj(event.currentTarget);
  const approval = buildApprovedActionBody('createProject', `Create project ${safeText(payload.name || '').trim() || 'new project'}?`);
  if (!approval.approved) {
    renderAlert('Project creation canceled.');
    return;
  }
  const quick = (payload.quickLink || '').trim();
  const body = {
    name: payload.name,
    slug: payload.slug,
    owner: approval.actor,
    quickLinks: quick ? [{ label: 'Primary', url: quick }] : [],
    actor: approval.actor,
    approved: approval.approved,
  };
  const response = await api('/api/projects', { method: 'POST', body });
  if (response.ok) {
    renderAlert('Project created.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Project creation failed.', 'bad');
  }
}

export async function handleCreateSession(event) {
  event.preventDefault();
  const projectId = event.currentTarget.dataset.projectId;
  const payload = toObj(event.currentTarget);
  const approval = buildApprovedActionBody(
    'createSession',
    `Create session "${String(payload.name || '').trim() || 'new session'}" for this project?`,
  );
  if (!approval.approved) {
    renderAlert('Session creation canceled.');
    return;
  }
  // Agent-flow config from the form -> layered settingsOverrides.flow.
  const flow = {};
  if (payload.flowTemplate) flow.template = String(payload.flowTemplate);
  if (payload.flowAuditTier) flow.auditTier = String(payload.flowAuditTier);
  if (payload.flowFixRouting) flow.fixRouting = String(payload.flowFixRouting);
  if (payload.flowMaxAuditLoops !== undefined && payload.flowMaxAuditLoops !== '') {
    flow.maxAuditLoops = Number(payload.flowMaxAuditLoops);
  }
  flow.requireAuditPass = payload.flowRequireAuditPass === 'on' || payload.flowRequireAuditPass === true;
  const response = await api(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    body: {
      name: payload.name,
      leader: payload.leader,
      laneConcurrencyLimit: payload.laneConcurrencyLimit ? Number(payload.laneConcurrencyLimit) : 1,
      ...(payload.repoRoot && String(payload.repoRoot).trim() ? { repoRoot: String(payload.repoRoot).trim() } : {}),
      ...(Object.keys(flow).length ? { settingsOverrides: { flow } } : {}),
      actor: approval.actor,
      approved: approval.approved,
    },
  });
  if (response.ok) {
    renderAlert('Session created.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Session creation failed.', 'bad');
  }
}

export async function handleAddProjectQuickLink(event) {
  event.preventDefault();
  const projectId = event.currentTarget.dataset.projectId;
  const payload = toObj(event.currentTarget);
  const label = String(payload.quickLinkLabel || '').trim();
  const url = String(payload.quickLinkUrl || '').trim();
  if (!label || !url) {
    renderAlert('Quick link label and URL are required.', 'bad');
    return;
  }

  const project = shell.projects.find((value) => value.id === projectId);
  const approval = buildApprovedActionBody('updateProject', `Save live link "${label}" for ${project?.name || 'project'}?`);
  if (!approval.approved) {
    renderAlert('Quick link addition canceled.');
    return;
  }

  const port = Number.parseInt(payload.quickLinkPort || '', 10);
  const response = await api(`/api/projects/${projectId}/quick-links`, {
    method: 'POST',
    body: {
      actor: approval.actor,
      approved: approval.approved,
      label,
      url,
      kind: payload.quickLinkKind || 'vite',
      favorite: Boolean(payload.quickLinkFavorite),
      ...(Number.isFinite(port) ? { port } : {}),
      ...(payload.quickLinkLocalUrl ? { localUrl: payload.quickLinkLocalUrl } : {}),
      ...(payload.quickLinkTailnetHttpUrl ? { tailnetHttpUrl: payload.quickLinkTailnetHttpUrl } : {}),
      ...(payload.quickLinkHttpsServeUrl ? { httpsServeUrl: payload.quickLinkHttpsServeUrl } : {}),
    },
  });
  if (response.ok) {
    renderAlert('Live link saved.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not save live link.', 'bad');
  }
}

export async function handleCreateLane(event) {
  event.preventDefault();
  const sessionId = event.currentTarget.dataset.sessionId;
  const payload = toObj(event.currentTarget);
  const executorType = normalizeExecutorType(payload.executorType || 'mock');
  const approval = buildApprovedActionBody(
    'createLane',
    `Queue lane "${String(payload.title || '').trim() || 'new lane'}" as ${executorType || 'mock'}-led lane?`,
  );
  if (!approval.approved) {
    renderAlert('Lane creation canceled.');
    return;
  }
  const commandParts = parseCommandParts(payload.command);
  // Accept multi-select values (FormData lists), the hidden text fallback, and legacy comma-separated.
  let mcpRaw = payload.mcpToolIds;
  if (!mcpRaw && payload.mcpToolIdsRaw) mcpRaw = payload.mcpToolIdsRaw;
  let requestedToolIds = [];
  if (Array.isArray(mcpRaw)) {
    requestedToolIds = mcpRaw.map((value) => String(value || '').trim()).filter(Boolean);
  } else if (mcpRaw) {
    requestedToolIds = String(mcpRaw).split(',').map((value) => value.trim()).filter(Boolean);
  }
  // Also collect from FormData directly in case toObj squashed array values.
  try {
    const fd = new FormData(event.currentTarget);
    const all = fd.getAll('mcpToolIds').map((value) => String(value || '').trim()).filter(Boolean);
    if (all.length) requestedToolIds = all;
  } catch { /* noop */ }
  const scopedTools = getExecutorScopedMcpTools(executorType);
  const scopedToolIds = new Set(scopedTools.map((tool) => tool.id));
  const unknownTools = [];
  const disallowedTools = [];

  if (FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(executorType)) {
    if (commandParts.length > 0 && !executorTargetsCommand(executorType, commandParts)) {
      renderAlert(`Command for ${executorType} must target an approved ${executorType} binary.`, 'bad');
      return;
    }
    if (!commandParts.length && payload.executorBinary && !executorTargetsBinary(executorType, payload.executorBinary)) {
      renderAlert(`Executor binary for ${executorType} must target an approved ${executorType} binary.`, 'bad');
      return;
    }
  }

  for (const requestedToolId of requestedToolIds) {
    const tool = findMcpTool(requestedToolId);
    if (!tool) {
      unknownTools.push(requestedToolId);
      continue;
    }
    if (!scopedToolIds.has(tool.id)) {
      disallowedTools.push(requestedToolId);
    }
  }

  if (unknownTools.length) {
    renderAlert(`Unknown MCP tool(s): ${unknownTools.join(', ')}`, 'bad');
    return;
  }
  if (disallowedTools.length) {
    renderAlert(`Tool(s) not available for ${executorType}: ${disallowedTools.join(', ')}`, 'bad');
    return;
  }

  const response = await api(`/api/sessions/${sessionId}/lanes`, {
    method: 'POST',
    body: {
      title: payload.title,
      taskDescription: payload.taskDescription,
      executorType,
      command: payload.command || null,
      commandArgs: payload.commandArgs || null,
      executorBinary: payload.executorBinary || null,
      workdir: payload.workdir || null,
      mcpToolIds: requestedToolIds,
      owner: 'dashboard',
      approved: approval.approved,
      actor: approval.actor,
      taskPrompt: payload.taskPrompt || null,
      model: payload.model || null,
      permissionsProfile: payload.permissionsProfile || null,
      intelligenceProfile: payload.intelligenceProfile || null,
      targetUrl: payload.targetUrl || null,
      branch: payload.branch || null,
      verificationCommand: payload.verificationCommand || null,
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

export async function handleCreateMcpTool(event) {
  event.preventDefault();
  const payload = buildMcpToolBody(toObj(event.currentTarget));
  const scopeInfo = normalizeMcpToolScopes(payload.scope);
  if (scopeInfo.error) {
    renderAlert(scopeInfo.error, 'bad');
    return;
  }
  payload.scope = scopeInfo.scopes;
  if (/\s/.test(String(payload.command || '').trim())) {
    renderAlert('MCP command must be a single executable token.', 'bad');
    return;
  }
  const approval = buildApprovedActionBody('manageMcpTools', `Create MCP tool ${safeText(payload.name || 'new tool')}?`);
  if (!approval.approved) {
    renderAlert('MCP tool creation canceled.');
    return;
  }
  payload.approved = approval.approved;
  payload.actor = approval.actor;

  const response = await api('/api/mcp/tools', {
    method: 'POST',
    body: payload,
  });
  if (response.ok) {
    renderAlert(`MCP tool ${payload.name} added.`);
    await refresh();
    return;
  }
  if (response.data?.requiresApproval) {
    renderAlert('Approval required for MCP tool changes.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Could not add MCP tool.', 'bad');
  }
}

// Workstation directory picker (desktop + remote). Browses the workstation's
// folders via the jailed /api/system/dirs API and writes the chosen working
// directory into a target input. Actions: browseWorkstation (open at roots),
// workstationOpenDir (navigate, data-dir), workstationUseDir (pick, data-dir),
// workstationPickerClose.
// On the desktop (Tauri) shell, prefer the workstation's NATIVE OS folder dialog
// — same as the codex app. Returns {available} so the caller can fall back to the
// jailed web picker on remote/browser, where an OS dialog is impossible.
async function tryNativeDirectoryPick() {
  const tauri = (typeof window !== 'undefined') ? window.__TAURI__ : null;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (typeof invoke !== 'function') return { available: false, path: null };
  try {
    const picked = await invoke('pick_directory');
    return { available: true, path: typeof picked === 'string' && picked ? picked : null };
  } catch {
    // Plugin missing / dialog error — fall back to the web picker rather than dead-end.
    return { available: false, path: null };
  }
}

export async function handleWorkstationPicker(target) {
  const action = target?.dataset?.action;
  const dir = target?.dataset?.dir || '';
  const forInput = target?.dataset?.forInput || shell.workstationPicker?.forInput || 'session-repo-root';

  if (action === 'workstationPickerClose') {
    shell.workstationPicker = null;
    render();
    return;
  }

  // Opening the picker on desktop -> native OS dialog. (Navigation actions stay
  // on the web picker so remote devices keep working.)
  if (action === 'browseWorkstation') {
    const native = await tryNativeDirectoryPick();
    if (native.available) {
      if (native.path) {
        const input = document.getElementById(forInput);
        if (input) input.value = native.path;
        shell.workstationPicker = null;
        render();
      }
      return; // desktop handled it (picked or cancelled) — don't open the web picker
    }
  }
  if (action === 'workstationUseDir') {
    const input = document.getElementById(forInput);
    if (input && dir) input.value = dir;
    shell.workstationPicker = null;
    render();
    if (!dir) renderAlert('Pick a folder first.', 'bad');
    return;
  }

  // browseWorkstation (open) / workstationOpenDir (navigate)
  shell.workstationPicker = { ...(shell.workstationPicker || {}), open: true, forInput, loading: true, error: null };
  render();
  const resp = await api(`/api/system/dirs${dir ? `?path=${encodeURIComponent(dir)}` : ''}`);
  if (resp.ok && resp.data) {
    shell.workstationPicker = { open: true, forInput, loading: false, error: null, ...resp.data };
  } else {
    shell.workstationPicker = {
      open: true,
      forInput,
      loading: false,
      error: resp.data?.error || 'Could not list workstation directories.',
      roots: shell.workstationPicker?.roots || [],
      entries: [],
      path: shell.workstationPicker?.path || null,
      parent: null,
    };
  }
  render();
}
