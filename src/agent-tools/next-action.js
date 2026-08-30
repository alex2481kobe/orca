// Next-action state machine + envelope builder.

import { CONTRACT_VERSION } from './contract.js';
import { isLiveLaneState } from '../worker-contract.js';
import { findTool } from './tool-definitions.js';
import { normalizeRole, availableToolIdsForRole } from './roles.js';

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

// The standalone session.next_action TOOL is gone — orchestrator.status returns
// this envelope now — so "nothing to do but look" resolves to orchestrator.status
// for every role. Only ids that still exist in tool-definitions.js may appear
// here; test/agent-tools.test.js fails the build on a dead id.
const OBSERVE = 'orchestrator.status';

export function chooseNextTool({ registry, role, project, session, lane, auditQueued, flow }) {
  const normalizedRole = normalizeRole(role);
  // Non-orchestrator roles (executor/auditor) fall through to the read-only path
  // below and never get an orchestrator-only tool.
  if (!project) return normalizedRole === 'orchestrator' || normalizedRole === 'dashboard'
    ? 'orchestrator.register'
    : OBSERVE;
  // v2: the orchestrator RECORD is the container. With no container yet, an
  // orchestrator registers to obtain one (there is no session/enroll step).
  if (!session) return normalizedRole === 'orchestrator' || normalizedRole === 'dashboard'
    ? 'orchestrator.register'
    : OBSERVE;
  if (!lane) {
    // orchestrator-only flow: the orchestrator does the work itself — don't push
    // toward spawning executor lanes.
    if (flow?.template === 'orchestrator-only') return OBSERVE;
    return normalizedRole === 'orchestrator' || normalizedRole === 'dashboard'
      ? 'executor.spawn'
      : OBSERVE;
  }
  if (lane.state === 'queued') return OBSERVE;
  // A live lane: the executor's job is to finish and hand off; everyone else watches.
  if (lane.state === 'starting' || lane.state === 'running') return normalizedRole === 'executor' ? 'lane.submit' : OBSERVE;
  if (lane.state === 'done' || lane.state === 'ready_for_audit') return auditQueued ? 'audit.findings.record' : 'audit.queue_one';
  if (lane.state === 'fix_requested') {
    // Route the fix per the configurable flow: a fresh agent (new lane) or the
    // same agent (retry this lane).
    return flow?.fixRouting === 'new-agent' ? 'executor.spawn' : 'lane.retry';
  }
  if (lane.state === 'failed') return 'lane.retry';
  if (lane.state === 'stopped') return 'lane.retry';
  // A blocked lane was stopped by the auditor for a reason (out of scope / needs
  // human direction). Don't point at lane.retry — that just re-runs the same work
  // and can loop a policy-blocked lane. Send the caller to the status view so a
  // human/orchestrator decides (retry, respawn, or delete).
  if (lane.state === 'blocked') return OBSERVE;
  return OBSERVE;
}

function flowConfigForLane(registry, lane) {
  return (lane && typeof registry?.getLaneFlowConfig === 'function')
    ? registry.getLaneFlowConfig(lane)
    : { template: 'orchestrator-executor', auditTier: 'orchestrator', fixRouting: 'same-agent', maxAuditLoops: 2, requireAuditPass: true };
}

function nextToolForLane({ registry, role, project, session, lane }) {
  const auditQueued = lane ? Boolean(latestPendingAudit(registry, lane.id)) : false;
  const flowConfig = flowConfigForLane(registry, lane);
  return {
    auditQueued,
    flowConfig,
    nextRequiredTool: chooseNextTool({
      registry,
      role,
      project,
      session,
      lane,
      auditQueued,
      flow: flowConfig,
    }),
  };
}

const SESSION_LANE_ACTION_PRIORITY = {
  'audit.queue_one': 30,
  'audit.findings.record': 30,
  'lane.retry': 40,
  'executor.spawn': 45,
  'lane.get': 50,
  'lane.submit': 80,
  'orchestrator.status': 90,
};

function chooseSessionLane(registry, { role, project, session }) {
  if (!session) return null;
  const lanes = (registry?.lanes || []).filter((item) => item.sessionId === session.id);
  const actionableLanes = lanes.filter((lane) => lane.state !== 'accepted');
  if (!actionableLanes.length) return null;
  const candidates = actionableLanes
    .map((lane) => {
      const { nextRequiredTool } = nextToolForLane({ registry, role, project, session, lane });
      const updatedAt = Date.parse(lane.updatedAt || lane.createdAt || '') || 0;
      return {
        lane,
        priority: SESSION_LANE_ACTION_PRIORITY[nextRequiredTool] ?? 100,
        updatedAt,
      };
    })
    .sort((a, b) => (a.priority - b.priority) || (b.updatedAt - a.updatedAt));
  const best = candidates[0] || null;
  return best?.lane || null;
}

