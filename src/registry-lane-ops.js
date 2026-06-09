// Lane operations: submit, approvals, controls, stop/retry/heartbeat, artifacts,
// worktree removal — prototype mixin for OrcaRegistry. Extracted from registry.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LANE_STATES } from './worker-contract.js';
import { nowIso, clonePayload, safeArray } from './registry-utils.js';
import { removeLaneWorktree } from './worktree-manager.js';
import { validateNetworkUrl } from './url-policy.js';

const {
  QUEUED: QUEUED_STATE,
  STARTING: STARTING_STATE,
  RUNNING: RUNNING_STATE,
  NEEDS_CRITIQUE: NEEDS_CRITIQUE_STATE,
  READY_FOR_AUDIT: READY_FOR_AUDIT_STATE,
  FIX_REQUESTED: FIX_REQUESTED_STATE,
  ACCEPTED: ACCEPTED_STATE,
  BLOCKED: BLOCKED_STATE,
  STOPPED: STOPPED_STATE,
  DONE: DONE_STATE,
  FAILED: FAILED_STATE,
} = LANE_STATES;

function isLiveLaneState(state) {
  return [QUEUED_STATE, STARTING_STATE, RUNNING_STATE].includes(String(state || '').toLowerCase());
}

export const laneOpsMethods = {
  // Permanently remove a TERMINAL lane (done/failed/stopped/accepted/blocked):
  // best-effort worktree cleanup, clear runtime maps, unlink any backlog task,
  // drop the record. Refuses a live lane so a running child can't be orphaned.
  async deleteLane(laneLocator, { actor = 'dashboard' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const deletable = new Set([DONE_STATE, FAILED_STATE, STOPPED_STATE, ACCEPTED_STATE, BLOCKED_STATE, 'archived']);
    if (!deletable.has(lane.state)) {
      throw { status: 422, message: 'Stop the lane before deleting it.' };
    }
    if (typeof this.clearLaneExecutor === 'function') this.clearLaneExecutor(lane.id);
    this.laneRuntimeEnv?.delete(String(lane.id));
    if (typeof this.removeLaneWorktree === 'function') {
      try { await this.removeLaneWorktree(lane.id, { actor, approved: true, removeBranch: false }); } catch { /* best effort */ }
    }
    this.lanes = (this.lanes || []).filter((entry) => entry.id !== lane.id);
    const affectedSessions = new Set();
    for (const task of this.tasks || []) {
      if (task.laneId !== lane.id) continue;
      // A backlog task still linked to this lane would be stranded: a non-terminal
      // task (in_lane/assigned) whose lane just vanished can never be accepted/failed
      // by the (now gone) lane, so dispatchPendingTasks won't re-spawn it and the
      // backlog never completes. Requeue it (within attempt budget) or fail it.
      if (task.state === 'in_lane' || task.state === 'assigned') {
        if ((task.attempts || 0) < (task.maxAttempts || 1)) {
          task.state = 'pending';
          task.laneId = null;
        } else {
          task.state = 'failed';
          task.laneId = null;
          task.terminatedAt = nowIso();
        }
        task.updatedAt = nowIso();
        affectedSessions.add(task.sessionId);
      } else {
        task.laneId = null;
      }
    }
    for (const sessionId of affectedSessions) {
      if (typeof this.evaluateBacklogCompletion === 'function') this.evaluateBacklogCompletion(sessionId);
    }
    this.recordAudit({
      type: 'lane_deleted',
      actor: String(actor || 'dashboard').slice(0, 120),
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Lane "${lane.title}" deleted`,
      status: 'passed',
    });
    this.persistState();
    return { deleted: true, id: lane.id };
  },

  submitLane(laneLocator, { actor = 'executor', summary = '', changedFiles = [], handoff = '' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const submittable = new Set([STARTING_STATE, RUNNING_STATE, NEEDS_CRITIQUE_STATE]);
    if (!submittable.has(lane.state)) {
      throw { status: 409, message: `Lane cannot be submitted from state "${lane.state}".` };
    }
    if (summary) lane.summary = String(summary).slice(0, 4000);
    if (Array.isArray(changedFiles) && changedFiles.length) {
      lane.changedFiles = changedFiles.map((file) => String(file).slice(0, 400)).slice(0, 500);
    }
    if (handoff) lane.handoff = String(handoff).slice(0, 4000);
    const needsCritique = this.critiqueRequiredForLane(lane) && !this.critiqueSatisfiedForLane(lane);
    lane.state = needsCritique ? NEEDS_CRITIQUE_STATE : READY_FOR_AUDIT_STATE;
    lane.submittedAt = nowIso();
    lane.updatedAt = nowIso();
    this.appendLaneAgentEvent(lane, {
      type: 'agent.submitted',
      title: 'Lane submitted for review',
      content: lane.summary || '',
    }, { persist: false });
    this.recordAudit({
      type: 'lane_submitted',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Lane ${lane.title} submitted (${needsCritique ? 'needs self-verification' : 'ready for audit'})`,
      status: needsCritique ? 'pending' : 'passed',
      evidence: { summary: lane.summary || '', changedFiles: lane.changedFiles || [] },
    });
    this.persistState();
    return { lane: clonePayload(lane), needsCritique };
  },

  // --- Permission-approval relay (Codex-app-style approval loop) -----------
  // An executor agent that hits a permission decision records a pending approval;
  // the orchestrator (or user) approves/denies; the decision is relayed back.
  recordLaneApproval(laneLocator, { kind = 'command', detail = '', requestId = '', actor = 'executor' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const normalizedKind = ['command', 'patch', 'tool', 'network', 'other'].includes(String(kind))
      ? String(kind) : 'other';
    const approval = {
      id: randomUUID(),
      requestId: String(requestId || '').slice(0, 200) || null,
      kind: normalizedKind,
      detail: String(detail || '').slice(0, 2000),
      status: 'pending',
      decision: null,
      requestedBy: String(actor || 'executor').slice(0, 120),
      requestedAt: nowIso(),
      decidedBy: null,
      decidedAt: null,
    };
    lane.pendingApprovals = [...safeArray(lane.pendingApprovals), approval].slice(-50);
    lane.awaitingApproval = true;
    lane.updatedAt = nowIso();
    this.appendLaneAgentEvent(lane, {
      type: 'agent.approval_requested',
      title: `Approval requested: ${approval.kind}`,
      content: approval.detail,
    }, { persist: false });
    this.recordAudit({
      type: 'lane_approval_requested',
      actor: approval.requestedBy,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Approval requested (${approval.kind}) for lane ${lane.title}`,
      status: 'pending',
      evidence: { approval },
    });
    this.persistState();
    return { lane: clonePayload(lane), approval: clonePayload(approval) };
  },

  decideLaneApproval(laneLocator, approvalId, { decision, actor = 'dashboard' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const normalized = String(decision || '').toLowerCase();
    const approve = ['approve', 'approved', 'allow', 'yes'].includes(normalized);
    const deny = ['deny', 'denied', 'reject', 'no'].includes(normalized);
    if (!approve && !deny) throw { status: 422, message: 'Decision must be approve or deny.' };
    const approval = safeArray(lane.pendingApprovals).find((entry) => entry.id === approvalId);
    if (!approval) throw { status: 404, message: 'Approval not found.' };
    if (approval.status !== 'pending') throw { status: 409, message: `Approval already ${approval.status}.` };
    approval.status = approve ? 'approved' : 'denied';
    approval.decision = approve ? 'approve' : 'deny';
    approval.decidedBy = String(actor || 'dashboard').slice(0, 120);
    approval.decidedAt = nowIso();
    lane.awaitingApproval = safeArray(lane.pendingApprovals).some((entry) => entry.status === 'pending');
    lane.updatedAt = nowIso();
    this.appendLaneAgentEvent(lane, {
      type: 'agent.approval_decided',
      title: `Approval ${approval.status}`,
      content: approval.detail,
    }, { persist: false });
    this.recordAudit({
      type: 'lane_approval_decided',
      actor: approval.decidedBy,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Approval ${approval.status} for lane ${lane.title}`,
      status: approve ? 'passed' : 'failed',
      evidence: { approval },
    });
    this.persistState();
    return { lane: clonePayload(lane), approval: clonePayload(approval) };
  },

  getLaneApprovals(laneLocator) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    return {
      laneId: lane.id,
      awaitingApproval: Boolean(lane.awaitingApproval),
      approvals: safeArray(lane.pendingApprovals).map(clonePayload),
    };
  },

  updateLaneControls(laneLocator, {
    model,
    permissionsProfile,
    intelligenceProfile,
    targetUrl,
    verificationCommand,
  } = {}, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('updateLaneControls', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const before = {
      model: lane.model || '',
      permissionsProfile: lane.permissionsProfile || '',
      intelligenceProfile: lane.intelligenceProfile || '',
      targetUrl: lane.targetUrl || '',
      verificationCommand: lane.verificationCommand || '',
    };
    // targetUrl and verificationCommand are optional and may be set by the USER
    // or learned/set by an AGENT later (executor/orchestrator) — when the user
    // leaves them blank at create time, the agent fills them in via this path.
    let nextTargetUrl = before.targetUrl;
    if (typeof targetUrl === 'string') {
      const trimmed = targetUrl.trim();
      nextTargetUrl = trimmed
        ? validateNetworkUrl(trimmed, { field: 'targetUrl', allowSensitive: false }).url
        : '';
    }
    const next = {
      model: typeof model === 'string' ? model.trim().slice(0, 120) : before.model,
      permissionsProfile: typeof permissionsProfile === 'string' ? permissionsProfile.trim().slice(0, 120) : before.permissionsProfile,
      intelligenceProfile: typeof intelligenceProfile === 'string' ? intelligenceProfile.trim().slice(0, 80) : before.intelligenceProfile,
      targetUrl: nextTargetUrl,
      verificationCommand: typeof verificationCommand === 'string' ? verificationCommand.trim().slice(0, 1000) : before.verificationCommand,
    };

    lane.model = next.model;
    lane.permissionsProfile = next.permissionsProfile;
    lane.intelligenceProfile = next.intelligenceProfile;
    lane.targetUrl = next.targetUrl;
    lane.verificationCommand = next.verificationCommand;
    lane.executorCapabilities = this.getExecutorCapabilities(lane.executorType);
    lane.updatedAt = nowIso();
    this.appendLaneLog(
      lane,
      `Lane controls updated: model=${next.model || 'default'}, mode=${next.permissionsProfile || 'default'}, intelligence=${next.intelligenceProfile || 'default'}.`,
      { persist: false },
    );
    this.appendLaneAgentEvent(lane, {
      type: 'agent.controls_updated',
      source: lane.executorType,
      title: 'Controls updated',
      content: `Model: ${next.model || 'default'}\nMode: ${next.permissionsProfile || 'default'}\nIntelligence: ${next.intelligenceProfile || 'default'}`,
    }, { persist: false });
    this.recordAudit({
      type: 'lane_controls_updated',
      actor: context.actor || 'dashboard',
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Updated controls for lane ${lane.title}`,
      status: 'passed',
      evidence: {
        before,
        after: next,
        runningProcess: isLiveLaneState(lane.state),
      },
    });
    this.persistState();
    return clonePayload(lane);
  },

  async stopLane(laneLocator, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('stopLane', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    if ([DONE_STATE, FAILED_STATE, STOPPED_STATE].includes(lane.state)) {
      this.clearLaneExecutor(lane.id);
      return clonePayload(lane);
    }

    const executor = this.getExecutorForLane(lane);
    const workerStopped = await executor.stop(lane.id, {
      actor: context.actor || 'dashboard',
      reason: `Stopped by ${context.actor || 'dashboard'}`,
    });
    if (!workerStopped.stopped) {
      const now = nowIso();
      lane.state = STOPPED_STATE;
      lane.exitReason = `Stopped by ${context.actor || 'dashboard'}`;
      lane.completedAt = now;
      lane.updatedAt = now;
      this.appendLaneLog(lane, lane.exitReason, { persist: false });
      this.appendLaneAgentEvent(lane, {
        type: 'agent.stopped',
        source: lane.executorType,
        title: 'Agent stopped',
        content: lane.exitReason,
      });
      this.notifyOrchestratorManualLaneStop(lane, context.actor || 'dashboard', lane.exitReason);
      this.recordAudit({
        type: 'lane_stopped',
        actor: context.actor || 'dashboard',
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Lane ${lane.title} stopped`,
        evidence: { lane },
        status: 'passed',
      });
      this.notifyLaneTerminal(
        lane,
        'warning',
        'Lane stopped',
        `${lane.title} stopped: ${lane.exitReason}`,
      );
    }
    this.clearLaneExecutor(lane.id);
    this.persistState();
    return clonePayload(lane);
  },

  retryLane(laneLocator, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('retryLane', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    // Blocked lanes are retryable too — a deliberate "reset & retry" after the
    // operator has addressed why the auditor blocked it (retryLane clears the
    // audit/critique state below).
    if (![FAILED_STATE, STOPPED_STATE, FIX_REQUESTED_STATE, BLOCKED_STATE].includes(lane.state)) {
      throw { status: 409, message: `Lane state "${lane.state}" is not retryable.` };
    }
    this.clearLaneExecutor(lane.id);

    lane.state = QUEUED_STATE;
    lane.updatedAt = nowIso();
    lane.exitReason = null;
    lane.completedAt = null;
    lane.startedAt = null;
    lane.auditState = 'not_queued';
    lane.critiqueState = this.critiqueRequiredForLane(lane) ? 'needed' : 'not_required';
    lane.critiqueNonce = null;
    lane.critiqueRevision = (Number.parseInt(lane.critiqueRevision, 10) || 1) + 1;
    // If this lane came from a backlog task that was requeued to 'pending' when the
    // lane failed, re-link it so the retry's eventual accept/fail syncs the task
    // (otherwise markTask*FromLane finds no task) and dispatchPendingTasks won't
    // also spawn a second lane for it. Only relink a still-pending, unlinked task —
    // never steal one already running on another live lane.
    if (lane.metadataTaskId && typeof this.getTask === 'function') {
      const task = this.getTask(lane.metadataTaskId);
      if (task && task.state === 'pending' && !task.laneId) {
        task.state = 'in_lane';
        task.laneId = String(lane.id);
        task.updatedAt = nowIso();
      }
    }
    this.appendLaneLog(lane, `Retry requested by ${context.actor || 'dashboard'}`);
    this.recordAudit({
      type: 'lane_retried',
      actor: context.actor || 'dashboard',
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Retry requested for lane ${lane.title}`,
      evidence: { lane },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(lane);
  },


  async touchHeartbeat(laneLocator, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const executor = this.getExecutorForLane(lane);
    const updated = executor.touchHeartbeat(lane.id, context.actor || 'mock-worker');
    if (!updated) {
      return clonePayload(lane);
    }
    lane.heartbeatAt = nowIso();
    return clonePayload(lane);
  },

  async listArtifactFiles(laneLocator) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const laneDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
    try {
      const entries = await fs.readdir(laneDir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        // Defense-in-depth: ensure the entry resolves inside laneDir even if
        // the filesystem races a symlink swap between readdir and lstat.
        try {
          const resolved = await fs.realpath(path.join(laneDir, entry.name));
          const laneReal = await fs.realpath(laneDir);
          if (resolved !== path.join(laneReal, entry.name)) continue;
        } catch {
          continue;
        }
        files.push(entry.name);
      }
      return files.sort();
    } catch {
      return [];
    }
  },


  async removeLaneWorktree(laneLocator, { actor = 'dashboard', approved, removeBranch = false } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    if (!lane.repoRoot || !lane.worktreePath) {
      throw { status: 422, message: 'Lane has no managed worktree to remove.' };
    }
    const policyCheck = this.evaluateActionPolicy('cleanupArtifacts', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    if (![DONE_STATE, READY_FOR_AUDIT_STATE, ACCEPTED_STATE, FIX_REQUESTED_STATE, BLOCKED_STATE, FAILED_STATE, STOPPED_STATE].includes(lane.state)) {
      throw { status: 409, message: 'Lane is still active; stop it before removing its worktree.' };
    }
    const result = removeLaneWorktree({
      repoRoot: lane.repoRoot,
      worktreePath: lane.worktreePath,
      removeBranch,
      branch: lane.branch || null,
    });
    if (!result.removed) {
      throw { status: 500, message: result.reason || 'Could not remove worktree.' };
    }
    lane.worktreePath = '';
    this.recordAudit({
      type: 'lane_worktree_removed',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Worktree removed for lane ${lane.title}`,
      evidence: { lane, branchRemoved: result.branchRemoved },
      status: 'passed',
    });
    this.persistState();
    return { removed: true, branchRemoved: result.branchRemoved };
  },
};
