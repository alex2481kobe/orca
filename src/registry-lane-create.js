// Lane creation (worktree provisioning, tool scoping, validation) as a
// prototype mixin for OrcaRegistry.

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
import { buildNextActionEnvelope } from './agent-tools/next-action.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES, getExecutorProfile } from './executor-factory.js';
import {
  createLaneWorktree,
  removeLaneWorktree,
  describeRepoRoot,
  changedFilesIn,
} from './worktree-manager.js';
import { sanitizeFlowConfig } from './registry-audit.js';
import { validateNetworkUrl } from './url-policy.js';
import {
  resolveWorktreeMode,
  commandTargetsExecutorFirstToken,
  normalizeApprovedCapacity,
  normalizeSpawnPolicy,
} from './registry-lane-config.js';

const { QUEUED: QUEUED_STATE } = LANE_STATES;
const MAX_WORKDIR_BYTES = 2048;
// Generous cap for the executor task prompt. The command builder supports far
// larger payloads than the old 8000-char limit; truncation past this is recorded
// as a visible lane warning rather than silently dropping scope.
const MAX_TASK_PROMPT_CHARS = 100000;

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
    taskPrompt,
    model,
    permissionsProfile,
    intelligenceProfile,
    speed,
    verificationCommand,
    expectedArtifacts,
    targetUrl,
    flow,
    // Accepted and ignored: the effective-settings cascade is gone.
    settingsOverrides,
    repoRoot,
    branch,
    worktreeMode,
    idleShutdown,
    auditTargetLaneId,
    metadataLoopId,
    presentationMode,
  }, context = {}) {
    // v2: the container is the ORCHESTRATOR record (there are no session records).
    // Resolve it directly; the project's cwd is the repo root; per-lane worktree
    // isolation stays the default for git repos (P2 revisits policy).
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Orchestrator not found.' };
    }
    const project = (this.projects || []).find((item) => item.id === session.projectId);

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

    // Concurrency enforcement: an agent must not fan out past the orchestrator's
    // approved capacity / lane-concurrency limit. Mirror buildCapacity/the
    // scheduler — count LIVE lanes (queued/starting/running) under this container.
    // Auditor lanes are infrastructure the orchestrator spawns to review work, so
    // they don't consume an executor slot. spawnPolicy 'auto'/'within_capacity'
    // enforce the numeric limit; a 0 limit means "unset" → not enforced here.
    const spawnPolicy = normalizeSpawnPolicy(session.spawnPolicy, 'auto');
    const effectiveLimit = normalizeApprovedCapacity(session.approvedCapacity, 0);
    if (effectiveLimit > 0 && owner !== 'auditor') {
      const activeAgents = (this.lanes || []).filter((lane) => (
        lane.sessionId === session.id
        && lane.owner !== 'auditor'
        // laneOccupiesSlot, not isLiveLaneState: a lane that called lane.submit
        // still has a live child, and must keep consuming its slot until it exits.
        && this.laneOccupiesSlot(lane)
      )).length;
      if (activeAgents >= effectiveLimit) {
        throw {
          status: 409,
          message: `Orchestrator is at capacity: ${activeAgents}/${effectiveLimit} lanes are live (spawnPolicy ${spawnPolicy}). Wait for a lane to finish (or accept/stop one) before spawning another.`,
          nextAction: (() => {
            try {
              return buildNextActionEnvelope(this, {
                role: 'orchestrator', projectId: session.projectId, sessionId: session.id, lean: true,
              });
            } catch { return null; }
          })(),
        };
      }
    }

    // Auto-create per-lane git worktree when the session has a vetted
    // repoRoot and the lane is not explicitly shared. This is the default
    // isolation model for implementation lanes.
    let workdirOverride = workdir;
    let reservedLaneId = null;
    let derivedWorktree = null;
    let derivedToolchainSetup = null;
    let derivedBranch = String(branch || '').trim();
    let derivedRepoRoot = String(repoRoot || '').trim();
    const sessionRepoRoot = session.repoRoot ? String(session.repoRoot).trim() : '';
    // Per-lane worktree isolation is only possible inside a git working tree.
    // For non-git folders the agent still spawns — it just runs directly in the
    // directory (no isolation), which is how Codex behaves in any folder.
    const repoIsGit = sessionRepoRoot ? describeRepoRoot(sessionRepoRoot).ok : false;

    // Decide isolation for this lane: an explicit worktreeMode:'isolated' wins,
    // otherwise 'auto' decides from the situation — read-only or sole-writer work
    // runs directly in the checkout (no worktree), and only overlapping writers
    // get an isolated worktree.
    const requestedWorktreeMode = worktreeMode !== undefined ? worktreeMode : 'auto';
    const isReadOnlyLane = String(permissionsProfile || '').trim() === 'read-only';
    // Count QUEUED writers too (laneOccupiesSlot — the same predicate capacity uses
    // above), not just starting/running. Isolation is decided at creation, but lanes start on
    // a scheduler tick: two writers spawned back-to-back were both still `queued` when
    // the second was classified, so both resolved to `direct` and the scheduler then
    // ran both concurrently in the repository root — exactly the collision this is
    // meant to prevent. A queued writer will overlap, so it has to count as one.
    const activeWriterLanes = (this.lanes || []).filter((lane) => (
      lane.sessionId === session.id
      && lane.permissionsProfile !== 'read-only'
      && this.laneOccupiesSlot(lane)
    )).length;
    const resolvedWorktreeMode = resolveWorktreeMode({
      requested: requestedWorktreeMode,
      repoIsGit,
      isReadOnly: isReadOnlyLane,
      activeWriterLanes,
    });

    if (sessionRepoRoot && !workdir) {
      if (resolvedWorktreeMode === 'isolated') {
        const laneId = randomUUID();
        // Reserve the laneId by reusing it for the worktree (local, so a later
        // throw in this method can never leak it into a later createLane call).
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
        derivedToolchainSetup = result.toolchainSetup || null;
        reservedLaneId = laneId;
      } else {
        // direct: run in the repo checkout itself (no worktree). A direct lane is
        // a sole writer or read-only, so in-place editing is safe.
        workdirOverride = sessionRepoRoot;
        derivedRepoRoot = sessionRepoRoot;
      }
    }
    // Everything from here on is validation that can still throw, but the isolated
    // worktree/branch was already provisioned above — so a late refusal used to leak
    // a git worktree and branch that no lane record points at, which ordinary discard
    // and retention cannot find. Undo the provisioning on any failure.
    try {
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
        // SECURITY: for a first-class CLI, ORCA builds the argv (sandbox flags,
        // permission mode, MCP wiring). Raw caller-supplied argv is therefore a
        // sandbox-escape primitive: cli-adapter PREFERS lane.args/commandArgs over the
        // built argv, so `args:["--dangerously-skip-permissions"]` would launch a fully
        // unsandboxed agent while `permissionsProfile` still read "plan" — routing
        // straight around the unsandboxed-permissions gate that a paired device is
        // supposed to fail. Only the first token of `command`/`executorBinary` was
        // ever checked, so everything after it was a free pass. Refuse the fields
        // outright; the generic `cli` executor type exists for bring-your-own-argv.
        const rawArgv = [
          ['args', args],
          ['commandArgs', commandArgs],
        ].filter(([, value]) => Array.isArray(value) && value.length);
        if (rawArgv.length || commandParts.length > 1) {
          const offending = rawArgv.map(([key]) => key).concat(commandParts.length > 1 ? ['command (extra tokens)'] : []);
          throw {
            status: 422,
            message: `Orca builds the command line for ${normalizedExecutorType}; remove ${offending.join(', ')} and pass taskPrompt instead. Use executorType "cli" if you need to supply your own argv.`,
          };
        }
      }

      const now = nowIso();
      const laneId = reservedLaneId || randomUUID();
      // taskPrompt is the executor's whole assignment; the command builder handles
      // very large prompts, so cap generously (was 8000 — small enough to silently
      // drop real scope). If truncation still happens, we do NOT swallow it: a
      // visible warning is recorded on the lane (see below) and logged.
      const rawTaskPrompt = typeof taskPrompt === 'string' ? taskPrompt.trim() : '';
      const taskPromptTruncated = rawTaskPrompt.length > MAX_TASK_PROMPT_CHARS;
      const sanitizedTaskPrompt = taskPromptTruncated ? rawTaskPrompt.slice(0, MAX_TASK_PROMPT_CHARS) : rawTaskPrompt;
      const sanitizedModel = typeof model === 'string' ? model.trim().slice(0, 120) : '';
      const sanitizedPermissionsProfile = typeof permissionsProfile === 'string'
        ? permissionsProfile.trim().slice(0, 120) : '';
      const sanitizedIntelligenceProfile = typeof intelligenceProfile === 'string'
        ? intelligenceProfile.trim().slice(0, 80) : '';
      const sanitizedSpeed = typeof speed === 'string' ? speed.trim().slice(0, 24) : '';
      const rawPresentationMode = String(presentationMode || '').trim().toLowerCase();
      const sanitizedPresentationMode = rawPresentationMode === 'terminal' ? 'terminal' : 'chat';
      const sanitizedVerificationCommand = typeof verificationCommand === 'string'
        ? verificationCommand.trim().slice(0, 1000) : '';
      const sanitizedTargetUrl = typeof targetUrl === 'string' && targetUrl.trim()
        ? validateNetworkUrl(targetUrl, { field: 'targetUrl', allowSensitive: false }).url
        : '';
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
        // When the container is an orchestrator, group the executor under it in
        // the overview tree; null when the container has no orchestrator.
        orchestratorId: session.orchestratorId || null,
        title: String(title).trim(),
        taskDescription: String(taskDescription || '').trim(),
        executorType: normalizedExecutorType,
        command,
        commandArgs,
        args,
        executorBinary,
        workdir: resolvedWorkdir,
        policyProfile,
        flow: sanitizeFlowConfig(flow || {}),
        taskPrompt: sanitizedTaskPrompt,
        model: sanitizedModel,
        permissionsProfile: sanitizedPermissionsProfile,
        intelligenceProfile: sanitizedIntelligenceProfile,
        speed: sanitizedSpeed,
        presentationMode: sanitizedPresentationMode,
        verificationCommand: sanitizedVerificationCommand,
        expectedArtifacts: expectedArtifactsList,
        targetUrl: sanitizedTargetUrl,
        repoRoot: sanitizedRepoRoot,
        branch: sanitizedBranch,
        worktreeMode: resolvedWorktreeMode,
        worktreePath: derivedWorktree || resolvedWorkdir,
        toolchainSetup: derivedToolchainSetup,
        // Idle-shutdown policy for this lane + the last time it showed activity
        // (output/heartbeat/state change). The scheduler reaps a running lane idle
        // past its window per this mode. Default 'immediate'; 'policy' never reaps.
        // Opt-out only: anything other than an explicit false means auto-reap.
        idleShutdown: idleShutdown !== false,
        lastActivityAt: now,
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
        // Direct lanes share the checkout, so terminal git status must be scoped
        // against the dirt that was already present when this lane was created.
        changedFilesBaseline: changedFilesIn(resolvedWorkdir),
        lastEvidenceCaptureAt: null,
        lastEvidence: null,
        auditState: 'not_queued',
        auditFindings: [],
        // Set on a dedicated auditor lane (owner='auditor') — points at the
        // executor lane it was spawned to review.
        auditTargetLaneId: auditTargetLaneId ? String(auditTargetLaneId).slice(0, 80) : null,
        // Inert lane metadata (nullable passthrough).
        // Set when a durable loop queues the task that spawned this lane.
        metadataLoopId: metadataLoopId ? String(metadataLoopId).slice(0, 80) : null,
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
      if (taskPromptTruncated) {
        // Do NOT drop scope silently: surface a visible warning (like shared-worktree)
        // and a log line so the operator/orchestrator can see the prompt was clipped.
        lane.warnings = [...(lane.warnings || []), {
          kind: 'task_prompt_truncated',
          message: `taskPrompt was truncated from ${rawTaskPrompt.length} to ${MAX_TASK_PROMPT_CHARS} chars; some scope may be missing.`,
        }];
        lane.logs.push({
          at: now,
          message: `taskPrompt truncated from ${rawTaskPrompt.length} to ${MAX_TASK_PROMPT_CHARS} chars.`,
        });
      }
      if (derivedToolchainSetup) {
        const unavailable = derivedToolchainSetup.status !== 'linked';
        lane.warnings = [...(lane.warnings || []), {
          kind: unavailable ? 'toolchain_setup_incomplete' : 'shared_dependency_links',
          message: derivedToolchainSetup.message,
          issues: derivedToolchainSetup.issues,
        }];
        lane.logs.push({
          at: now,
          message: `Isolated worktree toolchain setup (${derivedToolchainSetup.status}): ${derivedToolchainSetup.message}`,
        });
      }
      this.persistState();
      // Guide the spawning orchestrator to observe the new lane (and, once it
      // finishes, audit it) without a separate status round-trip.
      const result = clonePayload(lane);
      try {
        const env = buildNextActionEnvelope(this, {
          role: 'orchestrator', projectId: session.projectId, sessionId: session.id, laneId: lane.id, lean: true,
        });
        result.nextAction = { ...env, nextRequiredTool: 'lane.get' };
      } catch { /* envelope is best-effort guidance */ }
      return result;
    } catch (error) {
      if (derivedWorktree) {
        try {
          removeLaneWorktree({
            repoRoot: derivedRepoRoot || sessionRepoRoot,
            worktreePath: derivedWorktree,
            branch: derivedBranch,
            removeBranch: true,
            force: true,
          });
        } catch { /* cleanup is best-effort; never mask the original refusal */ }
      }
      throw error;
    }
  },
};