function buildCapacity(registry, session) {
  // Report the orchestrator container's REAL capacity + live load so an agent can
  // trust these numbers for scheduling. The getSession() container view carries
  // approvedCapacity / laneConcurrencyLimit / spawnPolicy from the orchestrator
  // record; activeAgents is the live count of lanes occupying a slot (queued /
  // starting / running) under this container.
  if (!session) {
    return { spawnPolicy: 'within_capacity', approvedCapacity: 0, laneConcurrencyLimit: 0, activeAgents: 0, idleSlots: 0, capacityRequests: [] };
  }
  const approvedCapacity = Number.isFinite(session.approvedCapacity) ? session.approvedCapacity : 0;
  const effectiveLimit = approvedCapacity;
  // laneOccupiesSlot where available: a lane that submitted still has a live child
  // and still consumes a slot, so a state-only count under-reports activeAgents and
  // over-reports idleSlots — telling an orchestrator it may fan out when it may not.
  const occupies = typeof registry?.laneOccupiesSlot === 'function'
    ? (lane) => registry.laneOccupiesSlot(lane)
    : (lane) => isLiveLaneState(lane.state);
  const activeAgents = (registry?.lanes || [])
    .filter((lane) => lane.sessionId === session.id && occupies(lane))
    .length;
  return {
    spawnPolicy: session.spawnPolicy || 'auto',
    approvedCapacity,
    laneConcurrencyLimit: effectiveLimit,
    activeAgents,
    idleSlots: Math.max(0, effectiveLimit - activeAgents),
    capacityRequests: [],
  };
}

function buildLinks({ project, session, lane }) {
  return {
    project: project ? `/projects/${project.slug || project.id}` : null,
    session: project && session ? `/projects/${project.slug || project.id}/sessions/${session.id}` : null,
    lane: lane?.route || null,
    api: {
      lease: '/api/agent-tools/leases',
    },
  };
}

export function buildNextActionEnvelope(registry, {
  role = 'orchestrator',
  projectId = null,
  sessionId = null,
  laneId = null,
  // lean omits the executor capability matrix, which can shell out to CLIs on a
  // cold cache. Callers that only need flow/nextRequiredTool (e.g.
  // orchestrator.status, often polled) pass lean:true. The flow/state fields are
  // identical either way.
  lean = false,
  allowedTools = null,
} = {}) {
  const normalizedRole = normalizeRole(role);
  const projects = typeof registry?.listProjects === 'function' ? registry.listProjects() : [];
  const project = projectId
    ? (typeof registry?.getProject === 'function' ? registry.getProject(projectId) : null)
    : (projects[0] || null);
  // v2: containers are orchestrator records. Resolve the given container, or fall
  // back to the first orchestrator registered under the project.
  const session = sessionId
    ? (typeof registry?.getSession === 'function' ? registry.getSession(sessionId) : null)
    : (project && typeof registry?.getSession === 'function'
      ? ((registry?.orchestrators || [])
        .filter((orch) => orch.projectId === project.id)
        .map((orch) => registry.getSession(orch.id))
        .find(Boolean) || null)
      : null);
  const lane = laneId
    ? (typeof registry?.getLane === 'function' ? registry.getLane(laneId) : null)
    : chooseSessionLane(registry, { role: normalizedRole, project, session });
  const roleAllowedTools = availableToolIdsForRole(normalizedRole);
  const allowedToolSet = new Set(roleAllowedTools);
  const effectiveAllowedTools = Array.isArray(allowedTools)
    ? allowedTools
      .map((toolId) => String(toolId || '').trim())
      .filter((toolId) => toolId && allowedToolSet.has(toolId))
      .filter((toolId, index, all) => all.indexOf(toolId) === index)
    : roleAllowedTools;
  const { auditQueued, flowConfig, nextRequiredTool } = nextToolForLane({
    registry,
    role: normalizedRole,
    project,
    session,
    lane,
  });
  const nextTool = findTool(nextRequiredTool);
  // Live audit-evidence gate: UI/browser work (a lane with a targetUrl) must
  // produce captured evidence before an auditor accepts it (enforced in
  // acceptLaneAudit). targetUrl is the whole signal now — the critique fields that
  // also fed this were never assigned anywhere and are gone.
  const evidenceRequired = Boolean(lane?.targetUrl);
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
    nextToolPermitted: effectiveAllowedTools.includes(nextRequiredTool),
    allowedTools: effectiveAllowedTools,
    summary: lane
      ? `Lane "${lane.title}" is ${lane.state}.`
      : (session ? `Session "${session.name}" is ready for orchestration.` : (project ? `Project "${project.name}" is selected.` : 'No project selected.')),
    evidenceRequired,
    auditRequired,
    auditSatisfied: auditRequired ? auditSatisfied : true,
    flow,
    capacity: buildCapacity(registry, session),
    links: buildLinks({ project, session, lane }),
  };
}
