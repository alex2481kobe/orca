// Next-action state machine + envelope builder. Extracted from agent-tools.js.

import { CONTRACT_VERSION } from './contract.js';
import { findTool } from './tool-definitions.js';
import { normalizeRole, availableToolIdsForRole, blockedToolSummariesForRole } from './roles.js';
import { buildMcpToolsByExecutor } from './registry-views.js';

function latestPendingAudit(registry, laneId) {
  const events = Array.isArray(registry?.auditEvents) ? registry.auditEvents : [];
  return events.find((event) =>
    event &&
    event.laneId === laneId &&
    ['lane_audit_queued', 'session_audit_batch_queued'].includes(event.type) &&
    event.status === 'pending'
  ) || null;
}

function laneLoopState(lane) {
  if (!lane) return 'session_planning';
  if (lane.state === 'queued') return 'lane_queued';
  if (lane.state === 'starting' || lane.state === 'running') return 'lane_active';
  if (lane.state === 'needs_critique') return 'needs_self_verification';
  if (lane.state === 'ready_for_audit') return 'ready_for_audit';
  if (lane.state === 'auditing') return 'audit_in_progress';
  if (lane.state === 'fix_requested') return 'fix_requested';
  if (lane.state === 'accepted') return 'accepted';
  if (lane.state === 'blocked') return 'blocked';
  if (lane.state === 'done') return 'ready_for_audit';
  if (lane.state === 'failed') return 'lane_failed';
  if (lane.state === 'stopped') return 'lane_stopped';
  return `lane_${lane.state || 'unknown'}`;
}

function critiqueRequiredForLane(registry, lane) {
  if (!lane) return false;
  if (typeof registry?.critiqueRequiredForLane === 'function') {
    return registry.critiqueRequiredForLane(lane);
  }
  return ['required', 'visual-required'].includes(String(lane.critiqueMode || '').toLowerCase());
}

function critiqueSatisfiedForLane(registry, lane) {
  if (!lane) return true;
  if (typeof registry?.critiqueSatisfiedForLane === 'function') {
    return registry.critiqueSatisfiedForLane(lane);
  }
  if (!critiqueRequiredForLane(registry, lane)) return true;
  return ['satisfied', 'waived'].includes(lane.critiqueState);
}

function evidenceFreshForLane(registry, lane) {
  if (!lane) return false;
  if (lane.critiqueMode === 'visual-required' && typeof registry?.hasFreshVisualEvidence === 'function') {
    return registry.hasFreshVisualEvidence(lane);
  }
  return Boolean(lane.lastEvidence && lane.lastEvidenceCaptureAt);
}

function chooseNextTool({ registry, role, project, session, lane, auditQueued, flow }) {
  const normalizedRole = normalizeRole(role);
  if (!project) return 'project.list';
  if (!session) return 'project.describe';
  if (!lane) {
    // orchestrator-only flow: the orchestrator does the work itself — don't push
    // toward spawning executor lanes.
    if (flow?.template === 'orchestrator-only') return 'session.next_action';
    return normalizedRole === 'orchestrator' || normalizedRole === 'dashboard'
      ? 'lane.create'
      : 'session.describe';
  }
  if (lane.state === 'queued') return 'session.next_action';
  if (lane.state === 'starting' || lane.state === 'running') return normalizedRole === 'executor' ? 'lane.heartbeat' : 'session.next_action';
  if (lane.state === 'needs_critique') {
    if (lane.critiqueMode === 'visual-required' && !evidenceFreshForLane(registry, lane)) {
      return 'evidence.capture_screenshot';
    }
    return lane.critiqueNonce ? 'critique.findings.record' : 'critique.bundle.create';
  }
  if (lane.state === 'done' || lane.state === 'ready_for_audit') return auditQueued ? 'audit.findings.record' : 'audit.queue_one';
  if (lane.state === 'fix_requested') {
    // Route the fix per the configurable flow: a fresh agent (new lane) or the
    // same agent (retry this lane).
    return flow?.fixRouting === 'new-agent' ? 'lane.create' : 'lane.retry';
  }
  if (lane.state === 'failed') return 'lane.retry';
  if (lane.state === 'stopped') return 'lane.retry';
  return 'session.next_action';
}

function buildCapacity(registry, session) {
  if (session?.id && typeof registry?.getSessionCapacity === 'function') {
    return registry.getSessionCapacity(session.id);
  }
  return {
    spawnPolicy: 'within_capacity',
    approvedCapacity: 2,
    activeAgents: 0,
    idleSlots: 2,
    capacityRequests: [],
  };
}

function buildLinks({ project, session, lane }) {
  return {
    project: project ? `/projects/${project.slug || project.id}` : null,
    session: project && session ? `/projects/${project.slug || project.id}/sessions/${session.id}` : null,
    lane: lane?.route || null,
    api: {
      discovery: '/api/agent-tools/discovery',
      nextAction: '/api/agent-tools/next-action',
      lease: '/api/agent-tools/leases',
    },
  };
}

