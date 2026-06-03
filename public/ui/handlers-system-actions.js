// Split from handlers-actions.js.

import { authRequiredMessage, renderAlert } from './dom.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { api, setApiToken } from './api.js';
import { refresh } from './controller.js';
import { shell } from './state.js';
import { refreshComposerAttachments } from './render-session-parts.js';
import { buildApprovedActionBody } from './handlers-integrations.js';
import { safeText } from './format.js';
import { quickLinkHealthLabel } from './access-mode.js';
import { normalizeMcpToolScopes } from './executor.js';

export async function handleSystemActions(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'copyPhoneUrl') {
    const url = event.currentTarget.dataset.url || window.location.origin;
    try {
      await navigator.clipboard.writeText(url);
      renderAlert('Phone link copied.');
    } catch {
      renderAlert(url);
    }
    return;
  }
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
  if (action === 'createPairingCode') {
    const response = await api('/api/auth/pairing-codes', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        label: 'Phone/browser pairing',
      },
    });
    if (response.ok) {
      shell.lastPairing = response.data?.pairing || null;
      renderAlert(`Pairing code: ${response.data?.pairing?.code || 'created'}`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not create pairing code.', 'bad');
    }
    return;
  }
  if (action === 'connectDesktopApp') {
    const response = await api('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      body: { actor: 'desktop-app' },
    });
    if (response.ok) {
      shell.lastDesktopBootstrap = response.data || null;
      renderAlert('Desktop-app orchestrator config generated. Copy it into Codex or Claude Desktop.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not generate desktop-app config.', 'bad');
    }
    return;
  }
  if (action === 'copyDesktopConfig') {
    const client = event.currentTarget.dataset.client || 'claudeDesktop';
    const snippet = shell.lastDesktopBootstrap?.bootstrap?.clients?.[client]?.snippet || '';
    try {
      await navigator.clipboard.writeText(snippet);
      renderAlert(`${client === 'codex' ? 'Codex' : 'Claude Desktop'} config copied.`);
    } catch {
      renderAlert(snippet || 'Nothing to copy.');
    }
    return;
  }
  if (action === 'pickAttachment') {
    const input = document.getElementById('composer-file-input');
    if (input) input.click();
    return;
  }
  if (action === 'removeAttachment') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const attachmentId = event.currentTarget.dataset.attachmentId;
    shell.composerAttachments = shell.composerAttachments || {};
    if (Array.isArray(shell.composerAttachments[sessionId])) {
      shell.composerAttachments[sessionId] = shell.composerAttachments[sessionId].filter((a) => a.id !== attachmentId);
      refreshComposerAttachments(sessionId);
    }
    return;
  }
  if (action === 'saveSessionPlan') {
    const form = document.getElementById('session-plan-form');
    const sessionId = form?.dataset.sessionId;
    const goal = form?.querySelector('[name="goal"]')?.value || '';
    const plan = form?.querySelector('[name="plan"]')?.value || '';
    const response = await api(`/api/sessions/${sessionId}/plan`, {
      method: 'POST',
      body: { actor: 'dashboard', goal, plan },
    });
    if (response.ok) {
      renderAlert('Goal & plan saved.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not save plan.', 'bad');
    }
    return;
  }
  if (action === 'approveApproval' || action === 'denyApproval') {
    const laneId = event.currentTarget.dataset.laneId;
    const approvalId = event.currentTarget.dataset.approvalId;
    const decision = action === 'approveApproval' ? 'approve' : 'deny';
    const response = await api(`/api/lanes/${laneId}/approvals/${approvalId}/decide`, {
      method: 'POST',
      body: { actor: 'dashboard', decision },
    });
    if (response.ok) {
      renderAlert(`Approval ${decision === 'approve' ? 'approved' : 'denied'}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not record decision.', 'bad');
    }
    return;
  }
  if (action === 'setupCapture') {
    // Dry-run first to preview the governed plan, then confirm to execute.
    const dry = await api('/api/capture/install', {
      method: 'POST',
      body: { actor: 'dashboard', approved: true, confirmed: false },
    });
    if (!dry.ok) {
      renderAlert(dry.data?.error || 'Could not plan capture setup.', 'bad');
      return;
    }
    const plan = dry.data?.plan;
    const desc = plan ? `${plan.backend} — ${plan.estimatedDownload}` : 'capture backend';
    if (!await confirmDialog(`Set up evidence capture: ${desc}.\n\nThis installs a browser backend on this machine. Proceed?`)) {
      return;
    }
    renderAlert('Setting up capture backend… this can take a minute.');
    const run = await api('/api/capture/install', {
      method: 'POST',
      body: { actor: 'dashboard', approved: true, confirmed: true },
    });
    if (run.ok && run.data?.ok) {
      renderAlert('Capture backend is ready.');
      await refresh();
    } else {
      renderAlert(run.data?.error || run.data?.result?.failedStep || 'Capture setup failed.', 'bad');
    }
    return;
  }
  if (action === 'pairBrowserSession') {
    const code = document.getElementById('pairing-code-input')?.value || '';
    const label = document.getElementById('pairing-label-input')?.value || 'Paired browser';
    const response = await api('/api/auth/pair', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        code,
        label,
      },
    });
    if (response.ok) {
      renderAlert('Browser paired.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not pair browser.', 'bad');
    }
    return;
  }
  if (action === 'logoutBrowserSession') {
    const response = await api('/api/auth/logout', {
      method: 'POST',
      body: {
        actor: 'dashboard',
      },
    });
    if (response.ok) {
      renderAlert('Paired browser session logged out.');
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not log out paired browser.', 'bad');
    }
    return;
  }
  if (action === 'revokeBrowserSession') {
    const sessionId = event.currentTarget.dataset.sessionId;
    if (!sessionId) return;
    const confirmed = await confirmDialog('Revoke this paired browser session?');
    if (!confirmed) {
      renderAlert('Session revoke canceled.');
      return;
    }
    const response = await api('/api/auth/logout', {
      method: 'POST',
      body: {
        actor: 'dashboard',
        sessionId,
      },
    });
    if (response.ok) {
      renderAlert('Paired browser session revoked.');
      await refresh();
    } else {
      renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not revoke paired browser session.'), 'bad');
    }
    return;
  }
  if (action === 'cleanupArtifacts') {
    const dryRun = await confirmDialog('Run cleanup as dry run first? Press Cancel to perform deletion.');
    const confirmed = !dryRun ? await confirmDialog('This will permanently delete archived artifacts. Continue?') : true;
    const approval = await buildApprovedActionBody(
      'cleanupArtifacts',
      `Run artifact cleanup${dryRun ? ' (dry-run mode)' : ' now'}?`,
    );
    if (!confirmed) {
      renderAlert('Cleanup canceled.');
      return;
    }
    if (!approval.approved) {
      renderAlert('Cleanup canceled.');
      return;
    }
    const response = await api(event.currentTarget.dataset.url || '/api/artifacts/cleanup', {
      method: 'POST',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        dryRun,
        confirmed,
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
  if (action === 'cleanupArtifactsRunNow') {
    const schedule = shell.cleanupSchedule || {};
    const appliedSession = schedule.sessionId ? `session ${safeText(schedule.sessionId)}` : 'all sessions';
    const retention = schedule.olderThanDays ? `${safeText(schedule.olderThanDays)} day(s)` : 'session defaults';
    const defaultDryRun = schedule.dryRun ? 'on' : 'off';
    const confirmRun = await confirmDialog(`Run cleanup now using current schedule: ${appliedSession}, retention ${retention}, dry-run default ${defaultDryRun}?`);
    if (!confirmRun) {
      renderAlert('Cleanup run canceled.');
      return;
    }
    const approval = await buildApprovedActionBody(
      'cleanupArtifacts',
      `Run cleanup now using schedule for ${appliedSession}?`,
    );
    if (!approval.approved) {
      renderAlert('Cleanup run canceled.');
      return;
    }

    const runNowBody = {
      actor: approval.actor,
      approved: approval.approved,
      sessionId: schedule.sessionId || null,
      olderThanDays: schedule.olderThanDays ?? null,
      dryRun: Boolean(schedule.dryRun),
      confirmed: false,
    };

    const runNowApi = event.currentTarget.dataset.url || '/api/artifacts/cleanup/run-now';
    const runDryFirst = await confirmDialog('Run cleanup as dry-run first, then optionally run deletion?');

    if (runDryFirst) {
      const dryRunResponse = await api(runNowApi, {
        method: 'POST',
        body: {
          ...runNowBody,
          dryRun: true,
        },
      });
      if (!dryRunResponse.ok) {
        if (dryRunResponse.data?.requiresApproval) {
          renderAlert('Approval required for cleanup.', 'bad');
          return;
        }
        renderAlert(dryRunResponse.data?.error || 'Cleanup dry-run failed.', 'bad');
        return;
      }
      renderAlert(`Cleanup dry run found ${dryRunResponse.data?.candidates || 0} candidate lanes (no artifacts deleted).`);

      if (!dryRunResponse.data?.candidates) {
        await refresh();
        return;
      }

      const confirmDelete = await confirmDialog(`Delete ${dryRunResponse.data?.candidates} candidate artifacts now?`);
      if (!confirmDelete) {
        renderAlert('Cleanup deletion canceled after dry run.');
        await refresh();
        return;
      }
      runNowBody.confirmed = true;
      runNowBody.dryRun = false;
    } else {
      const confirmed = await confirmDialog('Run cleanup now and permanently delete matching artifacts?');
      if (!confirmed) {
        renderAlert('Cleanup run canceled.');
        return;
      }
      runNowBody.confirmed = true;
      runNowBody.dryRun = false;
    }

    const response = await api(runNowApi, {
      method: 'POST',
      body: {
        ...runNowBody,
      },
    });
    if (response.ok) {
      if (response.data?.dryRun) {
        renderAlert(`Cleanup run (dry-run): ${response.data?.candidates || 0} candidates.`);
      } else {
        renderAlert(`Cleanup run completed: removed ${response.data?.removed || 0} lanes.`);
      }
      await refresh();
      return;
    }
    if (response.data?.requiresApproval) {
      renderAlert('Approval required.', 'bad');
      return;
    }
    renderAlert(response.data?.error || 'Cleanup run failed.', 'bad');
  }

  if (action === 'deleteMcpTool') {
    const toolId = event.currentTarget.dataset.toolId;
    if (!toolId) return;
    const confirmed = await confirmDialog(`Delete MCP tool ${toolId}?`);
    if (!confirmed) {
      renderAlert('Delete canceled.');
      return;
    }
    const approval = await buildApprovedActionBody('manageMcpTools');
    if (!approval.approved) {
      renderAlert('Deletion canceled.');
      return;
    }
    const response = await api(`/api/mcp/tools/${toolId}`, {
      method: 'DELETE',
      body: approval,
    });
    if (response.ok) {
      renderAlert(`MCP tool ${toolId} deleted.`);
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required to delete MCP tool.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not delete MCP tool.', 'bad');
    }
  }

  if (action === 'deleteProjectQuickLink') {
    const projectId = event.currentTarget.dataset.projectId;
    const linkId = event.currentTarget.dataset.linkId;
    if (!projectId || !linkId) return;
    const confirmed = await confirmDialog('Remove this live link from the project?');
    if (!confirmed) {
      renderAlert('Live link removal canceled.');
      return;
    }
    const approval = await buildApprovedActionBody('updateProject');
    if (!approval.approved) {
      renderAlert('Live link removal canceled.');
      return;
    }

    const response = await api(`/api/projects/${projectId}/quick-links/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
      body: {
        actor: approval.actor,
        approved: approval.approved,
      },
    });
    if (response.ok) {
      renderAlert('Live link removed.');
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required to remove this live link.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not remove live link.', 'bad');
    }
  }

  if (action === 'checkProjectQuickLink') {
    const projectId = event.currentTarget.dataset.projectId;
    const linkId = event.currentTarget.dataset.linkId;
    if (!projectId || !linkId) return;
    const response = await api(`/api/projects/${projectId}/quick-links/${encodeURIComponent(linkId)}/check`, {
      method: 'POST',
      body: {
        actor: 'dashboard',
        prefer: 'auto',
      },
    });
    if (response.ok) {
      renderAlert(`Live link check: ${quickLinkHealthLabel(response.data?.result?.status)}.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not check live link.', 'bad');
    }
  }

  if (action === 'restoreProject') {
    const projectId = event.currentTarget.dataset.projectId;
    if (!projectId) return;
    const approval = await buildApprovedActionBody('updateProject', 'Restore this project to the active list?');
    if (!approval.approved) return;
    const response = await api(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: { actor: approval.actor, approved: approval.approved, state: 'active' },
    });
    if (response.ok) { renderAlert('Project restored.'); await refresh(); } else { renderAlert(response.data?.error || 'Could not restore project.', 'bad'); }
    return;
  }

  if (action === 'restoreSession') {
    const sessionId = event.currentTarget.dataset.sessionId;
    if (!sessionId) return;
    const approval = await buildApprovedActionBody('updateSession', 'Restore this session to the active list?');
    if (!approval.approved) return;
    const response = await api(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: { actor: approval.actor, approved: approval.approved, state: 'active' },
    });
    if (response.ok) { renderAlert('Session restored.'); await refresh(); } else { renderAlert(response.data?.error || 'Could not restore session.', 'bad'); }
    return;
  }

  if (action === 'archiveProject') {
    const projectId = event.currentTarget.dataset.projectId;
    const projectName = event.currentTarget.dataset.projectName || 'this project';
    if (!projectId) return;
    const confirmed = await confirmDialog(`Archive ${projectName}? It will disappear from the default project list, but its saved state is retained.`);
    if (!confirmed) {
      renderAlert('Project archive canceled.');
      return;
    }
    const approval = await buildApprovedActionBody('updateProject', `Archive ${projectName}?`);
    if (!approval.approved) {
      renderAlert('Project archive canceled.');
      return;
    }
    const response = await api(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        state: 'archived',
      },
    });
    if (response.ok) {
      renderAlert('Project archived.');
      window.location.href = '/#projects';
      return;
    }
    renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not archive project.'), 'bad');
  }

  if (action === 'renameProject') {
    const projectId = event.currentTarget.dataset.projectId;
    const projectName = event.currentTarget.dataset.projectName || 'project';
    const project = shell.projects.find((value) => value.id === projectId);
    if (!project) {
      renderAlert('Project not found.');
      return;
    }
    const nextName = await promptDialog(`Rename ${projectName}`, project.name || '');
    if (nextName === null) {
      renderAlert('Project rename canceled.');
      return;
    }
    const name = String(nextName || '').trim();
    if (!name || name === project.name) {
      renderAlert('Project rename canceled.');
      return;
    }
    const approval = await buildApprovedActionBody('updateProject', `Rename project ${project.name} to ${name}?`);
    if (!approval.approved) {
      renderAlert('Project rename canceled.');
      return;
    }
    const response = await api(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        name,
      },
    });
    if (response.ok) {
      renderAlert('Project renamed.');
      await refresh();
      return;
    }
    renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not rename project.'), 'bad');
  }

  if (action === 'archiveSession') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const sessionName = event.currentTarget.dataset.sessionName || 'this session';
    if (!sessionId) return;
    const confirmed = await confirmDialog(`Archive ${sessionName}? It will disappear from the default session list, but its saved state is retained.`);
    if (!confirmed) {
      renderAlert('Session archive canceled.');
      return;
    }
    const approval = await buildApprovedActionBody('updateSession', `Archive ${sessionName}?`);
    if (!approval.approved) {
      renderAlert('Session archive canceled.');
      return;
    }
    const response = await api(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        state: 'archived',
      },
    });
    if (response.ok) {
      renderAlert('Session archived.');
      const currentSession = shell.sessions.find((value) => value.id === sessionId);
      const project = currentSession ? shell.projects.find((value) => value.id === currentSession.projectId) : null;
      if (project?.route) {
        window.location.href = project.route;
      } else {
        window.location.href = '/#projects';
      }
      return;
    }
    renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not archive session.'), 'bad');
  }

  if (action === 'renameSession') {
    const sessionId = event.currentTarget.dataset.sessionId;
    const sessionName = event.currentTarget.dataset.sessionName || 'this session';
    const session = shell.sessions.find((value) => value.id === sessionId);
    if (!session) {
      renderAlert('Session not found.');
      return;
    }
    const nextName = await promptDialog(`Rename ${sessionName}`, session.name || '');
    if (nextName === null) {
      renderAlert('Session rename canceled.');
      return;
    }
    const name = String(nextName || '').trim();
    if (!name || name === session.name) {
      renderAlert('Session rename canceled.');
      return;
    }
    const approval = await buildApprovedActionBody('updateSession', `Rename session ${session.name} to ${name}?`);
    if (!approval.approved) {
      renderAlert('Session rename canceled.');
      return;
    }
    const response = await api(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        name,
      },
    });
    if (response.ok) {
      renderAlert('Session renamed.');
      await refresh();
      return;
    }
    renderAlert(response.status === 401 ? authRequiredMessage() : (response.data?.error || 'Could not rename session.'), 'bad');
  }

  if (action === 'editMcpTool') {
    const toolId = event.currentTarget.dataset.toolId;
    if (!toolId) return;
    const tool = shell.mcpTools.find((item) => item.id === toolId || item.name === toolId);
    if (!tool) {
      renderAlert('MCP tool lookup failed. Please refresh.', 'bad');
      return;
    }

    const command = await promptDialog('Update MCP command', tool.command || '');
    if (command === null) return;
    const args = await promptDialog('Update MCP args (comma separated)', (tool.args || []).join(', '));
    if (args === null) return;
    const scope = await promptDialog('Update scope (comma separated)', (tool.scope || ['all']).join(', '));
    if (scope === null) return;
    const normalizedScope = normalizeMcpToolScopes(scope);
    if (normalizedScope.error) {
      renderAlert(normalizedScope.error, 'bad');
      return;
    }
    const notes = await promptDialog('Update notes', tool.notes || '');
    if (notes === null) return;
    const enabled = await promptDialog('Enable this MCP tool? (yes/no)', tool.enabled ? 'yes' : 'no');
    if (enabled === null) return;
    const normalizedEnabled = ['yes', 'y', 'true', '1', 'on'].includes(enabled.trim().toLowerCase());
    const approval = await buildApprovedActionBody('manageMcpTools');
    if (!approval.approved) {
      renderAlert('MCP tool edit canceled.');
      return;
    }

    const response = await api(`/api/mcp/tools/${toolId}`, {
      method: 'PATCH',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        command,
        args: args.split(',').map((value) => value.trim()).filter(Boolean),
        scope: normalizedScope.scopes,
        notes,
        enabled: normalizedEnabled,
      },
    });

    if (response.ok) {
      renderAlert(`MCP tool ${toolId} updated.`);
      await refresh();
    } else if (response.data?.requiresApproval) {
      renderAlert('Approval required to update MCP tool.', 'bad');
    } else {
      renderAlert(response.data?.error || 'Could not update MCP tool.', 'bad');
    }
  }

  if (action === 'refreshExecutorCli') {
    const executorType = event.currentTarget.dataset.executor;
    if (!executorType) return;
    const response = await api(`/api/executors/${encodeURIComponent(executorType)}/cli`);
    if (response.ok) {
      if (!shell.executorCliInfo) shell.executorCliInfo = {};
      shell.executorCliInfo[executorType] = response.data;
      renderAlert(`${executorType.toUpperCase()} CLI info refreshed.`);
      await refresh();
    } else {
      renderAlert(response.data?.error || 'Could not refresh CLI health.', 'bad');
    }
    return;
  }

  if (action === 'reinstallExecutorCli') {
    const executorType = event.currentTarget.dataset.executor;
    if (!executorType) return;
    const useSource = event.currentTarget.dataset.useSource === 'true';
    const sourceMode = Boolean(useSource);
    const sourceCommand = shell.executorCliInfo?.[executorType]?.reinstall?.sourceCommand;
    if (sourceMode && !Array.isArray(sourceCommand)) {
      renderAlert(`${executorType.toUpperCase()} source command is not available.`, 'bad');
      return;
    }
    const planLabel = sourceMode ? 'source reinstall' : 'managed reinstall';
    const confirmedPlan = await confirmDialog(`Plan ${executorType.toUpperCase()} CLI ${planLabel} now?`);
    if (!confirmedPlan) {
      renderAlert('Executor CLI action canceled.');
      return;
    }
    const approval = await buildApprovedActionBody(
      'manageExecutorCli',
      `Approve ${executorType.toUpperCase()} CLI ${planLabel}?`,
    );
    if (!approval.approved) {
      renderAlert('Executor CLI action canceled.');
      return;
    }
    const overridePrompt = `Optional custom reinstall command for ${executorType.toUpperCase()} (space-separated string):\n\nLeave blank to use ${sourceMode ? 'the trusted source-managed command' : 'the managed default command'}.`;
    const overrideCommand = sourceMode ? null : await promptDialog(overridePrompt);
    if (sourceMode && overrideCommand && overrideCommand.trim()) {
      renderAlert('Source mode cannot be combined with a custom command override.', 'bad');
      return;
    }
    const parsedOverride = overrideCommand && overrideCommand.trim() ? overrideCommand.trim() : null;
    const execute = await confirmDialog(`${sourceMode ? 'Run source reinstall' : 'Run managed reinstall'} now (not dry-run)?\nChoose Cancel to only show the planned command.`);
    const confirmedExecute = execute;
    const response = await api(`/api/executors/${encodeURIComponent(executorType)}/cli/reinstall`, {
      method: 'POST',
      body: {
        actor: approval.actor,
        approved: approval.approved,
        execute,
        confirmed: confirmedExecute,
        useSource: sourceMode,
        ...(parsedOverride ? { command: parsedOverride } : {}),
      },
    });
    if (response.ok) {
      if (response.data?.executed) {
        renderAlert(`CLI ${executorType} reinstall executed with status ${response.data.status}.`);
      } else {
        renderAlert(`CLI ${executorType} reinstall planned: ${safeText((response.data?.command || []).join(' '))}`);
      }
      await refresh();
      return;
    }
    if (response.data?.requiresApproval) {
      renderAlert('Approval required for CLI management.', 'bad');
      return;
    }
    renderAlert(response.data?.error || 'CLI management failed.', 'bad');
  }
}
