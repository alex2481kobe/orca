// Lane operations: submit, approvals, controls, stop/retry/heartbeat, artifacts,
// worktree removal — prototype mixin for OrcaRegistry.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LANE_STATES, isLiveLaneState } from './worker-contract.js';
import { nowIso, clonePayload, safeArray } from './registry-utils.js';
import { removeLaneWorktree, mergeLaneBranch, worktreeCleanliness } from './worktree-manager.js';
import { validateNetworkUrl } from './url-policy.js';
import { buildNextActionEnvelope } from './agent-tools/next-action.js';

const {
  QUEUED: QUEUED_STATE,
  STARTING: STARTING_STATE,
  RUNNING: RUNNING_STATE,
  READY_FOR_AUDIT: READY_FOR_AUDIT_STATE,
  FIX_REQUESTED: FIX_REQUESTED_STATE,
  ACCEPTED: ACCEPTED_STATE,
  BLOCKED: BLOCKED_STATE,
  STOPPED: STOPPED_STATE,
  DONE: DONE_STATE,
  FAILED: FAILED_STATE,
} = LANE_STATES;

export const laneOpsMethods = {
  // Attach a machine-readable next step to a recoverable refusal so an agent can
  // self-correct without an extra orchestrator.status round-trip. Overrides the
  // computed nextRequiredTool with the corrective tool for this specific refusal.
  _laneNextAction(lane, nextRequiredTool) {
    try {
      const env = buildNextActionEnvelope(this, {
        role: 'orchestrator',
        projectId: lane?.projectId || null,
        sessionId: lane?.sessionId || null,
        laneId: lane?.id || null,
        lean: true,
      });
      return nextRequiredTool ? { ...env, nextRequiredTool } : env;
    } catch {
      return nextRequiredTool ? { nextRequiredTool } : null;
    }
  },

  // Permanently remove a TERMINAL lane (done/failed/stopped/accepted/blocked):
  // best-effort worktree cleanup, clear runtime maps, unlink any backlog task,
  // drop the record. Refuses a live lane so a running child can't be orphaned.
  async deleteLane(laneLocator, { actor = 'dashboard' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const deletable = new Set([DONE_STATE, FAILED_STATE, STOPPED_STATE, ACCEPTED_STATE, BLOCKED_STATE, 'archived']);
    if (!deletable.has(lane.state)) {
      throw { status: 422, message: 'Stop the lane before deleting it.', nextAction: this._laneNextAction(lane, 'lane.shutdown') };
    }
    // A deletable STATE is not a dead process: an accepted lane can still have a
    // live child (audit.accept is allowed straight from ready_for_audit). Dropping
    // the record then discards the only handle anything has on that process.
    if (typeof this.isLaneProcessLive === 'function' && this.isLaneProcessLive(lane.id)) {
      throw {
        status: 409,
        message: 'Lane still has a live executor process; deleting the record now would orphan it. Stop the lane first (lane.shutdown), then delete.',
        processLive: true,
        nextAction: this._laneNextAction(lane, 'lane.shutdown'),
      };
    }
    if (typeof this.clearLaneExecutor === 'function') this.clearLaneExecutor(lane.id);
    if (typeof this.revokeToolLeasesForLane === 'function') {
      this.revokeToolLeasesForLane(lane.id, { actor, reason: 'lane_deleted', persist: false });
    }
    this.laneRuntimeEnv?.delete(String(lane.id));
    if (typeof this.removeLaneWorktree === 'function') {
      try { await this.removeLaneWorktree(lane.id, { actor, approved: true, removeBranch: false }); } catch { /* best effort */ }
    }
    this.lanes = (this.lanes || []).filter((entry) => entry.id !== lane.id);
    const session = this.getSession(lane.sessionId);
    const thread = session?.orchestratorThread;
    if (thread && typeof thread === 'object') {
      thread.laneIds = safeArray(thread.laneIds)
        .filter((laneId) => laneId !== lane.id && this.getLane(laneId));
      if (thread.activeLaneId === lane.id) {
        thread.activeLaneId = thread.laneIds.at(-1) || null;
      }
      thread.updatedAt = nowIso();
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
    const submittable = new Set([STARTING_STATE, RUNNING_STATE]);
    if (!submittable.has(lane.state)) {
      throw {
        status: 409,
        message: `Lane cannot be submitted from state "${lane.state}".`,
        nextAction: this._laneNextAction(lane),
      };
    }
    if (summary) lane.summary = String(summary).slice(0, 4000);
    if (Array.isArray(changedFiles) && changedFiles.length) {
      const reportedChangedFiles = changedFiles.map((file) => String(file).slice(0, 400)).slice(0, 500);
      lane.reportedChangedFiles = reportedChangedFiles;
      lane.changedFiles = reportedChangedFiles;
    }
    if (handoff) lane.handoff = String(handoff).slice(0, 4000);
    lane.state = READY_FOR_AUDIT_STATE;
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
      summary: `Lane ${lane.title} submitted (ready for audit)`,
      status: 'passed',
      evidence: { summary: lane.summary || '', changedFiles: lane.changedFiles || [] },
    });
    this.persistState();
    // Guide the agent to the next step (audit.queue_one) so a successful submit
    // doesn't force a separate status round-trip.
    return { lane: clonePayload(lane), nextAction: this._laneNextAction(lane) };
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

    // Isolation is decided at CREATE time from whether the lane is a writer, and it
    // is never reconsidered. So two lanes spawned as read-only both legitimately
    // resolve to `direct`, and flipping them to a writable mode here (sandboxed, so
    // the permission gate correctly allows it) would leave two concurrent writers in
    // the same checkout — the collision auto-isolation exists to prevent. Refuse the
    // reclassification while the lane is still direct and another writer occupies it.
    const becomingWriter = before.permissionsProfile === 'read-only' && next.permissionsProfile !== 'read-only';
    if (becomingWriter && lane.worktreeMode !== 'isolated') {
      const otherDirectWriter = (this.lanes || []).find((other) => other.id !== lane.id
        && other.sessionId === lane.sessionId
        && other.worktreeMode !== 'isolated'
        && other.permissionsProfile !== 'read-only'
        && (typeof this.laneOccupiesSlot === 'function' ? this.laneOccupiesSlot(other) : isLiveLaneState(other.state)));
      if (otherDirectWriter) {
        throw {
          status: 409,
          message: `Cannot make this lane writable: it runs directly in the repo checkout and lane "${otherDirectWriter.title}" is already writing there. Spawn a new lane with worktreeMode "isolated" instead, or wait for that lane to finish.`,
          conflictingLaneId: otherDirectWriter.id,
        };
      }
    }

    lane.model = next.model;
    lane.permissionsProfile = next.permissionsProfile;
    lane.intelligenceProfile = next.intelligenceProfile;
    lane.targetUrl = next.targetUrl;
    lane.verificationCommand = next.verificationCommand;
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
      if (typeof this.revokeToolLeasesForLane === 'function') {
        this.revokeToolLeasesForLane(lane.id, {
          actor: context.actor || 'dashboard',
          reason: 'lane_stop_terminal_cleanup',
          persist: false,
        });
      }
      this.laneRuntimeEnv?.delete(String(lane.id));
      this.persistState();
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
      // Mirror markLaneStopped's durable orchestrator wakeup so this fallback stop
      // path (worker wasn't actively stopped) also notifies the owning orchestrator
      // on its next drain. Same dedupeKey as markLaneStopped so the two stop paths
      // never double-notify for the same lane.
      if (typeof this.enqueueAgentEvent === 'function') {
        this.enqueueAgentEvent({
          type: 'lane_stopped',
          targetRole: 'orchestrator',
          title: `Executor lane "${lane.title}" stopped`.slice(0, 160),
          body: lane.exitReason,
          severity: 'warning',
          actor: context.actor || 'dashboard',
          projectId: lane.projectId,
          sessionId: lane.sessionId,
          laneId: lane.id,
          dedupeKey: `lane-stopped:${lane.id}`,
        });
      }
      // NOTIFIER CHOKE POINT: lane reached a terminal state (stopped). A future
      // push/notifier subsystem hooks in here.
    }
    this.clearLaneExecutor(lane.id);
    if (typeof this.revokeToolLeasesForLane === 'function') {
      this.revokeToolLeasesForLane(lane.id, {
        actor: context.actor || 'dashboard',
        reason: 'lane_stopped',
        persist: false,
      });
    }
    this.laneRuntimeEnv?.delete(String(lane.id));
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
    // audit state below).
    if (![FAILED_STATE, STOPPED_STATE, FIX_REQUESTED_STATE, BLOCKED_STATE].includes(lane.state)) {
      throw { status: 409, message: `Lane state "${lane.state}" is not retryable.` };
    }
    // A retryable state does not guarantee a dead process: an executor can submit
    // (ready_for_audit) and be bounced with audit.request_fix (fix_requested) while
    // its child is still running. Retrying then only cleared registry mappings — the
    // old runtime stayed, the next start overwrote the adapter's entry for this lane
    // id, and the orphaned first child's exit callback later clobbered the new run's
    // state. Require the process to be gone first.
    if (typeof this.isLaneProcessLive === 'function' && this.isLaneProcessLive(lane.id)) {
      throw {
        status: 409,
        message: 'Lane still has a live executor process; retrying now would orphan it and let its exit corrupt the new run. Stop the lane first (lane.shutdown), then retry.',
        processLive: true,
        // Point at the CORRECTIVE tool. The computed envelope for fix_requested is
        // lane.retry — the call that just failed — so an agent following the
        // machine-readable next step would loop on the refusal.
        nextAction: this._laneNextAction(lane, 'lane.shutdown'),
      };
    }
    this.clearLaneExecutor(lane.id);
    if (typeof this.revokeToolLeasesForLane === 'function') {
      this.revokeToolLeasesForLane(lane.id, {
        actor: context.actor || 'dashboard',
        reason: 'lane_retry',
        persist: false,
      });
    }
    this.laneRuntimeEnv?.delete(String(lane.id));

    lane.state = QUEUED_STATE;
    lane.updatedAt = nowIso();
    lane.exitReason = null;
    lane.completedAt = null;
    lane.startedAt = null;
    lane.auditState = 'not_queued';
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


  writeLaneTerminalInput(laneLocator, {
    input = '',
    raw = false,
    actor = 'dashboard',
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }
    if (!isLiveLaneState(lane.state)) {
      throw { status: 409, message: 'Lane is not running.' };
    }
    const executor = this.getExecutorForLane(lane);
    if (typeof executor.writeTerminalInput !== 'function') {
      throw { status: 409, message: 'Lane executor does not support interactive terminal input.' };
    }
    const result = executor.writeTerminalInput(lane.id, input, { raw });
    lane.heartbeatAt = nowIso();
    lane.updatedAt = nowIso();
    if (!raw) {
      this.recordAudit({
        type: 'lane_terminal_input',
        actor: String(actor || 'dashboard').slice(0, 120),
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Terminal input sent to lane ${lane.title}`,
        status: 'passed',
        evidence: {
          laneId: lane.id,
          bytes: result.bytes,
          firstToken: String(input || '').trim().split(/\s+/)[0]?.slice(0, 80) || '',
        },
      });
    }
    return { lane: clonePayload(lane), result };
  },

  resizeLaneTerminal(laneLocator, { cols, rows, actor = 'dashboard' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }
    if (!isLiveLaneState(lane.state)) {
      throw { status: 409, message: 'Lane is not running.' };
    }
    const executor = this.getExecutorForLane(lane);
    if (typeof executor.resizeTerminal !== 'function') {
      throw { status: 409, message: 'Lane executor does not support terminal resize.' };
    }
    const result = executor.resizeTerminal(lane.id, { cols, rows });
    lane.updatedAt = nowIso();
    this.recordAudit({
      type: 'lane_terminal_resized',
      actor: String(actor || 'dashboard').slice(0, 120),
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Terminal resized for lane ${lane.title}`,
      status: 'passed',
      evidence: { laneId: lane.id, cols: result.cols, rows: result.rows },
    });
    return { lane: clonePayload(lane), result };
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
    const beatAt = nowIso();
    lane.heartbeatAt = beatAt;
    lane.lastActivityAt = beatAt; // a heartbeat is liveness → resets idle-shutdown
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

  // Read one lane artifact file by name for an agent (the auditor/orchestrator
  // fetching a screenshot or transcript it enumerated via listArtifactFiles).
  // Traversal-safe: the name must be a plain basename that resolves to a regular
  // file inside the lane's artifact dir. Text artifacts come back utf8; images/
  // pdf/video base64. Bounded so a huge artifact can't blow up the response.
  async readArtifactFile(laneLocator, name) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const rawName = String(name || '').trim();
    if (!rawName || rawName !== path.basename(rawName) || rawName === '.' || rawName === '..' || rawName.includes('/') || rawName.includes('\\')) {
      throw { status: 422, message: 'Invalid artifact name.' };
    }
    const laneDir = path.join(process.cwd(), 'artifacts', String(lane.sessionId), String(lane.id));
    const target = path.join(laneDir, rawName);
    let stat;
    try {
      const resolved = await fs.realpath(target);
      const laneReal = await fs.realpath(laneDir);
      if (resolved !== path.join(laneReal, rawName)) {
        throw { status: 422, message: 'Artifact resolves outside the lane directory.' };
      }
      stat = await fs.stat(resolved);
    } catch (error) {
      if (error && error.status) throw error;
      throw { status: 404, message: 'Artifact not found.' };
    }
    if (!stat.isFile()) throw { status: 404, message: 'Artifact not found.' };
    const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw { status: 413, message: `Artifact is ${stat.size} bytes; too large to fetch inline (limit ${MAX_ARTIFACT_BYTES}). Open it from the dashboard.` };
    }
    const TEXT_EXT = new Set(['.txt', '.json', '.log', '.md', '.csv', '.html', '.xml', '.yml', '.yaml', '.js', '.ts', '.css', '.diff', '.patch']);
    const encoding = TEXT_EXT.has(path.extname(rawName).toLowerCase()) ? 'utf8' : 'base64';
    const buffer = await fs.readFile(target);
    return {
      laneId: lane.id,
      sessionId: lane.sessionId,
      name: rawName,
      size: stat.size,
      encoding,
      content: buffer.toString(encoding),
    };
  },

  // Break-glass: stop EVERY live lane under one orchestrator container at once
  // (queued/starting/running). Best-effort per lane so one stubborn lane doesn't
  // block the rest. The orchestrator's fleet-wide "stop it all now" button, vs
  // lane.shutdown which stops a single lane.
  async emergencyStopContainer(orchestratorId, { actor = 'operator', reason = 'emergency stop' } = {}) {
    const orch = (this.orchestrators || []).find((o) => o.id === orchestratorId);
    if (!orch) throw { status: 404, message: 'Orchestrator not found.' };
    // laneOccupiesSlot, not isLiveLaneState: a lane that submitted is
    // ready_for_audit with its child STILL RUNNING. Filtering on state alone made
    // break-glass report "0 stopped" while leaving that child burning tokens and
    // editing files — the one guarantee this button exists to provide.
    const live = (this.lanes || []).filter((lane) => lane.sessionId === orchestratorId
      && (typeof this.laneOccupiesSlot === 'function' ? this.laneOccupiesSlot(lane) : isLiveLaneState(lane.state)));
    let stopped = 0;
    for (const lane of live) {
      try {
        await this.stopLane(lane.id, { actor, approved: true, reason });
        stopped += 1;
      } catch { /* best effort — keep stopping the rest */ }
    }
    this.recordAudit({
      type: 'fleet_emergency_stop',
      actor: String(actor || 'operator').slice(0, 120),
      projectId: orch.projectId,
      sessionId: orchestratorId,
      summary: `Emergency-stopped ${stopped}/${live.length} live lane(s) under orchestrator ${orch.title || orch.actor || orchestratorId}`,
      status: 'passed',
      evidence: { orchestratorId, requested: live.length, stopped },
    });
    return { stopped, laneCount: live.length };
  },


  // Remove/discard a lane's managed worktree. Safe by DEFAULT: refuses when the
  // worktree still holds uncommitted work unless the caller passes force:true.
  // This is the backend for the worktree/discard route and the
  // lane.worktree.discard MCP tool.
  async removeLaneWorktree(laneLocator, { actor = 'dashboard', approved, removeBranch = false, force = false } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    if (!lane.repoRoot || !lane.worktreePath) {
      throw { status: 422, message: 'Lane has no managed worktree to remove.' };
    }
    if (path.resolve(lane.worktreePath) === path.resolve(lane.repoRoot)) {
      throw { status: 422, message: 'Lane runs directly in the repo checkout; Orca will not remove the session repository.' };
    }
    // Discard is permitted from ready_for_audit/accepted, and BOTH can still have a
    // live child (submit does not wait for exit, and an audit can be accepted from
    // there). force:true would then delete the working directory out from under a
    // process that is still writing to it.
    if (typeof this.isLaneProcessLive === 'function' && this.isLaneProcessLive(lane.id)) {
      throw {
        status: 409,
        message: 'Lane still has a live executor process; discarding its worktree now would pull the working directory out from under it. Stop the lane first (lane.shutdown), then discard.',
        processLive: true,
        nextAction: this._laneNextAction(lane, 'lane.shutdown'),
      };
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
      force: Boolean(force),
    });
    if (!result.removed) {
      // Uncommitted work OR unmerged commits are client-actionable 409s (integrate
      // or force), not server errors — surface the reason + the corrective tool so
      // the agent knows what to do next.
      const recoverable = Boolean(result.uncommittedChanges || result.unmergedCommits);
      const status = recoverable ? 409 : 500;
      throw {
        status,
        message: result.reason || 'Could not remove worktree.',
        uncommittedChanges: result.uncommittedChanges || 0,
        unmergedCommits: result.unmergedCommits || 0,
        nextAction: recoverable ? this._laneNextAction(lane, 'lane.integrate') : null,
      };
    }
    lane.worktreePath = '';
    this.recordAudit({
      type: 'lane_worktree_removed',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Worktree ${force ? 'force-' : ''}removed for lane ${lane.title}`,
      evidence: { lane, branchRemoved: result.branchRemoved, force: Boolean(force) },
      status: 'passed',
    });
    this.persistState();
    return { removed: true, branchRemoved: result.branchRemoved, forced: Boolean(force) };
  },

  // Merge an ISOLATED, audit-accepted lane's branch back into the container's base
  // branch in the repo root. This is the lifecycle op that lets an orchestrator
  // return accepted work WITHOUT shelling out to git. Never auto-pushes unless
  // push:true. Reports merged / conflicts / nothing-to-merge. Reject direct/shared
  // lanes (they already ran in the repo checkout — there is nothing to merge back).
  async integrateLane(laneLocator, { actor = 'dashboard', push = false } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    if (lane.worktreeMode !== 'isolated') {
      throw {
        status: 422,
        message: `Only isolated lanes can be integrated. This lane runs directly in the repo checkout (worktree mode "${lane.worktreeMode || 'direct'}"), so its work is already there and there is nothing to merge back.`,
      };
    }
    // Terminal + audit-accepted only: never merge unreviewed or in-flight work.
    if (lane.state !== ACCEPTED_STATE || lane.auditState !== 'accepted') {
      throw {
        status: 409,
        message: 'Lane must be audit-accepted before it can be integrated. Accept the audit (audit.accept) first.',
      };
    }
    if (!lane.repoRoot || !lane.branch) {
      throw { status: 422, message: 'Lane has no repoRoot/branch to integrate.' };
    }
    // The lane state can read terminal while the child is still alive: lane.submit
    // sets ready_for_audit without waiting for exit, and an audit can be accepted
    // from there. Merging then races an executor that is still editing the worktree.
    // Process exit is the authoritative completion signal, so require it here.
    if (typeof this.isLaneProcessLive === 'function' && this.isLaneProcessLive(lane.id)) {
      throw {
        status: 409,
        message: 'Lane still has a live executor process; integrating now would merge a worktree that is still being written. Wait for the executor to exit (or stop the lane) before integrating.',
        processLive: true,
        branch: lane.branch,
      };
    }
    // Refuse to integrate a DIRTY worktree. Executors are told to submit and leave
    // the worktree, not to commit — so uncommitted edits are the ordinary case, and
    // integration measures commits only (`base..laneBranch`). An executor that edited
    // without committing therefore looked like "nothing to merge": integratedAt was
    // set, none of the work reached the base checkout, and retention then pruned the
    // lane record while worktree removal refused the dirty tree — stranding the only
    // copy under .orca/workspaces with nothing pointing at it.
    // Fail CLOSED: "could not inspect" must not read as "clean", or a broken .git
    // turns a dirty worktree back into the silent-loss case this guard exists for.
    const cleanliness = worktreeCleanliness(lane.worktreePath);
    if (!cleanliness.ok) {
      throw {
        status: 409,
        message: `Could not determine whether the lane worktree has uncommitted work (${cleanliness.error}); refusing to integrate rather than risk discarding it. Inspect ${lane.worktreePath} by hand.`,
        dirty: true,
        worktreePath: lane.worktreePath,
        branch: lane.branch,
      };
    }
    const dirtyFiles = cleanliness.files;
    if (dirtyFiles.length) {
      throw {
        status: 409,
        message: `Lane worktree has ${dirtyFiles.length} uncommitted change(s); integrating now would silently drop them. Commit them on ${lane.branch} (in ${lane.worktreePath}) and integrate again.`,
        dirty: true,
        changedFiles: dirtyFiles.slice(0, 50),
        worktreePath: lane.worktreePath,
        branch: lane.branch,
      };
    }
    const result = mergeLaneBranch({ repoRoot: lane.repoRoot, branch: lane.branch, push: Boolean(push) });
    if (result.merged) {
      lane.integratedAt = nowIso();
      lane.updatedAt = nowIso();
      this.recordAudit({
        type: 'lane_integrated',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Integrated lane ${lane.title} (${result.branch} -> ${result.baseBranch})`,
        evidence: { ...result, laneId: lane.id },
        status: 'passed',
      });
      this.persistState();
      return { integrated: true, ...result };
    }
    if (result.nothingToMerge) {
      // Idempotent success-ish: mark integrated so retention can reap the worktree.
      lane.integratedAt = nowIso();
      lane.updatedAt = nowIso();
      this.persistState();
      return { integrated: false, nothingToMerge: true, baseBranch: result.baseBranch, branch: result.branch };
    }
    if (result.conflicts) {
      throw {
        status: 409,
        message: result.reason || 'Integration hit merge conflicts.',
        conflicts: true,
        baseBranch: result.baseBranch,
        branch: result.branch,
        // Conflicts need a fresh fix pass on the lane before it can be integrated;
        // point the agent at requesting that fix rather than retrying the merge.
        nextAction: this._laneNextAction(lane, 'audit.request_fix'),
      };
    }
    throw { status: 422, message: result.reason || 'Could not integrate lane.' };
  },
};
