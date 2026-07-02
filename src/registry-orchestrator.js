// Orchestrator chat thread + message-send methods, as a prototype mixin for
// OrcaRegistry. Extracted from registry.js.

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload, normalizeExecutorType, isPathWithinBoundary } from './registry-utils.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES } from './executor-factory.js';
import { buildNextActionEnvelope, findTool } from './agent-tools.js';
import { renderLaneTree } from './render-lane-tree.js';
import { readRepoGitInfo } from './worktree-manager.js';

const MAX_ORCHESTRATOR_THREAD_MESSAGES = 500;
// An active orchestrator that hasn't called a tool in this long is considered
// stale, so a fresh chat can take over without forcing an explicit takeover.
const ORCHESTRATOR_STALE_MS = 15 * 60 * 1000;
// Mutating orchestrator tools that must stay callable regardless of ownership:
// you call enroll/resign to change ownership, and create a session before one
// can have an owner.
const OWNERSHIP_EXEMPT_TOOLS = new Set([
  'orchestrator.enroll',
  'orchestrator.resign',
  'project.create',
  'session.create',
]);

function safeChatText(value, max = 12000) {
  return String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

function isLightweightConversation(value) {
  const text = safeChatText(value, 1000).toLowerCase();
  if (!text) return false;
  const compact = text.replace(/[^a-z0-9\s'?]/g, ' ').replace(/\s+/g, ' ').trim();
  const objective =
    /\b(build|fix|test|audit|review|implement|create|run|start|launch|setup|set up|deploy|commit|push|update|change|delete|merge|rebase|install|debug|investigate|clean|refactor|write|read|summarize|plan)\b/;
  if (objective.test(compact)) return false;

  const words = compact.split(/\s+/).filter(Boolean);
  if (words.length > 20) return false;

  const projectScope = /\b(repo|repository|project|app|server|client|ui|dashboard|session|lane|agent|executor|orchestrator|supervisor|backlog|branch|commit|pr|test|bug|error|file|code|setting|settings|flow)\b/;
  const requestShape = /\b(can you|could you|would you|should we|do we|i need|i want|please|let's|lets)\b/;
  return !(projectScope.test(compact) && requestShape.test(compact));
}

function remediationForText(value) {
  const text = safeChatText(value, 1000).toLowerCase();
  if (!text) return 'Open the lane details for the last error and retry after the blocker is cleared.';
  if (/rate.?limit|429|quota|usage limit|too many requests/.test(text)) {
    return 'Wait for the provider limit to reset, then resume or retry. Switch executors if the work is urgent.';
  }
  if (/auth|login|log in|unauthorized|forbidden|credential|api key|token|not logged in/.test(text)) {
    return 'Run the CLI login/setup command on this workstation, then retry the turn.';
  }
  if (/enoent|not found|not executable|binary|command failed to launch/.test(text)) {
    return 'Install the selected CLI or update its path in Settings > Agents, then restart/retry.';
  }
  if (/approval|permission|bypass|yolo|force|unsandboxed/.test(text)) {
    return 'Use a sandboxed mode, or approve the higher-risk action from the workstation.';
  }
  if (/workdir|workspace|outside allowed|repo root|path/.test(text)) {
    return 'Check the project workspace/repo root in Settings or pick a valid project folder.';
  }
  return 'Explain the blocker plainly and point the user to the lane details if logs are needed.';
}

function buildOperatorIssueContext({ executorCapabilities = null, selectedExecutorType = '', sessionLanes = [] } = {}) {
  const issues = [];
  const recentProblemLanes = (Array.isArray(sessionLanes) ? sessionLanes : [])
    .filter((lane) => ['failed', 'blocked', 'stopped', 'fix_requested'].includes(String(lane?.state || '').toLowerCase()))
    .sort((a, b) => Date.parse(b.updatedAt || b.completedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.completedAt || a.createdAt || 0))
    .slice(0, 4);
  for (const lane of recentProblemLanes) {
    const reason = safeChatText(lane.exitReason || lane.resultText || lane.title || 'Agent stopped before completing.', 500);
    const executor = safeChatText(lane.executorType || 'agent', 80);
    issues.push(`- Recent ${executor} lane "${safeChatText(lane.title || lane.id, 120)}" is ${safeChatText(lane.state, 40)}: ${reason}. User action: ${remediationForText(reason)}`);
  }

  const selected = normalizeExecutorType(selectedExecutorType);
  const capabilities = executorCapabilities && typeof executorCapabilities === 'object' ? executorCapabilities : {};
  for (const type of FIRST_CLASS_CLI_EXECUTOR_TYPES) {
    const info = capabilities[type];
    if (!info || info.kind !== 'cli' || info.binaryExists) continue;
    const selectedNote = selected === type ? ' Selected for this turn.' : '';
    issues.push(`- ${info.displayName || type}: CLI is not executable.${selectedNote} User action: install/configure ${info.binary || type} in Settings > Agents, then retry.`);
  }

  return issues.slice(0, 8).join('\n');
}

function modelValuesFromCapabilities(capabilities) {
  const node = capabilities?.controls?.model || {};
  const values = Array.isArray(node.values) ? node.values : [];
  const catalog = Array.isArray(node.catalog) ? node.catalog.map((entry) => entry?.slug) : [];
  return new Set([...values, ...catalog].map((value) => String(value || '').trim()).filter(Boolean));
}

function defaultModelFromCapabilities(capabilities) {
  const node = capabilities?.controls?.model || {};
  const explicit = String(node.defaultValue || '').trim();
  if (explicit) return explicit;
  const values = [...modelValuesFromCapabilities(capabilities)];
  return values[0] || '';
}

function normalizeRequestedModelForExecutor({ executorCapabilities = {}, executorType = '', model = '' } = {}) {
  const requested = safeChatText(model, 200);
  if (!requested) return '';
  const selected = normalizeExecutorType(executorType);
  const selectedValues = modelValuesFromCapabilities(executorCapabilities?.[selected]);
  if (selectedValues.has(requested)) return requested;
  // Free-text models are allowed. Only correct a model when the selected runtime is
  // one of the first-class CLIs and the requested slug is explicitly advertised by
  // a different first-class CLI (e.g. claude/opus leaking into a codex turn).
  if (!FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(selected)) return requested;
  const belongsToOtherCli = FIRST_CLASS_CLI_EXECUTOR_TYPES.some((other) =>
    other !== selected && modelValuesFromCapabilities(executorCapabilities?.[other]).has(requested));
  return belongsToOtherCli ? defaultModelFromCapabilities(executorCapabilities?.[selected]) : requested;
}

function buildOrchestratorPrompt({
  project,
  session,
  message,
  messages = [],
  model = '',
  permissionsProfile = '',
  intelligenceProfile = '',
  baseUrl = '',
  nextActionUrl = '',
  discoveryUrl = '',
  executorCapabilities = null,
  operatorIssueContext = '',
} = {}) {
  const transcript = messages
    .slice(-20)
    .map((entry) => `${String(entry.role || 'user').toUpperCase()}: ${safeChatText(entry.content, 3000)}`)
    .join('\n\n');
  const apiBase = String(baseUrl || '').replace(/\/+$/, '');
  const conversational = isLightweightConversation(message);
  if (conversational) {
    return [
      'You are the Orca chat and orchestration agent for this project/session.',
      'The current user message is conversational, not an actionable project objective.',
      'Reply like a normal capable agent: brief, direct, and useful. Keep internal Orca tool names out of the user-facing answer. Do not create executor lanes, backlog items, or tool calls unless the user gives an actual objective.',
      'Treat filesystem paths, account names, repository URLs, environment variables, and local metadata as operational context. Avoid surfacing that metadata unless it helps answer the user.',
      'If helpful, offer one simple next step they can ask Orca to do.',
      `Project: ${project?.name || project?.id || 'unknown'}`,
      `Session: ${session?.name || session?.id || 'unknown'}`,
      model ? `Requested model: ${safeChatText(model, 120)}` : '',
      permissionsProfile ? `Run mode / permissions: ${safeChatText(permissionsProfile, 120)}` : '',
      intelligenceProfile ? `Requested intelligence level: ${safeChatText(intelligenceProfile, 80)}` : '',
      operatorIssueContext ? `Known local issues, if relevant:\n${safeChatText(operatorIssueContext, 2500)}` : '',
      transcript ? `Recent conversation:\n${transcript}` : '',
      `Current user message:\n${safeChatText(message)}`,
    ].filter(Boolean).join('\n\n');
  }
  return [
    'You are the Orca orchestration agent for this project/session.',
    'Read the current user request before acting. If a future message has no actionable project objective, answer conversationally instead of forcing orchestration.',
    'Own decomposition, planning, lane creation, executor assignment, and audit handoff.',
    'Do not ask the human to manually create executor lanes when you can create them through Orca tools.',
    'Keep internal Orca tool names out of user-facing chat. Use available tools when needed; if a tool is unavailable, state the plain blocker and continue with the useful next step.',
    'Treat filesystem paths, account names, repository URLs, environment variables, and local metadata as operational context. Avoid surfacing that metadata unless it helps answer the user.',
    'Use the scoped tool lease from ORCA_TOOL_LEASE_TOKEN, never the full API token.',
    `Project: ${project?.name || project?.id || 'unknown'}`,
    `Session: ${session?.name || session?.id || 'unknown'}`,
    model ? `Requested model: ${safeChatText(model, 120)}` : '',
    permissionsProfile ? `Run mode / permissions: ${safeChatText(permissionsProfile, 120)}` : '',
    intelligenceProfile ? `Requested intelligence level: ${safeChatText(intelligenceProfile, 80)}` : '',
    session?.repoRoot ? `Repository root: ${session.repoRoot}` : `Session workspace: ${session?.worktreeRoot || ''}`,
    transcript ? `Recent conversation:\n${transcript}` : '',
    `Current user request:\n${safeChatText(message)}`,
    apiBase ? `Orca base URL: ${apiBase}` : '',
    discoveryUrl ? `Tool discovery URL: ${discoveryUrl}` : '',
    nextActionUrl ? `Next-action URL: ${nextActionUrl}` : '',
    'For HTTP tool calls, send header x-orca-tool-lease: $ORCA_TOOL_LEASE_TOKEN.',
    executorCapabilities ? `Executor capability matrix available to you:\n${safeChatText(JSON.stringify(executorCapabilities, null, 2), 6000)}` : '',
    operatorIssueContext ? `Operator issue context (plain language; use this to explain blockers simply, not as internal tool instructions):\n${safeChatText(operatorIssueContext, 2500)}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildBranchInstruction(branchHint, session) {
  const hint = safeChatText(branchHint, 200);
  if (!hint) return '';
  let remoteBranches = [];
  try {
    remoteBranches = session?.repoRoot ? readRepoGitInfo(session.repoRoot).remoteBranches || [] : [];
  } catch {
    remoteBranches = [];
  }
  const remoteLike = remoteBranches.includes(hint) || /^(origin|upstream)\//.test(hint);
  if (remoteLike) {
    return `Use git ref ${hint} as the base/reference. If you need to commit changes, create a local workflow branch from it instead of checking out the remote tracking ref directly.`;
  }
  return `Work on git branch: ${hint} (create or switch to it before making changes).`;
}

export const orchestratorMethods = {
  ensureOrchestratorThread(session) {
    if (!session.orchestratorThread || typeof session.orchestratorThread !== 'object') {
      session.orchestratorThread = {
        id: randomUUID(),
        messages: [],
        laneIds: [],
        activeLaneId: null,
        executorType: null,
        updatedAt: nowIso(),
      };
    }
    if (!Array.isArray(session.orchestratorThread.messages)) {
      session.orchestratorThread.messages = [];
    }
    if (session.orchestratorThread.messages.length > MAX_ORCHESTRATOR_THREAD_MESSAGES) {
      session.orchestratorThread.messages = session.orchestratorThread.messages.slice(-MAX_ORCHESTRATOR_THREAD_MESSAGES);
    }
    if (!Array.isArray(session.orchestratorThread.laneIds)) {
      session.orchestratorThread.laneIds = [];
    }
    return session.orchestratorThread;
  },

  appendOrchestratorThreadMessage(thread, message) {
    if (!thread || !message) return;
    if (!Array.isArray(thread.messages)) {
      thread.messages = [];
    }
    thread.messages.push(message);
    if (thread.messages.length > MAX_ORCHESTRATOR_THREAD_MESSAGES) {
      thread.messages = thread.messages.slice(-MAX_ORCHESTRATOR_THREAD_MESSAGES);
    }
  },

  // --- Active-orchestrator ownership (enroll / resign / status) -------------
  // A chat driving Orca over MCP binds its already-issued orchestrator lease to a
  // session and claims the active-orchestrator marker, so a single owner is
  // visible and handoff (resign/takeover) is coordinated. enroll does NOT mint or
  // re-scope a lease — the lease is the identity; this only records ownership.

  _leaseActiveById(leaseId) {
    if (!leaseId || leaseId === 'dashboard') return null;
    const lease = (this.toolLeases || []).find((item) => item.id === leaseId);
    if (!lease) return { found: false, active: false };
    const active = !lease.revokedAt && Date.parse(lease.expiresAt) > Date.now();
    return { found: true, active, lease };
  },

  // Can an orchestrator actually act on an audit nudge for this session? Used to
  // reconcile orchestrator-tier audits stuck in 'auditing'. This deliberately does
  // NOT use _activeOrchestratorStale's idle-time check: a lane stuck in 'auditing'
  // itself counts as session activity there, which would circularly keep a dead
  // orchestrator looking "live". A dashboard orchestrator is treated as able to act
  // (the local operator can accept via the UI); an MCP orchestrator can act only
  // while its lease is alive.
  _orchestratorCanAudit(session) {
    const active = session?.orchestratorThread?.activeOrchestrator;
    if (!active) return false;
    if (active.leaseId === 'dashboard' || !active.leaseId) return true;
    const status = this._leaseActiveById(active.leaseId);
    return Boolean(status && status.active);
  },

  _activeOrchestratorStale(marker, session = null) {
    if (!marker) return true;
    // A dead/revoked/expired lease is always stale.
    if (marker.leaseId && marker.leaseId !== 'dashboard') {
      const status = this._leaseActiveById(marker.leaseId);
      if (!status || !status.active) return true;
    }
    const last = Date.parse(marker.lastSeenAt || marker.enrolledAt || 0);
    const idleTooLong = Number.isFinite(last) && (Date.now() - last) > ORCHESTRATOR_STALE_MS;
    if (!idleTooLong) return false;
    // Idle on Orca tools for a while — but a live owner whose lanes are still
    // running shouldn't lose the lock (a long build legitimately keeps the
    // orchestrator off the tool surface). Only a quiet, lane-less session is stale.
    if (session && (this.lanes || []).some((lane) => lane.sessionId === session.id
      && ['queued', 'starting', 'running', 'needs_critique', 'ready_for_audit', 'auditing', 'fix_requested'].includes(lane.state))) {
      return false;
    }
    return true;
  },

  publicActiveOrchestrator(marker, session = null) {
    if (!marker) return { active: false };
    return {
      active: true,
      actor: marker.actor || null,
      leaseId: marker.leaseId || null,
      role: marker.role || 'orchestrator',
      source: marker.source || 'mcp',
      enrolledAt: marker.enrolledAt || null,
      lastSeenAt: marker.lastSeenAt || null,
      stale: this._activeOrchestratorStale(marker, session),
    };
  },

  enrollOrchestrator(sessionLocator, { leaseId = 'dashboard', actor = 'orchestrator', source = 'mcp', takeover = false } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const thread = this.ensureOrchestratorThread(session);
    const current = thread.activeOrchestrator || null;
    if (current && current.leaseId !== leaseId && !this._activeOrchestratorStale(current, session)) {
      if (!takeover) {
        throw {
          status: 409,
          message: 'Session already has an active orchestrator. Pass takeover:true to take over.',
          current: this.publicActiveOrchestrator(current),
        };
      }
      this.recordAudit({
        type: 'orchestrator_resigned',
        actor: String(actor || 'orchestrator').slice(0, 120),
        projectId: session.projectId,
        sessionId: session.id,
        summary: `Orchestrator ${current.actor || current.leaseId} replaced by takeover`,
        status: 'passed',
        evidence: { reason: 'takeover', previousLeaseId: current.leaseId },
      });
    }
    const now = nowIso();
    thread.activeOrchestrator = {
      leaseId: leaseId || 'dashboard',
      actor: String(actor || 'orchestrator').slice(0, 120),
      role: 'orchestrator',
      source: String(source || 'mcp').slice(0, 24),
      enrolledAt: now,
      lastSeenAt: now,
    };
    thread.updatedAt = now;
    this.recordAudit({
      type: 'orchestrator_enrolled',
      actor: thread.activeOrchestrator.actor,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Orchestrator enrolled for session "${session.name}"`,
      status: 'passed',
      evidence: { leaseId: thread.activeOrchestrator.leaseId, source: thread.activeOrchestrator.source },
    });
    this.persistState();
    return {
      enrolled: true,
      activeOrchestrator: this.publicActiveOrchestrator(thread.activeOrchestrator),
      sessionId: session.id,
    };
  },

  resignOrchestrator(sessionLocator, { leaseId = 'dashboard', reason = 'resigned' } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const thread = this.ensureOrchestratorThread(session);
    const current = thread.activeOrchestrator || null;
    if (!current) return { released: false, sessionId: session.id };
    if (current.leaseId !== leaseId && leaseId !== 'dashboard') {
      throw { status: 403, message: 'Only the active orchestrator (or a dashboard operator) may resign this session.' };
    }
    thread.activeOrchestrator = null;
    thread.updatedAt = nowIso();
    this.recordAudit({
      type: 'orchestrator_resigned',
      actor: String(current.actor || 'orchestrator').slice(0, 120),
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Orchestrator resigned from session "${session.name}"`,
      status: 'passed',
      evidence: { reason: String(reason || 'resigned').slice(0, 200), leaseId: current.leaseId },
    });
    this.persistState();
    return { released: true, sessionId: session.id };
  },

  getActiveOrchestrator(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const thread = this.ensureOrchestratorThread(session);
    return this.publicActiveOrchestrator(thread.activeOrchestrator || null, session);
  },

  // Exclusive ownership enforcement: an external orchestrator lease must enroll
  // with the session before it can mutate session state. A different live owner
  // is refused, and a stale/missing owner must be refreshed through
  // orchestrator.enroll before work continues. Called from the server's
  // agent-tool gate for every lease-authed mutating call.
  assertOrchestratorOwnership({ toolId, sessionId, lease } = {}) {
    if (!toolId || !sessionId || !lease) return;
    if (String(lease.role) !== 'orchestrator') return; // executor/auditor are lane-scoped
    if (OWNERSHIP_EXEMPT_TOOLS.has(toolId)) return;
    const tool = findTool(toolId);
    if (!tool || !tool.mutating) return; // reads are always allowed
    const session = this.getSession(sessionId);
    if (!session) return;
    const thread = this.ensureOrchestratorThread(session);
    const marker = thread.activeOrchestrator;
    const nextAction = buildNextActionEnvelope(this, {
      role: 'orchestrator',
      projectId: session.projectId,
      sessionId: session.id,
    });
    if (!marker) {
      throw {
        status: 409,
        message: `No active orchestrator is registered for session "${session.name}". Call orchestrator.enroll before mutating it.`,
        nextAction,
      };
    }
    if (marker.leaseId === lease.id) {
      // Caller is the owner; keep it fresh so it doesn't go stale mid-run.
      marker.lastSeenAt = nowIso();
      return;
    }
    if (this._activeOrchestratorStale(marker, session)) {
      throw {
        status: 409,
        message: `The active orchestrator for session "${session.name}" is stale. Call orchestrator.enroll with takeover:true before mutating it.`,
        nextAction,
      };
    }
    throw {
      status: 409,
      message: `You are not the active orchestrator for session "${session.name}" (held by ${marker.actor || marker.leaseId}). Call orchestrator.enroll with takeover:true to take over before mutating it.`,
      nextAction,
    };
  },

  // The canonical "what is happening" view: ownership + the lane tree + flow and
  // the next required tool. Composes existing read helpers; read-only.
  orchestratorStatus(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const lanes = this.listLanesCompact(session.id);
    let backlog = null;
    try { backlog = this.sessionBacklogStatus(session.id); } catch { backlog = null; }
    const envelope = buildNextActionEnvelope(this, {
      role: 'orchestrator',
      projectId: session.projectId,
      sessionId: session.id,
      lean: true, // status is polled; skip the heavy capability matrix
    });
    const tree = renderLaneTree({ name: session.name }, lanes, { backlog: backlog || undefined });
    return clonePayload({
      sessionId: session.id,
      sessionName: session.name,
      activeOrchestrator: this.getActiveOrchestrator(session.id),
      supervisorReview: session.supervisorReview || null,
      backlog,
      flow: envelope.flow,
      capacity: envelope.capacity,
      nextRequiredTool: envelope.nextRequiredTool,
      lanes,
      tree,
    });
  },

  getOrchestratorThread(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const thread = this.ensureOrchestratorThread(session);
    return clonePayload({
      ...thread,
      sessionId: session.id,
      projectId: session.projectId,
      activeLane: thread.activeLaneId ? this.getLane(thread.activeLaneId) || null : null,
    });
  },

  notifyOrchestratorManualLaneStop(lane, actor = 'dashboard', reason = '') {
    if (!lane || lane.owner === 'orchestrator') return;
    if (!['dashboard', 'operator', 'user'].includes(String(actor || '').toLowerCase())) return;
    const session = this.getSession(lane.sessionId);
    if (!session) return;
    const thread = this.ensureOrchestratorThread(session);
    const activeLaneId = thread.activeLaneId || '';
    const hasOrchestrator = activeLaneId || (Array.isArray(thread.laneIds) && thread.laneIds.length);
    if (!hasOrchestrator) return;
    this.appendOrchestratorThreadMessage(thread, {
      id: randomUUID(),
      role: 'system',
      content: `Operator manually stopped executor lane "${lane.title}". Reason: ${reason || 'stopped by dashboard'}.`,
      laneId: lane.id,
      createdAt: nowIso(),
    });
    thread.updatedAt = nowIso();
  },

  resolveOrchestratorExecutorType(session, requestedType = '') {
    const supported = this.getSupportedExecutorTypes();
    const requested = normalizeExecutorType(requestedType);
    if (requested && supported.includes(requested)) return requested;
    const leader = normalizeExecutorType(session?.leader);
    if (leader && supported.includes(leader) && leader !== 'mock') return leader;
    // Prefer claude for the orchestrator turn when no explicit/leader choice:
    // it's the only headless CLI that can drive Orca's MCP tools (approvals route
    // through --permission-prompt-tool). codex `exec` cancels MCP tool calls under
    // any sandbox, so it can't orchestrate Orca tools — an explicit codex choice
    // above still wins, but the auto default should be the one that works.
    if (supported.includes('claude')) {
      try { if (this.getExecutorCapabilities('claude')?.binaryExists) return 'claude'; } catch { /* fall through */ }
    }
    // Otherwise the first INSTALLED first-class CLI; fall back to codex, then mock.
    for (const type of FIRST_CLASS_CLI_EXECUTOR_TYPES) {
      if (!supported.includes(type)) continue;
      try { if (this.getExecutorCapabilities(type)?.binaryExists) return type; } catch { /* keep looking */ }
    }
    return supported.includes('codex') ? 'codex' : 'mock';
  },

  async sendOrchestratorMessage(sessionLocator, {
    message,
    executorType,
    model,
    permissionsProfile,
    intelligenceProfile,
    speed,
    branch,
    executionMode,
    targetUrl,
    attachments = [],
    baseUrl = '',
    discoveryUrl = '',
    nextActionUrl = '',
  } = {}, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const text = safeChatText(message);
    const attachmentList = (Array.isArray(attachments) ? attachments : [])
      .filter((entry) => entry && (entry.path || entry.url))
      .slice(0, 20);
    if (!text && !attachmentList.length) throw { status: 422, message: 'Message or attachment is required.' };

    // Resolve each attachment's server-side absolute path from its /artifacts URL
    // (never trust a client-supplied path), contained under this session only.
    const sessionArtifactsRoot = path.join(process.cwd(), 'artifacts', String(session.id));
    const resolveAttachmentPath = async (entry) => {
      const url = String(entry.url || '');
      if (!url.startsWith('/artifacts/')) {
        throw { status: 422, message: 'Attachment URL must reference a session artifact.' };
      }
      let pathname;
      try {
        pathname = new URL(url, 'http://orca.local').pathname;
      } catch {
        throw { status: 422, message: 'Attachment URL is invalid.' };
      }
      let decoded;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        throw { status: 422, message: 'Attachment URL encoding is invalid.' };
      }
      const abs = path.join(process.cwd(), decoded.replace(/^\/+/, ''));
      if (!isPathWithinBoundary(abs, sessionArtifactsRoot)) {
        throw { status: 422, message: 'Attachment URL must belong to the current session.' };
      }
      let stats;
      try {
        stats = await fs.lstat(abs);
      } catch {
        throw { status: 422, message: 'Attachment file does not exist.' };
      }
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw { status: 422, message: 'Attachment file is not a regular file.' };
      }
      try {
        const realPath = await fs.realpath(abs);
        const realSessionRoot = await fs.realpath(sessionArtifactsRoot);
        if (!isPathWithinBoundary(realPath, realSessionRoot)) {
          throw { status: 422, message: 'Attachment path escapes the current session.' };
        }
      } catch (error) {
        if (error?.status) throw error;
        throw { status: 422, message: 'Attachment path could not be resolved.' };
      }
      return abs;
    };
    const resolvedAttachmentPaths = attachmentList.length
      ? await Promise.all(attachmentList.map(resolveAttachmentPath))
      : [];

    const project = this.getProject(session.projectId);
    const thread = this.ensureOrchestratorThread(session);
    const now = nowIso();
    const userMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      attachments: attachmentList.map((entry) => ({
        name: String(entry.name || 'attachment').slice(0, 200),
        url: String(entry.url || '').slice(0, 500),
        contentType: String(entry.contentType || '').slice(0, 120),
      })),
      createdAt: now,
    };
    this.appendOrchestratorThreadMessage(thread, userMessage);
    const branchHint = String(branch || '').trim().slice(0, 200);
    const baseText = attachmentList.length
      ? `${text}\n\nAttached files (absolute paths you can read):\n${resolvedAttachmentPaths.map((p) => `- ${p}`).join('\n')}`
      : text;
    // The composer branch picker is an instruction for the agent: local branch
    // hints can be switched/created directly; remote refs are base refs for a
    // local workflow branch.
    const branchInstruction = buildBranchInstruction(branchHint, session);
    const promptText = branchInstruction
      ? `${baseText}\n\n${branchInstruction}`
      : baseText;

    const resolvedExecutorType = this.resolveOrchestratorExecutorType(session, executorType);
    const executorCapabilities = this.getExecutorCapabilitiesMatrix();
    const effectiveModel = normalizeRequestedModelForExecutor({
      executorCapabilities,
      executorType: resolvedExecutorType,
      model,
    });
    const sessionLanes = this.lanes.filter((laneItem) => laneItem.sessionId === session.id);
    const operatorIssueContext = buildOperatorIssueContext({
      executorCapabilities,
      selectedExecutorType: resolvedExecutorType,
      sessionLanes,
    });
    const turnNumber = thread.messages.filter((entry) => entry.role === 'user').length;
    const workdir = session.repoRoot || session.worktreeRoot;
    let lane;
    try {
      lane = await this.createLane(session.id, {
        title: `Orchestrator turn ${turnNumber}`,
        taskDescription: (text || '(attachment)').slice(0, 1000),
        executorType: resolvedExecutorType,
        owner: 'orchestrator',
        workdir,
        sharedWorktree: true,
        taskPrompt: buildOrchestratorPrompt({
          project,
          session,
          message: promptText,
          messages: thread.messages,
          model: effectiveModel,
          permissionsProfile,
          intelligenceProfile,
          baseUrl,
          discoveryUrl,
          nextActionUrl,
          executorCapabilities,
          operatorIssueContext,
        }),
        model: effectiveModel,
        permissionsProfile,
        intelligenceProfile,
        speed,
        presentationMode: String(executionMode || '').trim().toLowerCase() === 'terminal' ? 'terminal' : 'chat',
        branch: branchHint,
        targetUrl,
      }, {
        actor: context.actor || 'dashboard',
        approved: context.approved,
      });
    } catch (error) {
      thread.messages = thread.messages.filter((entry) => entry.id !== userMessage.id);
      throw error;
    }

    const nextAction = context.nextAction || null;
    let lease = null;
    if (nextAction && Array.isArray(nextAction.allowedTools) && nextAction.allowedTools.length) {
      lease = this.createToolLease({
        role: 'orchestrator',
        projectId: session.projectId,
        sessionId: session.id,
        laneId: lane.id,
        allowedTools: nextAction.allowedTools,
        ttlMs: 24 * 60 * 60 * 1000,
        actor: 'orchestrator-bootstrap',
      });
      // The agent runs ON the workstation, so it must reach Orca over LOOPBACK —
      // never the request's (possibly remote/tailnet) origin, which would force a
      // local process to round-trip through the tailnet (latency + a hard
      // dependency that breaks tool calls if the device URL isn't self-reachable).
      const localBase = typeof this.serverBaseUrl === 'function' ? this.serverBaseUrl() : String(baseUrl || '');
      this.laneRuntimeEnv.set(String(lane.id), {
        ORCA_TOOL_LEASE_TOKEN: lease.leaseToken,
        ORCA_AGENT_TOOLS_BASE_URL: localBase,
        ORCA_AGENT_TOOLS_DISCOVERY_URL: `${localBase}/api/agent-tools/discovery`,
        ORCA_AGENT_TOOLS_NEXT_ACTION_URL: `${localBase}/api/agent-tools/next-action?role=orchestrator&projectId=${encodeURIComponent(session.projectId)}&sessionId=${encodeURIComponent(session.id)}`,
      });
    }

    thread.laneIds = [...new Set([...thread.laneIds, lane.id])].slice(-100);
    thread.activeLaneId = lane.id;
    thread.executorType = resolvedExecutorType;
    thread.updatedAt = nowIso();
    this.appendOrchestratorThreadMessage(thread, {
      id: randomUUID(),
      role: 'assistant',
      content: `Started ${resolvedExecutorType} orchestrator lane "${lane.title}".`,
      laneId: lane.id,
      executorCapabilities: lane.executorCapabilities || null,
      createdAt: thread.updatedAt,
    });
    this.recordAudit({
      type: 'orchestrator_message_queued',
      actor: context.actor || 'dashboard',
      projectId: session.projectId,
      sessionId: session.id,
      laneId: lane.id,
      summary: `Queued orchestrator turn for session ${session.name}`,
      status: 'passed',
      evidence: {
        messageId: userMessage.id,
        executorType: resolvedExecutorType,
        executorCapabilities: lane.executorCapabilities || null,
        leaseId: lease?.lease?.id || null,
      },
    });
    this.persistState();
    return clonePayload({
      thread,
      message: userMessage,
      lane,
      lease: lease ? lease.lease : null,
    });
  },
};
