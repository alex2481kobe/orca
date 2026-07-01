// Lane terminal-state handlers (completed/failed/stopped) + artifact transcript
// writing — prototype mixin for OrcaRegistry. Extracted from registry.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { LANE_STATES } from './worker-contract.js';
import { nowIso, clonePayload } from './registry-utils.js';
import { changedFilesIn } from './worktree-manager.js';

const {
  NEEDS_CRITIQUE: NEEDS_CRITIQUE_STATE,
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
    const needsCritique = this.critiqueRequiredForLane(lane) && !this.critiqueSatisfiedForLane(lane);
    lane.state = needsCritique ? NEEDS_CRITIQUE_STATE : DONE_STATE;
    lane.updatedAt = now;
    // Auto-queue the audit when a finished executor lane requires one — the
    // scheduler's dispatchPendingAudits() then runs it (orchestrator or a spawned
    // auditor). Guarded so auditor/orchestrator lanes never audit themselves.
    if (this.autoAuditEnabled
      && !needsCritique
      && typeof this.isAuditableExecutorLane === 'function'
      && this.isAuditableExecutorLane(lane)
      && typeof this.auditRequiredForLane === 'function'
      && this.auditRequiredForLane(lane)
      && !['queued', 'auditing', 'accepted'].includes(String(lane.auditState || ''))) {
      lane.auditState = 'queued';
    }
    if (!needsCritique
      && typeof this.auditRequiredForLane === 'function'
      && !this.auditRequiredForLane(lane)
      && typeof this.markTaskAcceptedFromLane === 'function') {
      const syncedTask = this.markTaskAcceptedFromLane(lane.id);
      if (syncedTask && typeof this.evaluateBacklogCompletion === 'function') {
        this.evaluateBacklogCompletion(lane.sessionId);
      }
    }
    lane.completedAt = now;
    const executorLabel = String(lane.executorType || 'mock');
    lane.exitReason = needsCritique
      ? 'Execution completed; self-verification required before audit.'
      : `${executorLabel} execution completed`;
    this.appendLaneLog(lane, lane.exitReason, { persist: false });
    this.appendLaneAgentEvent(lane, {
      type: needsCritique ? 'agent.needs_critique' : 'agent.done',
      source: lane.executorType,
      title: needsCritique ? 'Needs self-check' : 'Agent completed',
      content: lane.exitReason,
    });
    this.recordAudit({
      type: needsCritique ? 'lane_needs_critique' : 'lane_completed',
      // Attribute completion to the lane's actual executor, not always the mock.
      actor: `${executorLabel}-worker`,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: needsCritique ? `Lane ${lane.title} needs self-verification` : `Lane ${lane.title} completed`,
      evidence: { lane },
      status: needsCritique ? 'pending' : 'passed',
      followUpQueued: needsCritique,
    });
    this.notifyLaneTerminal(
      lane,
      needsCritique ? 'warning' : 'success',
      needsCritique ? 'Lane needs self-check' : 'Lane completed',
      needsCritique
        ? `${lane.title} needs self-verification before audit.`
        : `${lane.title} finished successfully.`,
    );
    this._trackAsync(this.writeLaneArtifacts(lane, lane.state).catch(() => {}));
    this.clearLaneExecutor(lane.id);
    if (typeof this.revokeToolLeasesForLane === 'function') {
      this.revokeToolLeasesForLane(lane.id, {
        actor: `${executorLabel}-worker`,
        reason: needsCritique ? 'lane_needs_critique' : 'lane_completed',
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
    this.notifyLaneTerminal(
      lane,
      'error',
      'Lane failed',
      `${lane.title} failed: ${lane.exitReason}`,
    );
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
    lane.state = STOPPED_STATE;
    lane.updatedAt = now;
    lane.completedAt = now;
    lane.exitReason = reason;
    if (typeof this.markTaskFailedFromLane === 'function') {
      this.markTaskFailedFromLane(lane.id, reason);
    }
    this.appendLaneLog(lane, reason, { persist: false });
    this.appendLaneAgentEvent(lane, {
      type: 'agent.stopped',
      source: lane.executorType,
      title: 'Agent stopped',
      content: reason,
    });
    this.notifyOrchestratorManualLaneStop(lane, actor, reason);
    this.recordAudit({
      type: 'lane_stopped',
      actor,
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
      `${lane.title} stopped: ${reason}`,
    );
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
      branch: lane.branch || null,
      repoRoot: lane.repoRoot || null,
      worktreePath: lane.worktreePath || lane.workdir || null,
      verificationCommand: lane.verificationCommand || null,
      expectedArtifacts: lane.expectedArtifacts || [],
      targetUrl: lane.targetUrl || null,
      mcpConfigPath: lane.mcpConfigPath || null,
      mcpTools: lane.mcpTools || [],
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