export function buildNextActionEnvelope(registry, {
  role = 'orchestrator',
  projectId = null,
  sessionId = null,
  laneId = null,
} = {}) {
  const normalizedRole = normalizeRole(role);
  const projects = typeof registry?.listProjects === 'function' ? registry.listProjects() : [];
  const project = projectId
    ? (typeof registry?.getProject === 'function' ? registry.getProject(projectId) : null)
    : (projects[0] || null);
  const session = sessionId
    ? (typeof registry?.getSession === 'function' ? registry.getSession(sessionId) : null)
    : (project ? (registry?.sessions || []).find((item) => item.projectId === project.id) || null : null);
  const lane = laneId
    ? (typeof registry?.getLane === 'function' ? registry.getLane(laneId) : null)
    : (session ? (registry?.lanes || []).find((item) => item.sessionId === session.id) || null : null);
  const allowedTools = availableToolIdsForRole(normalizedRole);
  const auditQueued = lane ? Boolean(latestPendingAudit(registry, lane.id)) : false;
  const flowConfig = (lane && typeof registry?.getLaneFlowConfig === 'function')
    ? registry.getLaneFlowConfig(lane)
    : { template: 'orchestrator-executor', auditTier: 'orchestrator', fixRouting: 'same-agent', maxAuditLoops: 2, requireAuditPass: false };
  const nextRequiredTool = chooseNextTool({
    registry,
    role: normalizedRole,
    project,
    session,
    lane,
    auditQueued,
    flow: flowConfig,
  });
  const nextTool = findTool(nextRequiredTool);
  const critiqueRequired = critiqueRequiredForLane(registry, lane);
  const critiqueSatisfied = critiqueSatisfiedForLane(registry, lane);
  const evidenceRequired = Boolean(lane?.targetUrl || lane?.critiqueMode === 'visual-required');
  const evidenceFresh = evidenceFreshForLane(registry, lane);
  // 'auditing' and 'fix_requested' are post-submission states where the audit is
  // demonstrably not yet accepted; include them so auditSatisfied below reflects
  // reality (was reporting satisfied=true for them).
  const auditRequired = Boolean(lane && ['done', 'ready_for_audit', 'auditing', 'fix_requested'].includes(lane.state));
  const auditSatisfied = Boolean(lane && (lane.auditState === 'accepted' || lane.state === 'accepted'));
  // Configurable agent-flow view: what the flow demands and how much fix-loop
  // budget remains. auditMandatory means the lane cannot be returned to the main
  // orchestrator as complete until an audit accepts it.
  const auditMandatory = Boolean(lane && typeof registry?.auditRequiredForLane === 'function' && registry.auditRequiredForLane(lane));
  const auditLoopCount = Number.isInteger(lane?.auditLoopCount) ? lane.auditLoopCount : 0;
  const loopsRemaining = Math.max(0, (Number.isInteger(flowConfig.maxAuditLoops) ? flowConfig.maxAuditLoops : 2) - auditLoopCount);
  const returnToOrchestratorAllowed = !auditMandatory || auditSatisfied;
  const flow = {
    template: flowConfig.template,
    auditTier: flowConfig.auditTier,
    fixRouting: flowConfig.fixRouting,
    maxAuditLoops: flowConfig.maxAuditLoops,
    requireAuditPass: flowConfig.requireAuditPass,
    auditMandatory,
    auditLoopCount,
    loopsRemaining,
    escalated: lane?.auditState === 'escalated',
    returnToOrchestratorAllowed,
  };

  return {
    contractVersion: CONTRACT_VERSION,
    projectId: project?.id || null,
    sessionId: session?.id || null,
    laneId: lane?.id || null,
    role: normalizedRole,
    loopState: lane ? laneLoopState(lane) : (session ? 'session_planning' : (project ? 'project_selected' : 'needs_project')),
    nextRequiredTool,
    nextToolImplemented: Boolean(nextTool?.implemented),
    // Whether the current role may actually call nextRequiredTool. The server
    // enforces role on the real call, but surfacing this lets clients avoid
    // driving an action the role can't perform (e.g. executor on audit.queue_one).
    nextToolPermitted: allowedTools.includes(nextRequiredTool),
    allowedTools,
    blockedTools: blockedToolSummariesForRole(normalizedRole),
    summary: lane
      ? `Lane "${lane.title}" is ${lane.state}.`
      : (session ? `Session "${session.name}" is ready for orchestration.` : (project ? `Project "${project.name}" is selected.` : 'No project selected.')),
    evidenceRequired,
    evidenceFresh,
    critiqueRequired,
    critiqueSatisfied,
    auditRequired,
    auditSatisfied: auditRequired ? auditSatisfied : true,
    flow,
    capacity: buildCapacity(registry, session),
    executorCapabilities: typeof registry?.getExecutorCapabilitiesMatrix === 'function'
      ? registry.getExecutorCapabilitiesMatrix()
      : {},
    mcpToolsByExecutor: buildMcpToolsByExecutor(registry),
    links: buildLinks({ project, session, lane }),
  };
}
