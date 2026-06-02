// Form/action handlers for create/update flows (projects, sessions, lanes, MCP
// tools, providers, private access, notifications, app backup, cleanup, audit) +
// request-body builders. Invoked by the app.js event dispatcher. Extracted from app.js.

import { api } from './api.js';
import { authRequiredMessage, renderAlert } from './dom.js';
import { refresh } from './controller.js';
import { browserNotificationPermission, maybeShowBrowserNotifications, requestBrowserNotificationPermission } from './notifications.js';
import { shell } from './state.js';
import { captureContentUiState, composerAttachmentsFor, render } from './render-views.js';
import { executorTargetsBinary, executorTargetsCommand, findMcpTool, getExecutorScopedMcpTools, normalizeExecutorType, normalizeMcpToolScopes, parseCommandParts } from './executor.js';
import { confirmHighRiskAction, isLiveLaneState } from './render-helpers.js';
import { safeText } from './format.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES } from './constants.js';

export async function handlePrivateAccessSettings(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const response = await api('/api/private-access/settings', {
    method: 'PATCH',
    body: {
      actor: 'dashboard',
      preferredMode: formData.get('preferredMode'),
      openTarget: formData.get('openTarget'),
      notificationMode: formData.get('notificationMode'),
      pwaMode: formData.has('pwaMode') ? 'enabled' : 'disabled',
    },
  });
  if (response.ok) {
    renderAlert('Private access settings saved.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not save private access settings.', 'bad');
  }
}

export async function handleNotificationSettings(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const browserEnabled = formData.has('browserEnabled');
  if (browserEnabled && browserNotificationPermission() === 'default') {
    await requestBrowserNotificationPermission();
  }
  const approval = buildApprovedActionBody('manageNotifications', 'Update notification delivery settings?');
  if (!approval.approved) {
    renderAlert('Notification settings update canceled.');
    return;
  }
  const response = await api('/api/notifications/settings', {
    method: 'PATCH',
    body: {
      actor: approval.actor,
      approved: approval.approved,
      inAppEnabled: formData.has('inAppEnabled'),
      browserEnabled,
      minSeverity: formData.get('minSeverity'),
      muted: formData.has('muted'),
    },
  });
  if (response.ok) {
    shell.notifications = response.data;
    renderAlert('Notification settings saved.');
    maybeShowBrowserNotifications();
    await refresh();
  } else if (response.data?.requiresApproval) {
    renderAlert('Approval required to update notifications.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Could not save notification settings.', 'bad');
  }
}

export async function handleNotificationAction(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'requestBrowserNotifications') {
    await requestBrowserNotificationPermission();
    return;
  }
  if (action === 'markNotificationRead') {
    const notificationId = event.currentTarget.dataset.notificationId;
    if (!notificationId) return;
    const response = await api(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
      method: 'POST',
      body: { actor: 'dashboard' },
    });
    if (response.ok) {
      renderAlert('Notification marked read.');
      await refresh();
    } else {
      renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not mark notification read.'), 'bad');
    }
    return;
  }
  if (action === 'markAllNotificationsRead') {
    const response = await api('/api/notifications/read-all', {
      method: 'POST',
      body: { actor: 'dashboard' },
    });
    if (response.ok) {
      renderAlert(`Marked ${response.data?.updated || 0} notification(s) read.`);
      await refresh();
    } else {
      renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not mark notifications read.'), 'bad');
    }
  }
}

export async function handleCreatePrivateAccessTarget(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const response = await api('/api/private-access/targets', {
    method: 'POST',
    body: {
      actor: 'dashboard',
      label: formData.get('label'),
      mode: formData.get('mode'),
      localUrl: formData.get('localUrl'),
      tailnetHttpUrl: formData.get('tailnetHttpUrl'),
      httpsServeUrl: formData.get('httpsServeUrl'),
      favorite: formData.has('favorite'),
    },
  });
  if (response.ok) {
    renderAlert('Private access target added.');
    form.reset();
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not add private access target.', 'bad');
  }
}

