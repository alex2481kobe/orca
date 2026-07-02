// Lane creation (worktree provisioning, tool scoping, validation) as a
// prototype mixin for OrcaRegistry. Extracted from registry.js.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LANE_STATES } from './worker-contract.js';
import {
  nowIso,
  clonePayload,
  safeArray,
  normalizeExecutorType,
  buildLaneRoute,
} from './registry-utils.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES, getExecutorProfile } from './executor-factory.js';
import { commandTargetsExecutorFirstToken } from './registry-reinstall.js';
import { createLaneWorktree, describeRepoRoot } from './worktree-manager.js';
import { sanitizeSettingsOverrides } from './effective-settings.js';
import { validateNetworkUrl } from './url-policy.js';
import { normalizeCritiqueMode, normalizeWorktreeMode } from './registry-lane-config.js';
import { sanitizeOrchestratorTurnPolicy } from './orchestrator-turn-policy.js';

const { QUEUED: QUEUED_STATE } = LANE_STATES;
const MAX_WORKDIR_BYTES = 2048;

function executorProfileBinaries(executorType) {
  const profile = getExecutorProfile(executorType) || {};
  return [
    profile.defaultBinary,
    ...safeArray(profile.allowedBinaries),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function firstClassCliTokenAllowed(executorType, token) {
  const text = String(token || '').trim();
  if (!text) return true;
  const configured = executorProfileBinaries(executorType);
  const hasPathSeparator = /[\\/]/.test(text);
  if (!hasPathSeparator) {
    const lower = text.toLowerCase();
    return configured
      .filter((value) => !/[\\/]/.test(value))
      .map((value) => value.toLowerCase())
      .includes(lower)
      && commandTargetsExecutorFirstToken(executorType, [text]);
  }
  if (!path.isAbsolute(text)) return false;
  const resolved = path.resolve(text);
  return configured
    .filter((value) => path.isAbsolute(value))
    .map((value) => path.resolve(value))
    .includes(resolved)
    && commandTargetsExecutorFirstToken(executorType, [path.basename(text)]);
}

export const laneCreateMethods = {
  createLane(sessionLocator, {
    title,
    taskDescription,
    executorType = 'mock',
    command,
    commandArgs = [],
    args,
    executorBinary,
    workdir,
    owner = 'dashboard',
    policyProfile = 'default',
    autoCompleteMs,
    heartbeatMs,
    mcpToolIds = [],
    taskPrompt,
    model,
    permissionsProfile,
    intelligenceProfile,
    speed,
    verificationCommand,
    expectedArtifacts,
    targetUrl,
    critiqueMode,
    settingsOverrides,
    repoRoot,
    branch,
    sharedWorktree,
    auditTargetLaneId,
    metadataTaskId,
    metadataLoopId,
    presentationMode,
    executionMode,
    turnPolicy,
  }, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('createLane', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    if (!title || !String(title).trim()) {
      throw { status: 422, message: 'Lane title is required.' };
    }

    // Auto-create per-lane git worktree when the session has a vetted
    // repoRoot and the lane is not explicitly shared. This is the default
    // isolation model for implementation lanes.
    let workdirOverride = workdir;
    let reservedLaneId = null;
    let derivedWorktree = null;
    let derivedBranch = String(branch || '').trim();
    let derivedRepoRoot = String(repoRoot || '').trim();
    const sessionRepoRoot = session.repoRoot ? String(session.repoRoot).trim() : '';
    const sessionWorktreeMode = normalizeWorktreeMode(session.worktreeMode);
    const sharedExplicit = sharedWorktree !== undefined;
    const wantsShared = sharedExplicit ? Boolean(sharedWorktree) : sessionWorktreeMode === 'shared';
    // Per-lane worktree isolation is only possible inside a git working tree.
    // For non-git folders the agent still spawns — it just runs directly in the
    // directory (no isolation), which is how Codex behaves in any folder.
    const repoIsGit = sessionRepoRoot ? describeRepoRoot(sessionRepoRoot).ok : false;
    if (wantsShared && sessionRepoRoot && !workdir) {
      // Shared-worktree means the executor works in the configured session repo,
      // not the synthetic session workspace. The explicit lane warning below is
      // the guardrail that this mode has conflict risk.
      workdirOverride = sessionRepoRoot;
      derivedRepoRoot = sessionRepoRoot;
    } else if (!wantsShared && sessionRepoRoot && !workdir && repoIsGit) {
      const laneId = randomUUID();
      // Reserve the laneId via the create call below by reusing it for the worktree.
      const result = createLaneWorktree({
        repoRoot: sessionRepoRoot,
        worktreeBase: path.join(this.workspacesRoot, session.id, 'worktrees'),
        laneId,
        branchHint: derivedBranch,
      });
      if (!result.ok) {
        throw { status: 422, message: `Could not create lane worktree: ${result.reason}` };
      }
      workdirOverride = result.worktreePath;
      derivedWorktree = result.worktreePath;
      derivedBranch = result.branch || derivedBranch;
      derivedRepoRoot = result.repoRoot;
      // Reuse this laneId for the lane object below (local, so a later throw in
      // this method can never leak it into a subsequent createLane call).
      reservedLaneId = laneId;
    } else if (!wantsShared && sessionRepoRoot && !workdir && !repoIsGit) {
      // Non-git folder: run the lane directly in the directory.
      workdirOverride = sessionRepoRoot;
      derivedRepoRoot = sessionRepoRoot;
    }
    const resolvedWorkdir = this.resolveLaneWorkdir(session, workdirOverride);

    const normalizedExecutorType = normalizeExecutorType(executorType);
    const supportedExecutorTypes = this.getSupportedExecutorTypes();
    if (!supportedExecutorTypes.includes(normalizedExecutorType)) {
      throw {
        status: 422,
        message: `Lane executorType must be one of: ${supportedExecutorTypes.join(', ')}.`,
      };
    }
    if (FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(normalizedExecutorType)) {
      const commandParts = String(command || '').trim().split(/\s+/).filter(Boolean);
      if (commandParts.length > 0 && !firstClassCliTokenAllowed(normalizedExecutorType, commandParts[0])) {
        throw {
          status: 422,
          message: `Lane command for ${normalizedExecutorType} must start with a configured ${normalizedExecutorType} binary.`,
        };
      }
      if (!commandParts.length && executorBinary) {
        if (!firstClassCliTokenAllowed(normalizedExecutorType, executorBinary)) {
          throw {
            status: 422,
            message: `Lane executor binary for ${normalizedExecutorType} must be a configured ${normalizedExecutorType} binary.`,
          };
        }
      }
    }

    const project = this.projects.find((item) => item.id === session.projectId);
    const now = nowIso();
    const laneId = reservedLaneId || randomUUID();
    const scopedToolIds = new Set(this.listToolsForExecutor(normalizedExecutorType).map((tool) => tool.id));
    const resolvedToolIds = safeArray(mcpToolIds)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    const unknownToolIds = [];
    const disallowedToolIds = [];
    resolvedToolIds.forEach((toolId) => {
      const tool = this.getMcpTool(toolId);
      if (!tool) {
        unknownToolIds.push(toolId);
        return;
      }
      if (!scopedToolIds.has(tool.id) || !tool.enabled) {
        disallowedToolIds.push(tool.id);
      }
    });
    if (unknownToolIds.length || disallowedToolIds.length) {
      const details = [];
      if (unknownToolIds.length) {
        details.push(`Unknown MCP tools: ${unknownToolIds.join(', ')}`);
      }
      if (disallowedToolIds.length) {
        details.push(`Unauthorized MCP tools: ${disallowedToolIds.join(', ')}`);
      }
      throw {
        status: 422,
        message: `Cannot create lane: ${details.join('; ')}`,
      };
    }
    const mcpTools = resolvedToolIds
      .map((id) => this.getMcpTool(id))
      .filter((tool) => tool && scopedToolIds.has(tool.id))
      .filter((tool) => tool && tool.enabled)
      .map((tool) => ({
        id: tool.id,
        name: tool.name,
        command: tool.command,
        args: tool.args,
        scope: tool.scope,
      }));

    const sanitizedTaskPrompt = typeof taskPrompt === 'string' ? taskPrompt.trim().slice(0, 8000) : '';
    const sanitizedModel = typeof model === 'string' ? model.trim().slice(0, 120) : '';
    const sanitizedPermissionsProfile = typeof permissionsProfile === 'string'
      ? permissionsProfile.trim().slice(0, 120) : '';
    const sanitizedIntelligenceProfile = typeof intelligenceProfile === 'string'
      ? intelligenceProfile.trim().slice(0, 80) : '';
    const sanitizedSpeed = typeof speed === 'string' ? speed.trim().slice(0, 24) : '';
    const rawPresentationMode = String(presentationMode || executionMode || '').trim().toLowerCase();
    const sanitizedPresentationMode = rawPresentationMode === 'terminal' ? 'terminal' : 'chat';
    const executorCapabilities = this.getExecutorCapabilities(normalizedExecutorType);
    const sanitizedVerificationCommand = typeof verificationCommand === 'string'
      ? verificationCommand.trim().slice(0, 1000) : '';
    const sanitizedTargetUrl = typeof targetUrl === 'string' && targetUrl.trim()
      ? validateNetworkUrl(targetUrl, { field: 'targetUrl', allowSensitive: false }).url
      : '';
    const normalizedCritiqueMode = normalizeCritiqueMode(
      critiqueMode,
      sanitizedTargetUrl ? 'visual-required' : normalizeCritiqueMode(session.critiqueMode, 'suggested'),
    );
    const sanitizedRepoRoot = (derivedRepoRoot || (typeof repoRoot === 'string' ? repoRoot.trim() : '')).slice(0, MAX_WORKDIR_BYTES);
    const sanitizedBranch = (derivedBranch || (typeof branch === 'string' ? branch.trim() : ''))
      .replace(/[^A-Za-z0-9._\-/]/g, '')
      .slice(0, 200);
    const expectedArtifactsList = Array.isArray(expectedArtifacts)
      ? expectedArtifacts.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 32)
      : [];
    const sanitizedTurnPolicy = owner === 'orchestrator' && turnPolicy
      ? sanitizeOrchestratorTurnPolicy(turnPolicy)
      : null;

    const lane = {
      id: laneId,
      projectId: session.projectId,
      sessionId: session.id,
      title: String(title).trim(),
      taskDescription: String(taskDescription || '').trim(),
      executorType: normalizedExecutorType,
      command,
      commandArgs,
      args,
      executorBinary,
      workdir: resolvedWorkdir,
      policyProfile,
      settingsOverrides: sanitizeSettingsOverrides(settingsOverrides || {}),
      mcpTools,
      mcpToolIds: mcpTools.map((tool) => tool.id),
      taskPrompt: sanitizedTaskPrompt,
      model: sanitizedModel,
      permissionsProfile: sanitizedPermissionsProfile,
      intelligenceProfile: sanitizedIntelligenceProfile,
      speed: sanitizedSpeed,
      presentationMode: sanitizedPresentationMode,
      executorCapabilities,
      verificationCommand: sanitizedVerificationCommand,
      expectedArtifacts: expectedArtifactsList,
      targetUrl: sanitizedTargetUrl,
      repoRoot: sanitizedRepoRoot,
      branch: sanitizedBranch,
      sharedWorktree: wantsShared,
      worktreeMode: wantsShared ? 'shared' : (derivedWorktree ? 'isolated' : 'direct'),
      worktreePath: derivedWorktree || resolvedWorkdir,
      state: QUEUED_STATE,
      owner,
      heartbeatAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      exitReason: null,
      processMeta: null,
      changedFiles: [],
      lastEvidenceCaptureAt: null,
      lastEvidence: null,
      critiqueMode: normalizedCritiqueMode,
      critiqueState: ['required', 'visual-required'].includes(normalizedCritiqueMode) ? 'needed' : 'not_required',
      critiqueRevision: 1,
      critiqueNonce: null,
      critiqueFindings: [],
      auditState: 'not_queued',
      auditFindings: [],
      // Set on a dedicated auditor lane (owner='auditor') — points at the
      // executor lane it was spawned to review.
      auditTargetLaneId: auditTargetLaneId ? String(auditTargetLaneId).slice(0, 80) : null,
      // Set when a backlog task auto-spawns this lane — lets recoverInterruptedTasks
      // relink an 'assigned' task to its already-live lane after a restart instead
      // of blindly requeuing it (which would double-spawn).
      metadataTaskId: metadataTaskId ? String(metadataTaskId).slice(0, 80) : null,
      // Set when a durable loop queues the task that spawned this lane.
      metadataLoopId: metadataLoopId ? String(metadataLoopId).slice(0, 80) : null,
      turnPolicy: sanitizedTurnPolicy,
      route: buildLaneRoute(project.slug, session.id, laneId),
      runProfile: {
        autoCompleteMs: Number.parseInt(autoCompleteMs, 10) || this.autoCompleteMs,
        heartbeatIntervalMs: Number.parseInt(heartbeatMs, 10) || this.heartbeatIntervalMs,
      },
      logs: [
        {
          at: now,
          message: 'Lane queued by controller.',
        },
      ],
      agentEvents: [
        {
          id: randomUUID(),
          at: now,
          type: 'agent.queued',
          source: normalizedExecutorType,
          title: 'Lane queued',
          content: String(taskDescription || sanitizedTaskPrompt || title || '').trim().slice(0, 1000),
        },
      ],
      artifactPath: `/artifacts/${session.id}/${laneId}`,
    };

    if (project) {
      lane.projectSlug = project.slug;
      lane.projectName = project.name;
    }

    this.lanes.push(lane);
    this.recordAudit({
      type: 'lane_created',
      actor: owner,
      projectId: session.projectId,
      sessionId: session.id,
      laneId: lane.id,
      summary: `Lane "${lane.title}" queued`,
      evidence: { lane },
      status: 'passed',
    });
    if (lane.sharedWorktree) {
      // Shared-working-tree is a named exception: stronger conflict risk, so
      // an explicit audit event is queued for review and the lane stores a
      // visible warning the dashboard can surface.
      lane.warnings = [...(lane.warnings || []), {
        kind: 'shared_worktree',
        message: 'Lane is configured to share the session worktree. Concurrent edits may conflict.',
      }];
      this.recordAudit({
        type: 'lane_shared_worktree',
        actor: owner,
        projectId: session.projectId,
        sessionId: session.id,
        laneId: lane.id,
        summary: `Lane "${lane.title}" is shared-worktree; concurrent edits may conflict.`,
        evidence: { laneId: lane.id, workdir: lane.workdir, branch: lane.branch || null },
        status: 'pending',
        followUpQueued: true,
      });
    }
    this.persistState();
    return clonePayload(lane);
  },
};
