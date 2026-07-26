// Lane audit lifecycle methods (queue/accept/request-fix/block), as a prototype
// mixin for OrcaRegistry.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LANE_STATES, isLiveLaneState, isRunningLaneState } from './worker-contract.js';
import { nowIso, clonePayload, safeArray } from './registry-utils.js';
import { buildNextActionEnvelope } from './agent-tools/next-action.js';

// Files that count as captured visual/browser evidence for a targetUrl lane.
const EVIDENCE_ARTIFACT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.mp4', '.webm']);

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

// The agent-flow config. This used to be a 3-tier override cascade with
// provenance tracking (effective-settings/, 257 lines) whose only runtime reader
// was getLaneFlowConfig below and which no route or UI ever wrote to. It is now a
// plain optional field on the lane: `lane.flow`, validated on spawn.
const FLOW_DEFAULTS = {
  // orchestrator-only            : orchestrator does the work itself, no executor lanes
  // orchestrator-executor        : orchestrator spawns executors; results return to it
  // orchestrator-executor-audit  : executor work is audited before returning
  template: 'orchestrator-executor',
  // After an executor submits, who audits: the orchestrator, or a separate auditor lane.
  auditTier: 'orchestrator',
  // When an audit requests fixes: back to the same executor, or a fresh one.
  fixRouting: 'same-agent',
  // How many audit -> fix -> re-audit loops before escalating to the user.
  maxAuditLoops: 2,
  // A lane cannot be returned to the orchestrator until an audit accepts it.
  requireAuditPass: true,
};

const FLOW_FIELDS = {
  template: ['orchestrator-only', 'orchestrator-executor', 'orchestrator-executor-audit'],
  auditTier: ['orchestrator'],
  fixRouting: ['same-agent', 'new-agent'],
};

// Validate a caller-supplied flow override. Unknown keys and bad values are
// rejected (422) rather than silently dropped, so a typo is visible.
export function sanitizeFlowConfig(raw = {}) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw { status: 422, message: 'flow must be an object.' };
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (FLOW_FIELDS[key]) {
      if (!FLOW_FIELDS[key].includes(value)) {
        throw { status: 422, message: `flow.${key} must be one of: ${FLOW_FIELDS[key].join(', ')}.` };
      }
      out[key] = value;
    } else if (key === 'maxAuditLoops') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
        throw { status: 422, message: 'flow.maxAuditLoops must be an integer between 0 and 10.' };
      }
      out[key] = parsed;
    } else if (key === 'requireAuditPass') {
      if (typeof value !== 'boolean') {
        throw { status: 422, message: 'flow.requireAuditPass must be a boolean.' };
      }
      out[key] = value;
    } else {
      throw { status: 422, message: `Unknown flow setting "${key}".` };
    }
  }
  return out;
}

export const auditMethods = {
  // The agent-flow config for a lane: defaults, with the lane's own validated
  // overrides on top.
  getLaneFlowConfig(lane) {
    if (!lane) return { ...FLOW_DEFAULTS };
    return { ...FLOW_DEFAULTS, ...(lane.flow || {}) };
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

  // Auto-run audits for lanes whose work is queued for review: the lane's owning
  // orchestrator is nudged to audit it. (There is no separate-auditor tier — that
  // value was accepted by validation but never dispatched, so a caller asking for
  // an independent audit silently got a self-audit instead. It is gone.)
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
      // owning orchestrator (v2 has no separate-auditor fallback).
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

  laneHasCapturedEvidence(lane) {
    if (!lane) return false;
    if (lane.lastEvidence && lane.lastEvidenceCaptureAt) return true;
    try {
      const dir = path.join(process.cwd(), 'artifacts', String(lane.sessionId), String(lane.id));
      for (const name of fs.readdirSync(dir)) {
        if (EVIDENCE_ARTIFACT_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;
      }
    } catch { /* no artifact dir yet */ }
    return false;
  },

  // Build a nextAction envelope for an audit outcome. Optionally override the
  // computed nextRequiredTool with the concrete corrective/next tool for the call.
  _auditNextAction(lane, overrideTool = null) {
    try {
      const env = buildNextActionEnvelope(this, {
        role: 'orchestrator',
        projectId: lane?.projectId || null,
        sessionId: lane?.sessionId || null,
        laneId: lane?.id || null,
        lean: true,
      });
      return overrideTool ? { ...env, nextRequiredTool: overrideTool } : env;
    } catch {
      return overrideTool ? { nextRequiredTool: overrideTool } : null;
    }
  },

  // Build a nextAction envelope that points a refused accept at the recovery tool.
  _auditFindingsNextAction(lane) {
    return this._auditNextAction(lane, 'audit.findings.record');
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
    // escalated/fix_requested/done/ready_for_audit/auditing remain
    // acceptable (the operator override path). 'queued' (no process yet) is gated
    // on the MCP path and harmless here.
    if (isRunningLaneState(lane.state)) {
      throw { status: 409, message: 'Cannot accept a lane that is still running. Stop it first.' };
    }
    const findingsList = safeArray(findings).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100);
    const reviewedList = safeArray(reviewedFiles).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 200);
    // Integrity gate: an accept must record a real review — at least one finding
    // or a reviewed file — so an agent (or a hasty operator) can't rubber-stamp
    // work with an empty verdict. The corrective step is audit.findings.record.
    if (!findingsList.length && !reviewedList.length) {
      throw {
        status: 409,
        message: 'Cannot accept an audit with no recorded review. Record at least one finding or list the files you reviewed (audit.findings.record) before accepting.',
        nextAction: this._auditFindingsNextAction(lane),
      };
    }
    // UI/browser lanes (a targetUrl was set) additionally require fresh captured
    // evidence — a screenshot/artifact — so nobody signs off on visual work
    // sight-unseen.
    if (lane.targetUrl && !this.laneHasCapturedEvidence(lane)) {
      throw {
        status: 409,
        message: 'This lane targets a URL (UI/browser work); accepting it requires fresh captured evidence (a screenshot or artifact). Capture evidence in the lane, then record findings that reference it (audit.findings.record).',
        nextAction: this._auditFindingsNextAction(lane),
      };
    }
    lane.auditState = 'accepted';
    lane.state = ACCEPTED_STATE;
    lane.auditLoopCount = 0; // work passed audit — reset the fix-loop budget
    lane.updatedAt = nowIso();
    const record = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      verdict,
      findings: findingsList,
      reviewedFiles: reviewedList,
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
    // After accept, an isolated lane's work still needs merging back — point the
    // agent at lane.integrate; other lanes are done in place.
    const nextTool = lane.worktreeMode === 'isolated' ? 'lane.integrate' : null;
    return { lane: clonePayload(lane), audit: clonePayload(record), nextAction: this._auditNextAction(lane, nextTool) };
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
    // Route the agent to the fix per the flow (new lane vs retry this one), or to
    // escalation when the loop budget is spent.
    const nextTool = escalated
      ? 'orchestrator.status'
      : (record.fixRouting === 'new-agent' ? 'executor.spawn' : 'lane.retry');
    return { lane: clonePayload(lane), audit: clonePayload(record), nextAction: this._auditNextAction(lane, nextTool) };
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