export async function handlePrivateAccessAction(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'copyPrivateAccessCommand') {
    const command = event.currentTarget.dataset.command || '';
    if (!command) {
      renderAlert('Nothing to copy.', 'bad');
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      renderAlert('Copied private access command.');
    } catch {
      renderAlert(command);
    }
    return;
  }
  const targetId = event.currentTarget.dataset.targetId;
  if (!targetId) return;
  if (action === 'checkPrivateAccessTarget') {
    const response = await api(`/api/private-access/targets/${encodeURIComponent(targetId)}/check`, {
      method: 'POST',
      body: { actor: 'dashboard' },
    });
    if (response.ok) {
      renderAlert(`Private access target is ${response.data?.result?.status || 'checked'}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not check private access target.', 'bad');
    }
    return;
  }
  if (action === 'deletePrivateAccessTarget') {
    if (!window.confirm('Remove this private access target?')) return;
    const response = await api(`/api/private-access/targets/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
      body: { actor: 'dashboard' },
    });
    if (response.ok) {
      renderAlert('Private access target removed.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not remove private access target.', 'bad');
    }
  }
}

export async function handleProviderAction(event) {
  const action = event.currentTarget.dataset.action;
  const providerId = event.currentTarget.dataset.providerId;
  if (action === 'refreshProviderHealth') {
    const response = await api(`/api/providers/${encodeURIComponent(providerId)}/health`);
    if (response.ok) {
      shell.providerHealth[providerId] = response.data;
      renderAlert(`${providerId} health: ${response.data?.status || 'checked'}.`);
      render(captureContentUiState());
    } else {
      renderAlert(response.data?.error || 'Could not refresh provider health.', 'bad');
    }
    return;
  }
  if (action === 'toggleProviderEnabled') {
    const nextEnabled = event.currentTarget.dataset.enabled === 'true';
    const approval = buildApprovedActionBody('manageExecutorCli', `${nextEnabled ? 'Enable' : 'Disable'} provider ${providerId}?`);
    if (!approval.approved) return;
    const response = await api(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        enabled: nextEnabled,
      },
    });
    if (response.ok) {
      renderAlert(`${providerId} ${nextEnabled ? 'enabled' : 'disabled'}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not update provider.', 'bad');
    }
    return;
  }
  if (action === 'setProviderSecret') {
    const secret = window.prompt(`Enter API key/secret for ${providerId}. It will be sent once and never shown again.`);
    if (!secret) return;
    const approval = buildApprovedActionBody('manageExecutorCli', `Store secret for provider ${providerId}?`);
    if (!approval.approved) return;
    const response = await api(`/api/providers/${encodeURIComponent(providerId)}/secret`, {
      method: 'POST',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        secret,
      },
    });
    if (response.ok) {
      renderAlert(`${providerId} secret stored via ${response.data?.credential?.backend || 'credential backend'}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not store provider secret.', 'bad');
    }
    return;
  }
  if (action === 'deleteProviderSecret') {
    const confirmed = window.confirm(`Delete stored secret for ${providerId}? Env fallback may still be used if configured.`);
    if (!confirmed) return;
    const approval = buildApprovedActionBody('manageExecutorCli', `Delete secret for provider ${providerId}?`);
    if (!approval.approved) return;
    const response = await api(`/api/providers/${encodeURIComponent(providerId)}/secret`, {
      method: 'DELETE',
      body: {
        actor: approval.actor,
        approved: approval.approved,
      },
    });
    if (response.ok) {
      renderAlert(`${providerId} secret delete request completed.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not delete provider secret.', 'bad');
    }
    return;
  }
  if (action === 'exportProviderProfiles') {
    const response = await api('/api/providers/export');
    const output = document.getElementById('provider-export-output');
    if (response.ok && output) {
      output.textContent = JSON.stringify(response.data, null, 2);
      renderAlert('Provider profiles exported without secrets.');
    } else {
      renderAlert(response.data?.error || 'Could not export provider profiles.', 'bad');
    }
    return;
  }
  if (action === 'dryRunProviderImport') {
    const source = document.getElementById('provider-import-json');
    const output = document.getElementById('provider-export-output');
    let parsed = null;
    try {
      parsed = JSON.parse(source?.value || '{}');
    } catch {
      renderAlert('Provider import JSON is invalid.', 'bad');
      return;
    }
    const response = await api('/api/providers/import/dry-run', {
      method: 'POST',
      body: parsed,
    });
    if (output) output.textContent = JSON.stringify(response.data, null, 2);
    renderAlert(response.ok ? 'Provider import dry-run completed.' : (response.data?.error || 'Provider import dry-run failed.'), response.ok ? 'info' : 'bad');
  }
}

export async function handleAppBackupAction(event) {
  const action = event.currentTarget.dataset.action;
  const output = document.getElementById('app-export-output');
  const input = document.getElementById('app-import-json');

  if (action === 'exportAppBackup' || action === 'exportSupportBundle') {
    const route = action === 'exportAppBackup' ? '/api/app/export' : '/api/app/support-bundle';
    const response = await api(route);
    if (output) output.textContent = JSON.stringify(response.data, null, 2);
    renderAlert(response.ok
      ? (action === 'exportAppBackup' ? 'App backup exported without secrets.' : 'Support bundle exported without secrets.')
      : (response.data?.error || 'Could not export app data.'),
    response.ok ? 'info' : 'bad');
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(input?.value || '{}');
  } catch {
    renderAlert('App import JSON is invalid.', 'bad');
    return;
  }

  if (action === 'dryRunAppImport') {
    const response = await api('/api/app/import/dry-run', {
      method: 'POST',
      body: parsed,
    });
    if (output) output.textContent = JSON.stringify(response.data, null, 2);
    renderAlert(response.ok ? 'App import dry-run completed.' : (response.data?.error || 'App import dry-run failed.'), response.ok ? 'info' : 'bad');
    return;
  }

  if (action === 'applyAppImport') {
    const confirmed = window.confirm('Apply this app backup non-destructively? Existing IDs are skipped and active lanes are imported as stopped.');
    if (!confirmed) {
      renderAlert('App import canceled.');
      return;
    }
    const approval = buildApprovedActionBody('manageAppBackups', 'Approve app backup import?');
    if (!approval.approved) {
      renderAlert('App import canceled.');
      return;
    }
    const response = await api('/api/app/import/apply', {
      method: 'POST',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        payload: parsed,
      },
    });
    if (output) output.textContent = JSON.stringify(response.data, null, 2);
    if (response.ok) {
      renderAlert('App import applied non-destructively.');
      await refresh();
      return;
    }
    renderAlert(response.data?.error || 'App import apply failed.', 'bad');
  }
}

export function buildCleanupScheduleBody(formData) {
  const payload = {};
  for (const [key, value] of Object.entries(formData)) {
    payload[key] = value;
  }

  payload.enabled = payload.enabled === true || payload.enabled === 'on';
  payload.dryRun = payload.dryRun === true || payload.dryRun === 'on';
  payload.actor = 'dashboard';

  payload.intervalHours = payload.intervalHours ? Number(payload.intervalHours) : 24;
  if (!payload.intervalHours || Number.isNaN(payload.intervalHours) || payload.intervalHours <= 0) {
    payload.intervalHours = 24;
  }

  if (!payload.olderThanDays) {
    payload.olderThanDays = null;
  } else {
    payload.olderThanDays = Number(payload.olderThanDays);
    if (Number.isNaN(payload.olderThanDays) || payload.olderThanDays <= 0) {
      payload.olderThanDays = null;
    }
  }

  if (!payload.sessionId || !String(payload.sessionId).trim()) {
    payload.sessionId = null;
  }

  return payload;
}

export function buildMcpToolBody(formData) {
  const payload = {};
  for (const [key, value] of Object.entries(formData)) {
    payload[key] = value;
  }
  payload.actor = 'dashboard';
  payload.args = typeof payload.args === 'string'
    ? payload.args.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  const normalizedScope = normalizeMcpToolScopes(payload.scope);
  if (!normalizedScope.error) {
    payload.scope = normalizedScope.scopes;
  } else {
    payload.scope = ['all'];
  }
  return payload;
}

export function buildApprovedActionBody(policyKey = 'manageMcpTools', message = 'This is a higher-risk action. Continue?') {
  return {
    actor: 'dashboard',
    approved: confirmHighRiskAction(message, policyKey),
  };
}

export async function handleCleanupSchedule(event) {
  event.preventDefault();
  const payload = buildCleanupScheduleBody(toObj(event.currentTarget));
  const endpoint = event.currentTarget.dataset.url || '/api/artifacts/cleanup/schedule';
  const current = shell.cleanupSchedule || {};
  const scheduled = payload.enabled ? 'Enabled' : 'Disabled';
  const currentState = `${current.enabled ? 'enabled' : 'disabled'}`;
  const interval = payload.intervalHours;
  const retention = payload.olderThanDays || 'session default';
  const targetSession = payload.sessionId || 'all sessions';
  const dryRunMode = payload.dryRun ? 'Dry-run' : 'Live';
  const confirmMessage = `Update cleanup schedule?\nCurrent: ${currentState}\nNext: ${scheduled.toLowerCase()}, ${interval}h, retention ${retention}, ${targetSession}, ${dryRunMode}.`;
  const approval = buildApprovedActionBody('manageCleanupSchedule', confirmMessage);
  if (!approval.approved) {
    renderAlert('Cleanup schedule update canceled.');
    return;
  }
  const response = await api(endpoint, {
    method: 'POST',
    body: {
      ...payload,
      approved: approval.approved,
      actor: approval.actor,
    },
  });
  if (response.ok) {
    renderAlert('Artifact cleanup schedule saved.');
    await refresh();
    return;
  }
  if (response.data?.requiresApproval) {
    renderAlert('Approval required for schedule updates.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Could not save cleanup schedule.', 'bad');
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

export function toObj(form) {
  const data = new FormData(form);
  const output = {};
  for (const [key, value] of data.entries()) {
    output[key] = value;
  }
  return output;
}

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
  const response = await api(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    body: {
      name: payload.name,
      leader: payload.leader,
      laneConcurrencyLimit: payload.laneConcurrencyLimit ? Number(payload.laneConcurrencyLimit) : 1,
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

export async function handleOrchestratorMessage(event) {
  event.preventDefault();
  const sessionId = event.currentTarget.dataset.sessionId;
  const payload = toObj(event.currentTarget);
  const message = String(payload.message || '').trim();
  const attachments = composerAttachmentsFor(sessionId).map((entry) => ({ name: entry.name, url: entry.url }));
  if (!message && !attachments.length) {
    renderAlert('Message or attachment is required.', 'bad');
    return;
  }
  const executorType = normalizeExecutorType(payload.executorType || 'codex');
  const model = String(payload.model || '').trim() || String(payload.modelPreset || '').trim() || null;
  const intelligenceProfile = String(payload.intelligenceProfile || '').trim() || 'high';
  const permissionsProfile = String(payload.permissionsProfile || '').trim() || 'plan';
  const approval = buildApprovedActionBody(
    'createLane',
    `Start ${executorType} orchestrator?\nMode: ${permissionsProfile}\nModel: ${model || 'default'}\nIntelligence: ${intelligenceProfile}`,
  );
  if (!approval.approved) {
    renderAlert('Orchestrator message canceled.');
    return;
  }
  const response = await api(`/api/sessions/${sessionId}/orchestrator/messages`, {
    method: 'POST',
    body: {
      message,
      executorType,
      model,
      permissionsProfile,
      intelligenceProfile,
      attachments,
      actor: approval.actor,
      approved: approval.approved,
    },
  });
  if (response.ok) {
    event.currentTarget.reset();
    composerAttachmentsFor(sessionId).length = 0; // clear attached files after send
    renderAlert('Orchestrator lane started.');
    await refresh();
  } else {
    renderAlert(response.data?.error || 'Could not start orchestrator lane.', 'bad');
  }
}

export async function handleLaneControlsUpdate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const laneId = form.dataset.laneId;
  const lane = shell.lanes.find((item) => item.id === laneId);
  if (!lane) {
    renderAlert('Lane not found.', 'bad');
    return;
  }
  const payload = toObj(form);
  const model = String(payload.model || '').trim();
  const intelligenceProfile = String(payload.intelligenceProfile || '').trim();
  const permissionsProfile = String(payload.permissionsProfile || '').trim();
  const approval = buildApprovedActionBody(
    'updateLaneControls',
    `Update controls for ${lane.title}?\nMode: ${permissionsProfile || 'default'}\nModel: ${model || 'default'}\nIntelligence: ${intelligenceProfile || 'default'}`,
  );
  if (!approval.approved) {
    renderAlert('Lane control update canceled.');
    return;
  }
  const response = await api(`/api/lanes/${laneId}/controls`, {
    method: 'PATCH',
    body: {
      actor: approval.actor,
      approved: approval.approved,
      model,
      permissionsProfile,
      intelligenceProfile,
    },
  });
  if (response.ok) {
    renderAlert(isLiveLaneState(lane.state) ? 'Lane controls saved. Restart to apply to the running process.' : 'Lane controls saved.');
    await refresh();
  } else if (response.data?.requiresApproval) {
    renderAlert('Approval required for lane controls.', 'bad');
  } else {
    renderAlert(response.data?.error || 'Could not update lane controls.', 'bad');
  }
}

export async function handleAuditEventAction(event) {
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
