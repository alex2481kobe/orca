// Lane audit lifecycle methods (queue/accept/request-fix/block), as a prototype
// mixin for OrcaRegistry. Extracted from registry.js.

import { randomUUID } from 'node:crypto';
import { LANE_STATES, isLiveLaneState, isRunningLaneState } from './worker-contract.js';
import { nowIso, clonePayload, safeArray } from './registry-utils.js';

const MAX_AUDIT_DISPATCHES = 2;
// A lane has at most ONE pending audit follow-up regardless of how it was queued
// (per-lane queue vs session batch) — dedupe across both event types.
const AUDIT_QUEUE_TYPES = ['lane_audit_queued', 'session_audit_batch_queued'];

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

    // (a) Reconcile stuck audits: a separate-auditor lane that finished WITHOUT
    // recording a verdict leaves its target in 'auditing' forever (e.g. a non-
    // capable/mock auditor, or an agent that exited early). Re-dispatch a fresh
    // auditor up to a bound, then escalate — so an unattended run can't hang.
    let reconciled = false;
    for (const lane of this.lanes) {
      if (lane.auditState !== 'auditing' || !this.isAuditableExecutorLane(lane)) continue;
      const auditor = this.lanes.find((o) => o.owner === 'auditor' && o.auditTargetLaneId === lane.id);
      let stuckReason = null;
      if (!auditor) {
        // Orchestrator-tier (no auditor lane). The nudge spawns an orchestrator
        // "turn" lane (or is acted on by an enrolled external orchestrator). It is
        // only stuck — hanging in 'auditing' forever, and stranding any linked
        // backlog task in_lane — when NOTHING can still act on it: no live
        // orchestrator turn lane is running AND no enrolled orchestrator has a live
        // lease. Otherwise leave it; whoever is working will record the verdict.
        const liveOrchestratorTurn = this.lanes.some((o) => o.owner === 'orchestrator'
          && o.sessionId === lane.sessionId
          && isLiveLaneState(o.state));
        if (liveOrchestratorTurn) continue;
        // An orchestrator record that still owns this container and can act (not
        // resigned/stale) keeps the audit live; whoever is working records the verdict.
        const orch = (this.orchestrators || []).find((o) => o.id === lane.sessionId);
        if (orch && !orch.resignedAt && !this._orchestratorStale(orch)) continue;
        stuckReason = 'no orchestrator available to audit';
      } else {
        // Separate-auditor: only stuck once the auditor lane has finished without
        // recording a verdict.
        if (!['done', 'failed', 'stopped', 'accepted'].includes(String(auditor.state || '').toLowerCase())) continue;
        stuckReason = 'auditor finished without a verdict';
      }
      reconciled = true;
      if ((lane.auditDispatchCount || 0) < MAX_AUDIT_DISPATCHES) {
        lane.auditState = 'queued'; // re-dispatch next tick
      } else {
        lane.auditState = 'escalated';
        this.recordAudit({
          type: 'lane_audit_escalated', actor: 'scheduler', projectId: lane.projectId,
          sessionId: lane.sessionId, laneId: lane.id, status: 'failed',
          summary: `Audit could not complete automatically for lane "${lane.title}" — ${stuckReason}.`,
        });
      }
      lane.updatedAt = nowIso();
    }

    // (b) Dispatch queued audits.
    const queued = this.lanes.filter((lane) =>
      lane.auditState === 'queued' && this.isAuditableExecutorLane(lane));
    if (!queued.length) { if (reconciled) this.persistState(); return; }
    for (const lane of queued) {
      // v2 contract: every lane's container is an orchestrator, audited BY that
      // owning orchestrator (v2 has no supervisor and no separate-auditor fallback).
      // The finished lane already surfaces as "done — awaiting reply" in the
      // orchestrator's status view and the dashboard, so we emit ONE durable wakeup
      // event and leave the lane 'queued' for the orchestrator to accept
      // (audit.accept) or bounce (audit.request_fix). auditNudgedAt is cleared
      // whenever a lane re-enters 'queued' after a fix cycle (see markLaneCompleted),
      // so each completion notifies exactly once.
      const orch = (this.orchestrators || []).find((o) => o.id === lane.sessionId);
      if (!orch) continue;
      if (!lane.auditNudgedAt) {
        lane.auditNudgedAt = nowIso();
        lane.updatedAt = lane.auditNudgedAt;
        try {
          this.enqueueAgentEvent({
            type: 'audit_required',
            targetRole: 'orchestrator',
            title: `Audit executor lane "${lane.title}"`.slice(0, 160),
            body: `Executor lane ${lane.id} ("${lane.title}") finished and needs your audit: review its work, then accept it (audit.accept) or request fixes (audit.request_fix).`,
            actor: 'scheduler',
            projectId: lane.projectId,
            sessionId: orch.id,
            laneId: lane.id,
            dedupeKey: `audit-required:${lane.id}`,
          });
          this.appendLaneLog(lane, 'Audit required — notified orchestrator', { persist: false });
        } catch (error) {
          lane.auditNudgedAt = null;
          this.appendLaneLog(lane, `Audit notify failed: ${error?.message || error}`, { persist: false });
        }
        this.persistState();
      }
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
    const existing = this.auditEvents.find((event) =>
      AUDIT_QUEUE_TYPES.includes(event.type) &&
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
      [DONE_STATE, READY_FOR_AUDIT_STATE].includes(lane.state)
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
        AUDIT_QUEUE_TYPES.includes(event.type) &&
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
    // Don't accept a lane with a live/launching process (the dashboard path isn't
    // behind the workflow state gate). starting/running have an active child;
    // escalated/fix_requested/done/ready_for_audit/auditing/needs_critique remain
    // acceptable (the operator override path). 'queued' (no process yet) is gated
    // on the MCP path and harmless here.
    if (isRunningLaneState(lane.state)) {
      throw { status: 409, message: 'Cannot accept a lane that is still running. Stop it first.' };
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
