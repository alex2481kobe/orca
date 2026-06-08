// Lane audit lifecycle methods (queue/accept/request-fix/block), as a prototype
// mixin for OrcaRegistry. Extracted from registry.js.

import { randomUUID } from 'node:crypto';
import { LANE_STATES } from './worker-contract.js';
import { nowIso, clonePayload, safeArray } from './registry-utils.js';

const {
  READY_FOR_AUDIT: READY_FOR_AUDIT_STATE,
  FIX_REQUESTED: FIX_REQUESTED_STATE,
  ACCEPTED: ACCEPTED_STATE,
  BLOCKED: BLOCKED_STATE,
  DONE: DONE_STATE,
} = LANE_STATES;

const FLOW_DEFAULTS = {
  template: 'orchestrator-executor',
  auditTier: 'orchestrator',
  fixRouting: 'same-agent',
  maxAuditLoops: 2,
  requireAuditPass: true,
};

export const auditMethods = {
  // Resolve the layered agent-flow config (defaults -> project -> session -> lane)
  // for a lane. Falls back to safe defaults if settings can't be resolved.
  getLaneFlowConfig(lane) {
    if (!lane) return { ...FLOW_DEFAULTS };
    try {
      const effective = this.getEffectiveSettings({ laneId: lane.id });
      return { ...FLOW_DEFAULTS, ...(effective?.settings?.flow || {}) };
    } catch {
      return { ...FLOW_DEFAULTS };
    }
  },

  // Whether an executor lane's work MUST be audited before it can be reported
  // done / returned to the main orchestrator. Driven by the configurable flow:
  // the audit template or an explicit requireAuditPass both make audit mandatory.
  auditRequiredForLane(lane) {
    const flow = this.getLaneFlowConfig(lane);
    return Boolean(flow.requireAuditPass) || flow.template === 'orchestrator-executor-audit';
  },

  // True for a normal executor lane (not an orchestrator turn or a spawned
  // auditor) — only these get auto-audited.
  isAuditableExecutorLane(lane) {
    return Boolean(lane) && lane.owner !== 'orchestrator' && lane.owner !== 'auditor';
  },

  // Auto-run audits for lanes whose work is queued for review. Per the resolved
  // Auditor setting: 'separate-auditor' spawns a dedicated auditor lane scoped to
  // the executor lane's worktree; otherwise the orchestrator is nudged to audit.
  // Idempotent — flips auditState to 'auditing' before dispatch so a lane is only
  // dispatched once. Bounded by maxAuditLoops via requestLaneFix escalation.
  async dispatchPendingAudits() {
    if (!this.autoAuditEnabled) return;
    const queued = this.lanes.filter((lane) =>
      lane.auditState === 'queued' && this.isAuditableExecutorLane(lane));
    for (const lane of queued) {
      const session = this.getSession(lane.sessionId);
      if (!session) continue;
      const flow = this.getLaneFlowConfig(lane);
      // Mark dispatched up front so a throw can't cause re-dispatch every tick.
      lane.auditState = 'auditing';
      lane.updatedAt = nowIso();
      try {
        if (flow.auditTier === 'separate-auditor') {
          const existing = this.lanes.find((other) =>
            other.owner === 'auditor' &&
            other.auditTargetLaneId === lane.id &&
            !['accepted', 'failed', 'stopped'].includes(String(other.state || '').toLowerCase()));
          if (existing) continue;
          await this.createLane(session.id, {
            title: `Audit · ${lane.title}`.slice(0, 200),
            taskDescription: `Review the work produced by lane "${lane.title}".`,
            executorType: lane.executorType,
            owner: 'auditor',
            auditTargetLaneId: lane.id,
            workdir: lane.workdir,
            sharedWorktree: true,
            taskPrompt: this.buildAuditorPrompt(lane),
          }, { actor: 'scheduler', approved: true });
        } else if (typeof this.sendOrchestratorMessage === 'function') {
          await this.sendOrchestratorMessage(session.id, {
            message: `Audit completed executor lane "${lane.title}" (lane ${lane.id}): review its work, then accept it or request fixes.`,
          }, { actor: 'scheduler', approved: true });
        }
        this.appendLaneLog(lane, `Audit auto-dispatched (${flow.auditTier === 'separate-auditor' ? 'separate auditor' : 'orchestrator'})`, { persist: false });
      } catch (error) {
        this.appendLaneLog(lane, `Audit auto-dispatch failed: ${error?.message || error}`, { persist: false });
      }
      this.persistState();
    }
  },

  buildAuditorPrompt(lane) {
    return [
      `You are the auditor for executor lane "${lane.title}" (lane id ${lane.id}).`,
      'Review its changes in this worktree against the task it was given.',
      'When done, call the audit tool to accept the work (audit.accept) or request fixes',
      '(audit.request_fix) with concrete findings. Do not start unrelated work.',
    ].join(' ');
  },

  queueLaneAudit(laneLocator, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('auditLane', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    if (this.critiqueRequiredForLane(lane) && !this.critiqueSatisfiedForLane(lane)) {
      throw { status: 409, message: 'Lane requires self-verification before audit can be queued.' };
    }

    const existing = this.auditEvents.find((event) =>
      event.type === 'lane_audit_queued' &&
      event.laneId === lane.id &&
      event.status === 'pending' &&
      event.followUpQueued
    );
    if (existing) {
      return {
        id: existing.id,
        queueId: existing.id,
        event: clonePayload(existing),
        lane: clonePayload(lane),
        alreadyQueued: true,
      };
    }

    this.appendLaneLog(lane, `Audit requested by ${context.actor || 'dashboard'}`);
    lane.auditState = 'queued';
    const queueId = this.recordAudit({
      type: 'lane_audit_queued',
      actor: context.actor || 'dashboard',
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Review requested for lane ${lane.title}`,
      evidence: {
        laneSnapshot: {
          title: lane.title,
          state: lane.state,
          logs: lane.logs.length,
        },
      },
      status: 'pending',
      followUpQueued: true,
    });
    this.persistState();
    const event = this.auditEvents.find((item) => item.id === queueId) || null;
    return { id: queueId, queueId, event: event ? clonePayload(event) : null, lane: clonePayload(lane) };
  },

  async queueDoneLanesAudit(sessionLocator, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }

    const doneLanes = this.lanes.filter((lane) =>
      lane.sessionId === session.id &&
      [DONE_STATE, READY_FOR_AUDIT_STATE].includes(lane.state) &&
      (!this.critiqueRequiredForLane(lane) || this.critiqueSatisfiedForLane(lane))
    );
    if (!doneLanes.length) {
      return { enqueued: 0, queueIds: [] };
    }

    const policyCheck = this.evaluateActionPolicy('auditDoneLanes', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const queueIds = [];
    let enqueuedNew = 0;
    for (const lane of doneLanes) {
      const existing = this.auditEvents.find((event) =>
        event.type === 'session_audit_batch_queued' &&
        event.laneId === lane.id &&
        event.status === 'pending' &&
        event.followUpQueued
      );
      if (existing) {
        queueIds.push(existing.id);
        continue;
      }
      this.appendLaneLog(lane, `Session-level audit queued by ${context.actor || 'dashboard'}`);
      lane.auditState = 'queued';
      const queueId = this.recordAudit({
        type: 'session_audit_batch_queued',
        actor: context.actor || 'dashboard',
        projectId: lane.projectId,
        sessionId: session.id,
        laneId: lane.id,
        summary: `Session audit queued for lane ${lane.title}`,
        evidence: { laneSnapshot: { id: lane.id, state: lane.state } },
        status: 'pending',
        followUpQueued: true,
      });
      queueIds.push(queueId);
      enqueuedNew += 1;
    }

    this.persistState();
    return {
      enqueued: doneLanes.length,
      enqueuedNew,
      queueIds,
      alreadyQueued: doneLanes.length - enqueuedNew,
    };
  },

  acceptLaneAudit(laneLocator, {
    actor = 'dashboard',
    findings = [],
    reviewedFiles = [],
    verdict = 'accepted',
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    if (this.critiqueRequiredForLane(lane) && !this.critiqueSatisfiedForLane(lane)) {
      throw { status: 409, message: 'Cannot accept lane before required critique is satisfied.' };
    }
    lane.auditState = 'accepted';
    lane.state = ACCEPTED_STATE;
    lane.auditLoopCount = 0; // work passed audit — reset the fix-loop budget
    lane.updatedAt = nowIso();
    const record = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      verdict,
      findings: safeArray(findings).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100),
      reviewedFiles: safeArray(reviewedFiles).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 200),
      recordedAt: nowIso(),
    };
    lane.auditFindings = [...safeArray(lane.auditFindings), record].slice(-50);
    for (const event of this.auditEvents) {
      if (event.laneId === lane.id && event.status === 'pending' && ['lane_audit_queued', 'session_audit_batch_queued'].includes(event.type)) {
        event.status = 'passed';
        event.reviewedAt = nowIso();
      }
    }
    this.recordAudit({
      type: 'lane_audit_accepted',
      actor: record.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Audit accepted lane ${lane.title}`,
      status: 'passed',
      evidence: record,
    });
    this.persistState();
    return { lane: clonePayload(lane), audit: clonePayload(record) };
  },

  requestLaneFix(laneLocator, {
    actor = 'dashboard',
    findings = [],
    nextTask = '',
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const flow = this.getLaneFlowConfig(lane);
    // Count audit -> fix loops; once the configured budget is exhausted, escalate
    // to the user instead of looping forever.
    const loop = (Number.isInteger(lane.auditLoopCount) ? lane.auditLoopCount : 0) + 1;
    lane.auditLoopCount = loop;
    const loopsRemaining = Math.max(0, (Number.isInteger(flow.maxAuditLoops) ? flow.maxAuditLoops : 2) - loop);
    const escalated = loopsRemaining <= 0;
    lane.auditState = escalated ? 'escalated' : 'fix_requested';
    lane.state = FIX_REQUESTED_STATE;
    lane.updatedAt = nowIso();
    const record = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      findings: safeArray(findings).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100),
      nextTask: String(nextTask || '').trim().slice(0, 2000),
      // Where the fix should go next, per the configurable flow.
      fixRouting: flow.fixRouting === 'new-agent' ? 'new-agent' : 'same-agent',
      loop,
      loopsRemaining,
      escalated,
      recordedAt: nowIso(),
    };
    lane.auditFindings = [...safeArray(lane.auditFindings), record].slice(-50);
    this.recordAudit({
      type: escalated ? 'lane_audit_escalated' : 'lane_audit_fix_requested',
      actor: record.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: escalated
        ? `Audit loop budget exhausted (${loop}) — escalating lane ${lane.title} to the user`
        : `Audit requested fix pass ${loop} for lane ${lane.title} (${record.fixRouting})`,
      status: escalated ? 'failed' : 'pending',
      followUpQueued: !escalated,
      evidence: record,
    });
    this.persistState();
    return { lane: clonePayload(lane), audit: clonePayload(record) };
  },

  blockLaneAudit(laneLocator, {
    actor = 'dashboard',
    reason = '',
    findings = [],
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const blockReason = String(reason || '').trim();
    if (!blockReason) throw { status: 422, message: 'Blocking an audit requires a reason.' };
    lane.auditState = 'blocked';
    lane.state = BLOCKED_STATE;
    lane.updatedAt = nowIso();
    const record = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      reason: blockReason.slice(0, 2000),
      findings: safeArray(findings).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100),
      recordedAt: nowIso(),
    };
    lane.auditFindings = [...safeArray(lane.auditFindings), record].slice(-50);
    this.recordAudit({
      type: 'lane_audit_blocked',
      actor: record.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Audit blocked lane ${lane.title}`,
      status: 'failed',
      evidence: record,
    });
    this.persistState();
    return { lane: clonePayload(lane), audit: clonePayload(record) };
  },
};
