// Lane terminal-state handlers (completed/failed/stopped) + artifact transcript
// writing — prototype mixin for OrcaRegistry.

import fs from 'node:fs/promises';
import path from 'node:path';
import { LANE_STATES } from './worker-contract.js';
import { nowIso, clonePayload } from './registry-utils.js';
import { changedFilesIn } from './worktree-manager.js';

const {
  READY_FOR_AUDIT: READY_FOR_AUDIT_STATE,
  STOPPED: STOPPED_STATE,
  DONE: DONE_STATE,
  FAILED: FAILED_STATE,
  ACCEPTED: ACCEPTED_STATE,
} = LANE_STATES;

// A lane that already reached a terminal state must not be re-terminalized — a
// stop POST racing the executor's exit callback would otherwise double-fire
// notifications/audit events and clobber the recorded outcome.
const TERMINAL_LANE_STATES = new Set([DONE_STATE, FAILED_STATE, STOPPED_STATE, ACCEPTED_STATE]);

export const laneTerminalMethods = {
  markLaneCompleted(lane) {
    if (!lane || TERMINAL_LANE_STATES.has(lane.state)) return;
    const now = nowIso();
    lane.state = DONE_STATE;
    lane.updatedAt = now;
    // Auto-queue the audit when a finished executor lane requires one — the
    // scheduler's dispatchPendingAudits() then runs it (orchestrator or a spawned
    // auditor). Guarded so auditor/orchestrator lanes never audit themselves.
    if (this.autoAuditEnabled
      && typeof this.isAuditableExecutorLane === 'function'
      && this.isAuditableExecutorLane(lane)
      && typeof this.auditRequiredForLane === 'function'
      && this.auditRequiredForLane(lane)
      && !['queued', 'auditing', 'accepted'].includes(String(lane.auditState || ''))) {
      lane.auditState = 'queued';
      // Re-arm the orchestrator audit notification so a fresh completion (e.g.
      // after a fix cycle) notifies exactly once. See dispatchPendingAudits().
      lane.auditNudgedAt = null;
    }
    lane.completedAt = now;
    const executorLabel = String(lane.executorType || 'mock');
    lane.exitReason = `${executorLabel} execution completed`;
    this.appendLaneLog(lane, lane.exitReason, { persist: false });
    this.appendLaneAgentEvent(lane, {
      type: 'agent.done',
      source: lane.executorType,
      title: 'Agent completed',
      content: lane.exitReason,
    });
    this.recordAudit({
      type: 'lane_completed',
      // Attribute completion to the lane's actual executor, not always the mock.
      actor: `${executorLabel}-worker`,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Lane ${lane.title} completed`,
      evidence: { lane },
      status: 'passed',
      followUpQueued: false,
    });
    // NOTIFIER CHOKE POINT: lane reached a terminal state (completed). A future
    // push/notifier subsystem hooks in here.
    this._trackAsync(this.writeLaneArtifacts(lane, lane.state).catch(() => {}));
    this.clearLaneExecutor(lane.id);
    if (typeof this.revokeToolLeasesForLane === 'function') {
      this.revokeToolLeasesForLane(lane.id, {
        actor: `${executorLabel}-worker`,
        reason: 'lane_completed',
        persist: false,
      });
    }
    this.laneRuntimeEnv.delete(String(lane.id));
    this.persistState();
  },

  markLaneFailed(lane, reason, actor = 'scheduler', persist = true) {
    if (!lane || TERMINAL_LANE_STATES.has(lane.state)) return;
    const now = nowIso();
    lane.state = FAILED_STATE;
    lane.updatedAt = now;
    lane.completedAt = now;
    lane.exitReason = reason || 'Execution failed';
    if (typeof this.markTaskFailedFromLane === 'function') {
      this.markTaskFailedFromLane(lane.id, lane.exitReason);
    }
    this.appendLaneLog(lane, lane.exitReason, { persist: false });
    this.appendLaneAgentEvent(lane, {
      type: 'agent.failed',
      source: lane.executorType,
      title: 'Agent failed',
      content: lane.exitReason,
    });
    this.recordAudit({
      type: 'lane_failed',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Lane ${lane.title} failed`,
      evidence: { lane },
      status: 'failed',
    });
    // Push a DURABLE, drainable wakeup to the owning orchestrator (lane.sessionId
    // IS the orchestrator container id in v2) so a dependent orchestrator learns
    // of the failure on its next drainAgentEvents — not only by re-polling the
    // lane. dedupeKey collapses re-fires; the terminal-state guard above already
    // prevents re-entry.
    if (typeof this.enqueueAgentEvent === 'function') {
      this.enqueueAgentEvent({
        type: 'lane_failed',
        targetRole: 'orchestrator',
        title: `Executor lane "${lane.title}" failed`.slice(0, 160),
        body: lane.exitReason || reason || 'Execution failed',
        severity: 'error',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        dedupeKey: `lane-failed:${lane.id}`,
      });
    }
    // NOTIFIER CHOKE POINT: lane reached a terminal state (failed). A future
    // push/notifier subsystem hooks in here.
    this._trackAsync(this.writeLaneArtifacts(lane, 'failed').catch(() => {}));
    this.clearLaneExecutor(lane.id);
    if (typeof this.revokeToolLeasesForLane === 'function') {
      this.revokeToolLeasesForLane(lane.id, { actor, reason: 'lane_failed', persist: false });
    }
    this.laneRuntimeEnv.delete(String(lane.id));
    if (persist) this.persistState();
  },

  markLaneStopped(lane, context = {}) {
    if (!lane || TERMINAL_LANE_STATES.has(lane.state)) return;
    const now = nowIso();
    const actor = context.actor || 'scheduler';
    const reason = context.reason || `Stopped by ${actor}`;
    // A lane that already SUBMITTED has handed off reviewable work, and stopping
    // is about the PROCESS, not the work (see the submit-is-not-exit invariant).
    // Downgrading ready_for_audit -> stopped stranded that work: the orchestrator
    // could no longer accept it or request fixes, and the submission was the only
    // record of it. Kill the process, keep the submission auditable.
    const preserveSubmission = lane.state === READY_FOR_AUDIT_STATE;
    if (!preserveSubmission) {
      lane.state = STOPPED_STATE;
      lane.completedAt = now;
      if (typeof this.markTaskFailedFromLane === 'function') {
        this.markTaskFailedFromLane(lane.id, reason);
      }
    }
    lane.updatedAt = now;
    lane.exitReason = reason;
    this.appendLaneLog(lane, reason, { persist: false });
    this.appendLaneAgentEvent(lane, {
      type: 'agent.stopped',
      source: lane.executorType,
      title: 'Agent stopped',
      content: preserveSubmission ? `${reason} (submitted work is still awaiting audit)` : reason,
    });
    this.recordAudit({
      type: 'lane_stopped',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: preserveSubmission
        ? `Lane ${lane.title} process stopped; submitted work still awaiting audit`
        : `Lane ${lane.title} stopped`,
      evidence: { lane },
      status: 'passed',
    });
    // Push a DURABLE, drainable wakeup to the owning orchestrator (lane.sessionId
    // IS the orchestrator container id in v2) so a dependent orchestrator learns
    // of the stop on its next drainAgentEvents — not only by re-polling the lane.
    // dedupeKey collapses re-fires; the terminal-state guard above already
    // prevents re-entry.
    if (typeof this.enqueueAgentEvent === 'function') {
      this.enqueueAgentEvent({
        type: 'lane_stopped',
        targetRole: 'orchestrator',
        title: `Executor lane "${lane.title}" stopped`.slice(0, 160),
        body: preserveSubmission
          ? `${reason} — its process is gone, but it had already submitted: the work is still awaiting your audit (audit.accept / audit.request_fix).`
          : reason,
        severity: 'warning',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        dedupeKey: `lane-stopped:${lane.id}`,
      });
    }
    // NOTIFIER CHOKE POINT: lane reached a terminal state (stopped). A future
    // push/notifier subsystem hooks in here.
    this._trackAsync(this.writeLaneArtifacts(lane, 'stopped').catch(() => {}));
    this.clearLaneExecutor(lane.id);
    if (typeof this.revokeToolLeasesForLane === 'function') {
      this.revokeToolLeasesForLane(lane.id, { actor, reason: 'lane_stopped', persist: false });
    }
    this.laneRuntimeEnv.delete(String(lane.id));
    this.persistState();
  },

  async writeLaneArtifacts(lane, status = DONE_STATE) {
    const laneArtifactDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
    await fs.mkdir(laneArtifactDir, { recursive: true });
    // Capture changed-files via git status when the lane lives in a git worktree.
    let changedFiles = Array.isArray(lane.changedFiles) ? lane.changedFiles : [];
    if (lane.worktreePath || lane.workdir) {
      const result = changedFilesIn(lane.worktreePath || lane.workdir);
      if (result.length) changedFiles = result;
    }
    lane.changedFiles = changedFiles;

    const evidenceSummary = lane.lastEvidence
      ? {
          status: lane.lastEvidence.status || null,
          capturedAt: lane.lastEvidenceCaptureAt || null,
          produced: Array.isArray(lane.lastEvidence.produced) ? lane.lastEvidence.produced : [],
          requested: Array.isArray(lane.lastEvidence.requested) ? lane.lastEvidence.requested : [],
          error: lane.lastEvidence.error || null,
        }
      : null;

    await fs.writeFile(
      path.join(laneArtifactDir, 'outcome.txt'),
      `Lane ${lane.id} completed at ${lane.completedAt}
Title: ${lane.title || ''}
Task: ${lane.taskDescription || 'No task description'}
Task prompt: ${lane.taskPrompt || ''}
Status: ${status}
Exit reason: ${lane.exitReason || ''}
Result: ${lane.resultText || ''}
Executor: ${lane.executorType}
Model: ${lane.model || ''}
Permissions profile: ${lane.permissionsProfile || ''}
Intelligence profile: ${lane.intelligenceProfile || ''}
Presentation mode: ${lane.presentationMode || 'chat'}
Branch: ${lane.branch || ''}
Workdir: ${lane.workdir || ''}
MCP config: ${lane.mcpConfigPath || ''}
Verification command: ${lane.verificationCommand || ''}
Process PID: ${lane.processMeta?.pid ?? ''}
Exit code: ${lane.processMeta?.exitCode ?? ''}
Signal: ${lane.processMeta?.signal ?? ''}
Stop requested by: ${lane.processMeta?.stopRequestedBy ?? ''}
Stop result: ${lane.processMeta?.stopResult ?? ''}
Changed files: ${changedFiles.length}
`,
    );
    await fs.writeFile(path.join(laneArtifactDir, 'transcript.json'), JSON.stringify({
      laneId: lane.id,
      title: lane.title,
      logs: lane.logs,
      agentEvents: lane.agentEvents || [],
      terminalArtifacts: ['terminal.log', 'stdout.log', 'stderr.log'],
      completedAt: lane.completedAt,
      status,
      taskDescription: lane.taskDescription,
      taskPrompt: lane.taskPrompt || null,
      resultText: lane.resultText || null,
      resultAt: lane.resultAt || null,
      model: lane.model || null,
      permissionsProfile: lane.permissionsProfile || null,
      intelligenceProfile: lane.intelligenceProfile || null,
      presentationMode: lane.presentationMode || 'chat',
      branch: lane.branch || null,
      repoRoot: lane.repoRoot || null,
      worktreePath: lane.worktreePath || lane.workdir || null,
      verificationCommand: lane.verificationCommand || null,
      expectedArtifacts: lane.expectedArtifacts || [],
      targetUrl: lane.targetUrl || null,
      mcpConfigPath: lane.mcpConfigPath || null,
      command: lane.command || null,
      commandArgs: lane.commandArgs || null,
      executorBinary: lane.executorBinary || null,
      workdir: lane.workdir || null,
      sessionId: lane.sessionId,
      projectId: lane.projectId,
      processMeta: lane.processMeta || null,
      changedFiles,
      evidence: evidenceSummary,
      exitReason: lane.exitReason || null,
    }, null, 2));
    lane.artifactPath = `/artifacts/${lane.sessionId}/${lane.id}`;
    return clonePayload({
      files: ['outcome.txt', 'transcript.json'],
      artifactPath: lane.artifactPath,
      changedFiles,
      evidence: evidenceSummary,
    });
  },
};
