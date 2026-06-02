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

export const auditMethods = {
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
    lane.auditState = 'fix_requested';
    lane.state = FIX_REQUESTED_STATE;
    lane.updatedAt = nowIso();
    const record = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      findings: safeArray(findings).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100),
      nextTask: String(nextTask || '').trim().slice(0, 2000),
      recordedAt: nowIso(),
    };
    lane.auditFindings = [...safeArray(lane.auditFindings), record].slice(-50);
    this.recordAudit({
      type: 'lane_audit_fix_requested',
      actor: record.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Audit requested fix pass for lane ${lane.title}`,
      status: 'pending',
      followUpQueued: true,
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
