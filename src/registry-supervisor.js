// Cross-project supervisor role helpers. The supervisor coordinates
// orchestrators; it does not replace executor/orchestrator lane state machines.

import { nowIso, clonePayload, safeArray } from './registry-utils.js';
import { normalizeWorktreeMode } from './registry-lane-config.js';
import { randomUUID } from 'node:crypto';

function boundedText(value, max = 4000) {
  return String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

function normalizeSupervisorVerdict(value) {
  const normalized = String(value || 'accept').trim().toLowerCase().replace(/-/g, '_');
  return ['accept', 'request_fix', 'block'].includes(normalized) ? normalized : null;
}

function summarizeSupervisorLane(lane) {
  const pendingApprovals = safeArray(lane.pendingApprovals)
    .filter((approval) => approval?.status === 'pending').length;
  return {
    id: lane.id,
    title: lane.title,
    route: lane.route,
    owner: lane.owner || null,
    executorType: lane.executorType,
    state: lane.state,
    auditState: lane.auditState || null,
    critiqueState: lane.critiqueState || null,
    targetUrl: lane.targetUrl || '',
    heartbeatAt: lane.heartbeatAt || null,
    updatedAt: lane.updatedAt || null,
    resultText: lane.resultText || '',
    pendingApprovals,
    recentAgentEvents: safeArray(lane.agentEvents).slice(-8).map((event) => ({
      id: event.id,
      at: event.at,
      source: event.source,
      type: event.type,
      title: event.title || '',
      content: event.content || '',
      stream: event.stream || '',
      toolName: event.toolName || '',
    })),
  };
}

function supervisorSignalForSession({ session, status, backlog, activeLanes = 0, pendingApprovalCount = 0 }) {
  const review = session.supervisorReview || null;
  const nextRequiredTool = status?.nextRequiredTool || null;
  const backlogCounts = backlog?.counts || {};
  const pendingBacklog = Number(backlogCounts.pending || 0);
  const failedBacklog = Number(backlogCounts.failed || 0);
  const blockedBacklog = Number(backlogCounts.blocked || 0);
  const make = (kind, priority, message, recommendedTool = 'orchestrator.status') => ({
    kind,
    priority,
    message,
    recommendedTool,
    nextRequiredTool,
  });

  if (review?.status === 'blocked') {
    return make('blocked_by_supervisor', 10, review.summary || 'Supervisor blocked this session.', 'orchestrator.status');
  }
  if (review?.status === 'fix_requested') {
    return make('fix_requested', 20, review.nextTask || review.summary || 'Supervisor requested a fix.', 'orchestrator.status');
  }
  if (backlog?.stalled || failedBacklog || blockedBacklog) {
    const reason = safeArray(backlog?.stallReasons)[0] || `${failedBacklog} failed, ${blockedBacklog} blocked backlog item(s).`;
    return make('backlog_stalled', 30, reason, 'backlog.status');
  }
  if (pendingApprovalCount > 0) {
    return make('approval_pending', 40, `${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? '' : 's'} need review.`, 'approval.list');
  }
  if (!status?.activeOrchestrator?.active && (pendingBacklog > 0 || activeLanes > 0)) {
    return make('orchestrator_needed', 50, 'Session has work but no active orchestrator.', 'orchestrator.status');
  }
  if (backlog?.complete && backlog?.allAccepted && review?.status !== 'accepted') {
    return make('session_review_ready', 60, 'All backlog work is accepted; supervisor review is ready.', 'session.supervisor_audit');
  }
  if (nextRequiredTool && nextRequiredTool !== 'session.next_action') {
    return make('next_action_available', 70, `Next required tool is ${nextRequiredTool}.`, nextRequiredTool);
  }
  if (activeLanes > 0) {
    return make('monitor_lanes', 80, `${activeLanes} active lane${activeLanes === 1 ? '' : 's'} running or awaiting review.`, 'lane.terminal.tail');
  }
  return make('healthy', 100, 'No immediate supervisor action required.', 'supervisor.overview');
}

export const supervisorMethods = {
  supervisorOverview({ projectId = null, sessionId = null } = {}) {
    const scopedProject = projectId ? this.getProject(projectId) : null;
    const scopedProjectId = scopedProject?.id || null;
    const scopedProjectMissing = Boolean(projectId && !scopedProjectId);
    const supervisorLeaseProjectId = (lease) => lease.projectId
      || (lease.sessionId ? this.getSession(lease.sessionId)?.projectId : null)
      || null;
    const activeSupervisors = typeof this.listToolLeases === 'function'
      ? this.listToolLeases({ activeOnly: true })
        .filter((lease) => lease.role === 'supervisor')
        .filter((lease) => {
          if (scopedProjectMissing) return false;
          if (sessionId) return lease.sessionId === sessionId;
          if (scopedProjectId) return supervisorLeaseProjectId(lease) === scopedProjectId;
          return true;
        })
        .map((lease) => ({
          id: lease.id,
          actor: lease.actor,
          projectId: lease.projectId || null,
          sessionId: lease.sessionId || null,
          createdAt: lease.createdAt,
          lastSeenAt: lease.lastUsedAt || null,
          expiresAt: lease.expiresAt,
          active: lease.active,
        }))
      : [];
    const projects = (this.projects || [])
      .filter((project) => project.state !== 'archived')
      .filter(() => !scopedProjectMissing)
      .filter((project) => !scopedProjectId || project.id === scopedProjectId);
    const projectSummaries = projects.map((project) => {
      const sessions = (this.sessions || [])
        .filter((session) => session.projectId === project.id && session.state !== 'archived')
        .filter((session) => !sessionId || session.id === sessionId)
        .map((session) => {
          let status = null;
          let backlog = null;
          try { status = this.orchestratorStatus(session.id); } catch { status = null; }
          try { backlog = this.sessionBacklogStatus(session.id); } catch { backlog = null; }
          const lanes = (this.lanes || []).filter((lane) => lane.sessionId === session.id);
          const activeLanes = lanes.filter((lane) => ['queued', 'starting', 'running', 'auditing', 'needs_critique', 'ready_for_audit', 'fix_requested'].includes(lane.state)).length;
          const pendingApprovalLanes = lanes
            .map((lane) => ({
              laneId: lane.id,
              title: lane.title,
              executorType: lane.executorType,
              count: safeArray(lane.pendingApprovals).filter((approval) => approval?.status === 'pending').length,
            }))
            .filter((lane) => lane.count > 0);
          const pendingApprovalCount = pendingApprovalLanes.reduce((sum, lane) => sum + lane.count, 0);
          const supervisorSignal = supervisorSignalForSession({
            session,
            status,
            backlog,
            activeLanes,
            pendingApprovalCount,
          });
          return {
            id: session.id,
            name: session.name,
            route: session.route,
            repoConfigured: Boolean(session.repoRoot),
            worktreeMode: normalizeWorktreeMode(session.worktreeMode),
            activeOrchestrator: status?.activeOrchestrator || { active: false },
            nextRequiredTool: status?.nextRequiredTool || null,
            capacity: status?.capacity || null,
            backlog: backlog ? {
              counts: backlog.counts,
              complete: backlog.complete,
              allAccepted: backlog.allAccepted,
              stalled: backlog.stalled,
              stallReasons: backlog.stallReasons,
              warnings: backlog.warnings,
            } : null,
            activeLanes,
            approvals: {
              pending: pendingApprovalCount,
              lanes: pendingApprovalLanes,
            },
            lanes: lanes.map(summarizeSupervisorLane),
            supervisorReview: session.supervisorReview || null,
            supervisorSignal,
          };
        });
      return {
        id: project.id,
        name: project.name,
        slug: project.slug,
        route: project.route,
        sessionCount: sessions.length,
        sessions,
      };
    });
    const attention = projectSummaries
      .flatMap((project) => project.sessions.map((session) => ({
        projectId: project.id,
        projectName: project.name,
        sessionId: session.id,
        sessionName: session.name,
        route: session.route,
        ...session.supervisorSignal,
      })))
      .filter((item) => item.kind !== 'healthy')
      .sort((a, b) => (a.priority - b.priority)
        || String(a.projectName).localeCompare(String(b.projectName))
        || String(a.sessionName).localeCompare(String(b.sessionName)));
    return clonePayload({
      generatedAt: nowIso(),
      activeSupervisors,
      attention,
      projects: projectSummaries,
    });
  },

  recordSupervisorSessionAudit(sessionLocator, {
    verdict = 'accept',
    summary = '',
    findings = [],
    nextTask = '',
    plan = '',
    actor = 'supervisor',
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const normalizedVerdict = normalizeSupervisorVerdict(verdict);
    if (!normalizedVerdict) {
      throw { status: 422, message: 'verdict must be accept, request_fix, or block.' };
    }
    const now = nowIso();
    const review = {
      verdict: normalizedVerdict,
      status: normalizedVerdict === 'accept' ? 'accepted' : normalizedVerdict === 'request_fix' ? 'fix_requested' : 'blocked',
      summary: boundedText(summary, 2000),
      findings: safeArray(findings).map((item) => boundedText(item, 1000)).filter(Boolean).slice(0, 20),
      nextTask: boundedText(nextTask, 2000),
      plan: boundedText(plan, 4000),
      actor: boundedText(actor, 120) || 'supervisor',
      reviewedAt: now,
    };
    if (normalizedVerdict === 'request_fix' && !review.summary && !review.findings.length && !review.nextTask && !review.plan) {
      throw { status: 422, message: 'request_fix requires a summary, finding, nextTask, or plan.' };
    }
    if (normalizedVerdict === 'block' && !review.summary && !review.findings.length) {
      throw { status: 422, message: 'block requires a summary or finding.' };
    }
    session.supervisorReview = review;
    session.updatedAt = now;
    const thread = typeof this.ensureOrchestratorThread === 'function'
      ? this.ensureOrchestratorThread(session)
      : null;
    if (thread && typeof this.appendOrchestratorThreadMessage === 'function') {
      const instruction = [
        `Supervisor verdict: ${review.verdict}.`,
        review.summary ? `Summary: ${review.summary}` : '',
        review.findings.length ? `Findings:\n- ${review.findings.join('\n- ')}` : '',
        review.nextTask ? `Next task: ${review.nextTask}` : '',
        review.plan ? `Plan note: ${review.plan}` : '',
      ].filter(Boolean).join('\n');
      this.appendOrchestratorThreadMessage(thread, {
        id: randomUUID(),
        role: 'system',
        content: instruction,
        createdAt: now,
      });
      thread.updatedAt = now;
    }
    this.recordAudit({
      type: 'session_supervisor_audited',
      actor: review.actor,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Supervisor ${review.verdict} for session "${session.name}"`,
      status: review.status === 'accepted' ? 'passed' : review.status === 'blocked' ? 'failed' : 'pending',
      followUpQueued: review.status === 'fix_requested',
      evidence: { review },
    });
    this.persistState();
    return clonePayload({ sessionId: session.id, supervisorReview: review });
  },
};
