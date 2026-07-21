// Session capacity request/approval methods, as a prototype mixin for
// OrcaRegistry. Extracted from registry.js.

import { randomUUID } from 'node:crypto';
import { isLiveLaneState } from './worker-contract.js';
import { nowIso, safeArray, clonePayload } from './registry-utils.js';
import {
  normalizeApprovedCapacity,
  normalizeSpawnPolicy,
  normalizeIdleShutdownMode,
} from './registry-lane-config.js';

export const capacityMethods = {
  getSessionCapacity(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const approvedCapacity = normalizeApprovedCapacity(session.approvedCapacity, normalizeApprovedCapacity(session.laneConcurrencyLimit));
    const activeAgents = this.lanes.filter((lane) =>
      lane.sessionId === session.id && isLiveLaneState(lane.state)
    ).length;
    return {
      sessionId: session.id,
      spawnPolicy: normalizeSpawnPolicy(session.spawnPolicy),
      approvedCapacity,
      activeAgents,
      idleSlots: Math.max(0, approvedCapacity - activeAgents),
      soloMode: session.soloMode !== false,
      idleShutdownMode: normalizeIdleShutdownMode(session.idleShutdownMode),
      capacityRequests: safeArray(session.capacityRequests).map((request) => clonePayload(request)),
    };
  },

  requestCapacity(sessionLocator, {
    requestedCapacity,
    reason = '',
    tasksUnlocked = [],
    costRisk = '',
    actor = 'dashboard',
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const policyCheck = this.evaluateActionPolicy('requestCapacity', { actor, approved: true });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    const current = this.getSessionCapacity(session.id);
    const requested = normalizeApprovedCapacity(requestedCapacity, current.approvedCapacity);
    if (requested <= current.approvedCapacity) {
      return {
        alreadyWithinCapacity: true,
        request: null,
        capacity: current,
      };
    }
    const existing = safeArray(session.capacityRequests).find((request) =>
      request.status === 'pending' && request.requestedCapacity === requested
    );
    if (existing) {
      return {
        alreadyPending: true,
        request: clonePayload(existing),
        capacity: current,
      };
    }
    const request = {
      id: randomUUID(),
      status: 'pending',
      actor: String(actor || 'dashboard').slice(0, 120),
      requestedCapacity: requested,
      currentApprovedCapacity: current.approvedCapacity,
      reason: String(reason || '').trim().slice(0, 1000),
      tasksUnlocked: safeArray(tasksUnlocked).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20),
      costRisk: String(costRisk || '').trim().slice(0, 1000),
      createdAt: nowIso(),
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
    };
    session.capacityRequests = [request, ...safeArray(session.capacityRequests)].slice(0, 100);
    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'capacity_request_created',
      actor: request.actor,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Requested capacity ${requested} for session ${session.name}`,
      status: 'pending',
      followUpQueued: true,
      evidence: { request },
    });
    this.persistState();
    return {
      request: clonePayload(request),
      capacity: this.getSessionCapacity(session.id),
    };
  },

  approveCapacityRequest(sessionLocator, requestId, {
    actor = 'dashboard',
    approved,
    reason = '',
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const policyCheck = this.evaluateActionPolicy('manageCapacity', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    const request = safeArray(session.capacityRequests).find((item) => item.id === requestId);
    if (!request) throw { status: 404, message: 'Capacity request not found.' };
    if (request.status !== 'pending') {
      return { alreadyDecided: true, request: clonePayload(request), capacity: this.getSessionCapacity(session.id) };
    }
    request.status = 'approved';
    request.decidedAt = nowIso();
    request.decidedBy = String(actor || 'dashboard').slice(0, 120);
    request.decisionReason = String(reason || '').trim().slice(0, 1000);
    session.approvedCapacity = Math.max(normalizeApprovedCapacity(session.approvedCapacity), request.requestedCapacity);
    session.laneConcurrencyLimit = session.approvedCapacity;
    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'capacity_request_approved',
      actor: request.decidedBy,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Approved capacity ${session.approvedCapacity} for session ${session.name}`,
      status: 'passed',
      evidence: { request },
    });
    this.persistState();
    return { request: clonePayload(request), capacity: this.getSessionCapacity(session.id) };
  },

  rejectCapacityRequest(sessionLocator, requestId, {
    actor = 'dashboard',
    approved,
    reason = '',
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const policyCheck = this.evaluateActionPolicy('manageCapacity', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    const request = safeArray(session.capacityRequests).find((item) => item.id === requestId);
    if (!request) throw { status: 404, message: 'Capacity request not found.' };
    if (request.status !== 'pending') {
      return { alreadyDecided: true, request: clonePayload(request), capacity: this.getSessionCapacity(session.id) };
    }
    request.status = 'rejected';
    request.decidedAt = nowIso();
    request.decidedBy = String(actor || 'dashboard').slice(0, 120);
    request.decisionReason = String(reason || '').trim().slice(0, 1000);
    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'capacity_request_rejected',
      actor: request.decidedBy,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Rejected capacity request for session ${session.name}`,
      status: 'passed',
      evidence: { request },
    });
    this.persistState();
    return { request: clonePayload(request), capacity: this.getSessionCapacity(session.id) };
  },

  setCapacityPolicy(sessionLocator, {
    spawnPolicy,
    approvedCapacity,
    soloMode,
    idleShutdownMode,
    actor = 'dashboard',
    approved,
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const policyCheck = this.evaluateActionPolicy('manageCapacity', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    if (spawnPolicy !== undefined) session.spawnPolicy = normalizeSpawnPolicy(spawnPolicy, session.spawnPolicy || 'within_capacity');
    if (approvedCapacity !== undefined) {
      session.approvedCapacity = normalizeApprovedCapacity(approvedCapacity, normalizeApprovedCapacity(session.approvedCapacity));
      session.laneConcurrencyLimit = session.approvedCapacity;
    }
    if (soloMode !== undefined) session.soloMode = soloMode !== false;
    if (idleShutdownMode !== undefined) session.idleShutdownMode = normalizeIdleShutdownMode(idleShutdownMode, session.idleShutdownMode || 'immediate');
    session.updatedAt = nowIso();
    const capacity = this.getSessionCapacity(session.id);
    this.recordAudit({
      type: 'capacity_policy_updated',
      actor: String(actor || 'dashboard').slice(0, 120),
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Updated capacity policy for session ${session.name}`,
      status: 'passed',
      evidence: { capacity },
    });
    this.persistState();
    return capacity;
  },
};
