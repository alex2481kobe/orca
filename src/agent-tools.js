const CONTRACT_VERSION = 'orca.agent-tools.v1';

const ROLES = new Set(['orchestrator', 'executor', 'auditor', 'critique', 'dashboard']);

const TOOL_DEFINITIONS = [
  {
    id: 'session.describe',
    group: 'session',
    roles: ['orchestrator', 'executor', 'auditor', 'critique', 'dashboard'],
    method: 'GET',
    route: '/api/sessions/{sessionId}',
    implemented: true,
    mutating: false,
    summary: 'Read session state and lane summary.',
  },
  {
    id: 'session.plan.update',
    group: 'session',
    roles: ['orchestrator'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Update the durable session task plan.',
  },
  {
    id: 'session.next_action',
    group: 'session',
    roles: ['orchestrator', 'executor', 'auditor', 'critique', 'dashboard'],
    method: 'GET',
    route: '/api/agent-tools/next-action',
    implemented: true,
    mutating: false,
    summary: 'Fetch the server-approved next legal tool/action envelope.',
  },
  {
    id: 'executor.capabilities',
    group: 'executor',
    roles: ['orchestrator', 'executor', 'auditor', 'critique', 'dashboard'],
    method: 'GET',
    route: '/api/agent-tools/discovery',
    implemented: true,
    mutating: false,
    summary: 'Read the executor capability matrix, including supported roles, modes, intelligence, structured output, and MCP support.',
  },
  {
    id: 'lane.create',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/sessions/{sessionId}/lanes',
    implemented: true,
    mutating: true,
    summary: 'Create a governed lane in a session.',
  },
  {
    id: 'lane.claim',
    group: 'lane',
    roles: ['executor'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Claim a queued lane with a lease.',
  },
  {
    id: 'lane.heartbeat',
    group: 'lane',
    roles: ['executor', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/heartbeat',
    implemented: true,
    mutating: true,
    summary: 'Record a worker heartbeat for an active lane.',
  },
  {
    id: 'lane.submit',
    group: 'lane',
    roles: ['executor', 'orchestrator'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Submit lane handoff and mark ready for audit.',
  },
  {
    id: 'lane.block',
    group: 'lane',
    roles: ['executor', 'orchestrator', 'auditor'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Block a lane with an explicit reason.',
  },
  {
    id: 'lane.shutdown',
    group: 'lane',
    roles: ['orchestrator', 'executor', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/stop',
    implemented: true,
    mutating: true,
    summary: 'Stop or shut down a lane worker.',
  },
  {
    id: 'lane.retry',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/retry',
    implemented: true,
    mutating: true,
    summary: 'Retry a failed, stopped, or fix-requested lane.',
  },
  {
    id: 'lane.controls.update',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'PATCH',
    route: '/api/lanes/{laneId}/controls',
    implemented: true,
    mutating: true,
    summary: 'Update model, permissions mode, or intelligence controls for a lane.',
  },
  {
    id: 'lane.archive',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Archive a lane without deleting evidence.',
  },
  {
    id: 'capacity.request',
    group: 'capacity',
    roles: ['orchestrator'],
    method: 'POST',
    route: '/api/sessions/{sessionId}/capacity/request',
    implemented: true,
    mutating: true,
    summary: 'Request additional executor capacity.',
  },
  {
    id: 'capacity.approve',
    group: 'capacity',
    roles: ['dashboard'],
    method: 'POST',
    route: '/api/sessions/{sessionId}/capacity/requests/{requestId}/approve',
    implemented: true,
    mutating: true,
    summary: 'Approve a structured capacity request.',
  },
  {
    id: 'capacity.reject',
    group: 'capacity',
    roles: ['dashboard'],
    method: 'POST',
    route: '/api/sessions/{sessionId}/capacity/requests/{requestId}/reject',
    implemented: true,
    mutating: true,
    summary: 'Reject a structured capacity request.',
  },
  {
    id: 'capacity.set_policy',
    group: 'capacity',
    roles: ['dashboard', 'orchestrator'],
    method: 'POST',
    route: '/api/sessions/{sessionId}/capacity/policy',
    implemented: true,
    mutating: true,
    summary: 'Update capacity and spawn policy.',
  },
  {
    id: 'critique.bundle.create',
    group: 'critique',
    roles: ['executor', 'orchestrator', 'critique', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/critique/bundle',
    implemented: true,
    mutating: true,
    summary: 'Create a self-verification bundle for the current lane revision.',
  },
  {
    id: 'critique.findings.record',
    group: 'critique',
    roles: ['executor', 'orchestrator', 'critique', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/critique/findings',
    implemented: true,
    mutating: true,
    summary: 'Record critique findings against a nonce/revision.',
  },
  {
    id: 'critique.waive',
    group: 'critique',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/critique/waive',
    implemented: true,
    mutating: true,
    summary: 'Waive critique with reason and audit record.',
  },
  {
    id: 'audit.queue_one',
    group: 'audit',
    roles: ['orchestrator', 'auditor', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit',
    implemented: true,
    mutating: true,
    summary: 'Queue an audit for one lane.',
  },
  {
    id: 'audit.queue_all_ready',
    group: 'audit',
    roles: ['orchestrator', 'auditor', 'dashboard'],
    method: 'POST',
    route: '/api/sessions/{sessionId}/audit-done-lanes',
    implemented: true,
    mutating: true,
    summary: 'Queue audits for all eligible done lanes in a session.',
  },
  {
    id: 'audit.claim',
    group: 'audit',
    roles: ['auditor'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Claim a queued audit.',
  },
  {
    id: 'audit.findings.record',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/findings',
    implemented: true,
    mutating: true,
    summary: 'Record audit findings and choose accept, request-fix, or block verdict.',
  },
  {
    id: 'audit.accept',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/accept',
    implemented: true,
    mutating: true,
    summary: 'Accept audited lane work.',
  },
  {
    id: 'audit.request_fix',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/request-fix',
    implemented: true,
    mutating: true,
    summary: 'Request a fix pass after audit.',
  },
  {
    id: 'audit.block',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/block',
    implemented: true,
    mutating: true,
    summary: 'Block an audit with a reason.',
  },
  {
    id: 'evidence.capture_screenshot',
    group: 'evidence',
    roles: ['executor', 'orchestrator', 'critique', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/evidence',
    implemented: true,
    mutating: true,
    summary: 'Capture screenshot evidence for a lane target.',
  },
  {
    id: 'evidence.capture_video',
    group: 'evidence',
    roles: ['executor', 'orchestrator', 'critique', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/evidence',
    implemented: true,
    mutating: true,
    summary: 'Capture optional video evidence for user inspection.',
  },
  {
    id: 'evidence.attach_artifact',
    group: 'evidence',
    roles: ['executor', 'orchestrator'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Attach an existing artifact to the lane evidence bundle.',
  },
  {
    id: 'evidence.list',
    group: 'evidence',
    roles: ['executor', 'orchestrator', 'auditor', 'critique', 'dashboard'],
    method: 'GET',
    route: '/api/lanes/{laneId}/evidence',
    implemented: true,
    mutating: false,
    summary: 'List evidence artifacts for a lane.',
  },
  {
    id: 'evidence.latest',
    group: 'evidence',
    roles: ['executor', 'orchestrator', 'auditor', 'critique', 'dashboard'],
    method: 'GET',
    route: '/api/lanes/{laneId}/evidence/latest',
    implemented: true,
    mutating: false,
    summary: 'Fetch latest evidence metadata for a lane.',
  },
  {
    id: 'evidence.cleanup_dry_run',
    group: 'evidence',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/artifacts/cleanup',
    implemented: true,
    mutating: true,
    summary: 'Dry-run artifact/evidence cleanup.',
  },
  {
    id: 'evidence.cleanup_apply',
    group: 'evidence',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/artifacts/cleanup',
    implemented: true,
    mutating: true,
    summary: 'Apply approved artifact/evidence cleanup.',
  },
  {
    id: 'provider.list',
    group: 'providers',
    roles: ['orchestrator', 'dashboard'],
    method: 'GET',
    route: '/api/providers',
    implemented: true,
    mutating: false,
    summary: 'List provider profiles and non-secret credential status.',
  },
  {
    id: 'provider.health',
    group: 'providers',
    roles: ['orchestrator', 'dashboard'],
    method: 'GET',
    route: '/api/providers/{providerId}/health',
    implemented: true,
    mutating: false,
    summary: 'Check provider health without exposing secrets.',
  },
  {
    id: 'provider.configure',
    group: 'providers',
    roles: ['dashboard'],
    method: 'PATCH',
    route: '/api/providers/{providerId}',
    implemented: true,
    mutating: true,
    summary: 'Update a provider profile with approval.',
  },
  {
    id: 'provider.secret.set',
    group: 'providers',
    roles: ['dashboard'],
    method: 'POST',
    route: '/api/providers/{providerId}/secret',
    implemented: true,
    mutating: true,
    summary: 'Store a provider secret in the configured credential backend.',
  },
  {
    id: 'provider.secret.delete',
    group: 'providers',
    roles: ['dashboard'],
    method: 'DELETE',
    route: '/api/providers/{providerId}/secret',
    implemented: true,
    mutating: true,
    summary: 'Delete a stored provider secret reference.',
  },
  {
    id: 'provider.install_plan',
    group: 'providers',
    roles: ['dashboard'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Plan provider install without executing it.',
  },
  {
    id: 'provider.update_plan',
    group: 'providers',
    roles: ['dashboard'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Plan provider update without executing it.',
  },
  {
    id: 'project.list',
    group: 'projects',
    roles: ['orchestrator', 'dashboard'],
    method: 'GET',
    route: '/api/projects',
    implemented: true,
    mutating: false,
    summary: 'List projects.',
  },
  {
    id: 'project.describe',
    group: 'projects',
    roles: ['orchestrator', 'dashboard'],
    method: 'GET',
    route: '/api/projects/{projectId}',
    implemented: true,
    mutating: false,
    summary: 'Read one project.',
  },
  {
    id: 'project.quick_link.upsert',
    group: 'projects',
    roles: ['orchestrator', 'dashboard'],
    method: 'PATCH',
    route: '/api/projects/{projectId}/quick-links',
    implemented: true,
    mutating: true,
    summary: 'Create or update a server-authoritative project live link. Include label, url/localUrl/tailnetHttpUrl/httpsServeUrl, kind, port, favorite, and healthPath where known.',
  },
  {
    id: 'project.quick_link.delete',
    group: 'projects',
    roles: ['orchestrator', 'dashboard'],
    method: 'DELETE',
    route: '/api/projects/{projectId}/quick-links/{linkId}',
    implemented: true,
    mutating: true,
    summary: 'Remove one server-authoritative project live link by id.',
  },
  {
    id: 'project.quick_link.health',
    group: 'projects',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/projects/{projectId}/quick-links/{linkId}/check',
    implemented: true,
    mutating: true,
    summary: 'Health-check a validated project live link without accepting arbitrary URLs in the tool call.',
  },
  {
    id: 'project.archive',
    group: 'projects',
    roles: ['dashboard'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Archive a project without deleting state.',
  },
  {
    id: 'project.restore',
    group: 'projects',
    roles: ['dashboard'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Restore an archived project.',
  },
  {
    id: 'project.reorder',
    group: 'projects',
    roles: ['dashboard'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Persist project ordering.',
  },
  {
    id: 'settings.describe_effective',
    group: 'settings',
    roles: ['orchestrator', 'dashboard'],
    method: 'GET',
    route: '/api/policy',
    implemented: true,
    mutating: false,
    summary: 'Read effective policy/settings snapshot.',
  },
  {
    id: 'settings.update',
    group: 'settings',
    roles: ['dashboard'],
    method: 'POST',
    route: null,
    implemented: false,
    mutating: true,
    summary: 'Update scoped settings.',
  },
  {
    id: 'settings.export',
    group: 'settings',
    roles: ['dashboard'],
    method: 'GET',
    route: '/api/providers/export',
    implemented: true,
    mutating: false,
    summary: 'Export non-secret provider/settings config.',
  },
  {
    id: 'settings.import_dry_run',
    group: 'settings',
    roles: ['dashboard'],
    method: 'POST',
    route: '/api/providers/import/dry-run',
    implemented: true,
    mutating: true,
    summary: 'Validate settings/profile import without applying it.',
  },
  {
    id: 'settings.import_apply',
    group: 'settings',
    roles: ['dashboard'],
    method: 'POST',
    route: '/api/providers/import/apply',
    implemented: true,
    mutating: true,
    summary: 'Apply validated settings/profile import with approval.',
  },
];

function normalizeRole(role) {
  const normalized = String(role || 'orchestrator').trim().toLowerCase();
  return ROLES.has(normalized) ? normalized : 'orchestrator';
}

function publicTool(tool) {
  return {
    id: tool.id,
    group: tool.group,
    roles: [...tool.roles],
    method: tool.method,
    route: tool.route,
    implemented: Boolean(tool.implemented),
    mutating: Boolean(tool.mutating),
    summary: tool.summary,
  };
}

function getToolDefinitions() {
  return TOOL_DEFINITIONS.map(publicTool);
}

function findTool(toolId) {
  return TOOL_DEFINITIONS.find((tool) => tool.id === toolId) || null;
}

function availableToolIdsForRole(role) {
  const normalizedRole = normalizeRole(role);
  return TOOL_DEFINITIONS
    .filter((tool) => tool.implemented && tool.roles.includes(normalizedRole))
    .map((tool) => tool.id);
}

function blockedToolSummariesForRole(role) {
  const normalizedRole = normalizeRole(role);
  return TOOL_DEFINITIONS
    .filter((tool) => tool.roles.includes(normalizedRole) && !tool.implemented)
    .map((tool) => ({
      id: tool.id,
      reason: 'planned_not_wired',
    }));
}

function buildMcpToolsByExecutor(registry) {
  if (typeof registry?.getSupportedExecutorTypes !== 'function' || typeof registry?.listToolsForExecutor !== 'function') {
    return {};
  }
  return registry.getSupportedExecutorTypes().reduce((accum, executorType) => {
    accum[executorType] = registry.listToolsForExecutor(executorType).map((tool) => ({
      id: tool.id,
      name: tool.name,
      scope: Array.isArray(tool.scope) ? tool.scope : [],
      enabled: Boolean(tool.enabled),
    }));
    return accum;
  }, {});
}

function buildAgentToolDiscovery(registry = null) {
  const tools = getToolDefinitions();
  const groups = [...new Set(tools.map((tool) => tool.group))].sort();
  const roles = [...ROLES].sort().map((role) => ({
    role,
    allowedImplementedTools: availableToolIdsForRole(role),
    plannedTools: blockedToolSummariesForRole(role).map((tool) => tool.id),
  }));
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    publicSafe: true,
    secretPolicy: 'Discovery never includes secret values, env values, absolute workdirs, private docs, or local usernames.',
    leasePolicy: 'Mutating agent tools require normal dashboard auth today; lane/session leases are minted by /api/agent-tools/leases and are required by future guarded tool execution routes.',
    groups,
    roles,
    executorCapabilities: typeof registry?.getExecutorCapabilitiesMatrix === 'function'
      ? registry.getExecutorCapabilitiesMatrix()
      : {},
    mcpToolsByExecutor: buildMcpToolsByExecutor(registry),
    tools,
  };
}

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

function chooseNextTool({ registry, role, project, session, lane, auditQueued }) {
  const normalizedRole = normalizeRole(role);
  if (!project) return 'project.list';
  if (!session) return 'project.describe';
  if (!lane) {
    return normalizedRole === 'orchestrator' || normalizedRole === 'dashboard'
      ? 'lane.create'
      : 'session.describe';
  }
  if (lane.state === 'queued') return normalizedRole === 'executor' ? 'session.next_action' : 'session.next_action';
  if (lane.state === 'starting' || lane.state === 'running') return normalizedRole === 'executor' ? 'lane.heartbeat' : 'session.next_action';
  if (lane.state === 'needs_critique') {
    if (lane.critiqueMode === 'visual-required' && !evidenceFreshForLane(registry, lane)) {
      return 'evidence.capture_screenshot';
    }
    return lane.critiqueNonce ? 'critique.findings.record' : 'critique.bundle.create';
  }
  if (lane.state === 'done' || lane.state === 'ready_for_audit') return auditQueued ? 'audit.findings.record' : 'audit.queue_one';
  if (lane.state === 'fix_requested') return 'lane.retry';
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

function buildNextActionEnvelope(registry, {
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
  const nextRequiredTool = chooseNextTool({
    registry,
    role: normalizedRole,
    project,
    session,
    lane,
    auditQueued,
  });
  const nextTool = findTool(nextRequiredTool);
  const critiqueRequired = critiqueRequiredForLane(registry, lane);
  const critiqueSatisfied = critiqueSatisfiedForLane(registry, lane);
  const evidenceRequired = Boolean(lane?.targetUrl || lane?.critiqueMode === 'visual-required');
  const evidenceFresh = evidenceFreshForLane(registry, lane);
  const auditRequired = Boolean(lane && ['done', 'ready_for_audit'].includes(lane.state));
  const auditSatisfied = Boolean(lane && (lane.auditState === 'accepted' || lane.state === 'accepted'));

  return {
    contractVersion: CONTRACT_VERSION,
    projectId: project?.id || null,
    sessionId: session?.id || null,
    laneId: lane?.id || null,
    role: normalizedRole,
    loopState: lane ? laneLoopState(lane) : (session ? 'session_planning' : (project ? 'project_selected' : 'needs_project')),
    nextRequiredTool,
    nextToolImplemented: Boolean(nextTool?.implemented),
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
    capacity: buildCapacity(registry, session),
    executorCapabilities: typeof registry?.getExecutorCapabilitiesMatrix === 'function'
      ? registry.getExecutorCapabilitiesMatrix()
      : {},
    mcpToolsByExecutor: buildMcpToolsByExecutor(registry),
    links: buildLinks({ project, session, lane }),
  };
}

export {
  CONTRACT_VERSION,
  TOOL_DEFINITIONS,
  buildAgentToolDiscovery,
  buildNextActionEnvelope,
  availableToolIdsForRole,
  findTool,
  normalizeRole,
};
