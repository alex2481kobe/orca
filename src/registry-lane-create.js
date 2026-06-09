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
import { FIRST_CLASS_CLI_EXECUTOR_TYPES } from './executor-factory.js';
import { commandTargetsExecutorFirstToken } from './registry-reinstall.js';
import { createLaneWorktree, describeRepoRoot } from './worktree-manager.js';
import { sanitizeSettingsOverrides } from './effective-settings.js';
import { validateNetworkUrl } from './url-policy.js';
import { normalizeCritiqueMode } from './registry-lane-config.js';

const { QUEUED: QUEUED_STATE } = LANE_STATES;
const MAX_WORKDIR_BYTES = 2048;

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
    const wantsShared = Boolean(sharedWorktree);
    // Per-lane worktree isolation is only possible inside a git working tree.
    // For non-git folders the agent still spawns — it just runs directly in the
    // directory (no isolation), which is how Codex behaves in any folder.
    const repoIsGit = sessionRepoRoot ? describeRepoRoot(sessionRepoRoot).ok : false;
    if (!wantsShared && sessionRepoRoot && !workdir && repoIsGit) {
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
      if (commandParts.length > 0 && !commandTargetsExecutorFirstToken(normalizedExecutorType, commandParts)) {
        throw {
          status: 422,
          message: `Lane command for ${normalizedExecutorType} must target an approved ${normalizedExecutorType} binary.`,
        };
      }
      if (!commandParts.length && executorBinary) {
        const normalizedBinary = String(executorBinary).trim().toLowerCase();
        const binaryName = path.basename(normalizedBinary);
        if (!commandTargetsExecutorFirstToken(normalizedExecutorType, [binaryName])) {
          throw {
            status: 422,
            message: `Lane executor binary for ${normalizedExecutorType} must target an approved ${normalizedExecutorType} binary.`,
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
      executorCapabilities,
      verificationCommand: sanitizedVerificationCommand,
      expectedArtifacts: expectedArtifactsList,
      targetUrl: sanitizedTargetUrl,
      repoRoot: sanitizedRepoRoot,
      branch: sanitizedBranch,
      sharedWorktree: Boolean(sharedWorktree),
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
