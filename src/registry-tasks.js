// Persistent task-backlog subsystem as a prototype mixin for OrcaRegistry.
//
// A Task is a durable, enumerable unit of work in a session backlog. The
// orchestrator (a headless CLI/desktop chat over MCP) ingests a list of tasks
// and — when the session's spawnPolicy is 'auto' — the scheduler fans them out
// across executor lanes up to capacity, refilling as lanes finish, running each
// through the existing executor -> critique -> audit -> accept flow. A task is
// linked to exactly one live lane at a time and auto-syncs its state from that
// lane's terminal transitions (accept/fail/stop).
//
// Anti-collision is the existing per-lane git-worktree isolation (createLane):
// each spawned task gets its own working tree. Tasks are top-level state (like
// lanes) keyed by sessionId, persisted in .orca/state.json.

import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload, safeArray } from './registry-utils.js';
import { normalizeApprovedCapacity, normalizeSpawnPolicy } from './registry-lane-config.js';
import { LANE_STATES } from './worker-contract.js';

const {
  QUEUED: QUEUED_STATE,
  STARTING: STARTING_STATE,
  RUNNING: RUNNING_STATE,
} = LANE_STATES;

export const TASK_STATES = ['pending', 'assigned', 'in_lane', 'accepted', 'failed', 'blocked'];
const TERMINAL_TASK_STATES = new Set(['accepted', 'failed']);

// Legal transitions. 'pending' is reachable from assigned/in_lane (requeue) and
// from blocked (unblock). Terminal states are absorbing except via delete.
const TASK_TRANSITIONS = {
  pending: ['assigned', 'blocked'],
  assigned: ['in_lane', 'pending', 'blocked'],
  in_lane: ['accepted', 'failed', 'pending', 'blocked'],
  accepted: [],
  failed: ['pending'],
  blocked: ['pending'],
};

function sanitizeStr(value, max) {
  return String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

export const taskMethods = {
  getTask(locator) {
    const id = String(locator || '');
    return (this.tasks || []).find((task) => task.id === id) || null;
  },

  // Sort spawnable/listed tasks: priority DESC, then insertion order (seq ASC).
  _sortTasks(list) {
    return [...list].sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
  },

  addTask(sessionLocator, {
    title,
    description = '',
    taskPrompt = '',
    executorType = null,
    model = null,
    targetUrl = null,
    verificationCommand = null,
    expectedArtifacts = [],
    priority = 0,
    maxAttempts = 1,
    actor = 'orchestrator',
  } = {}, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const cleanTitle = sanitizeStr(title, 200);
    if (!cleanTitle) throw { status: 422, message: 'Task title is required.' };

    const seq = (this.tasks || [])
      .filter((task) => task.sessionId === session.id)
      .reduce((max, task) => Math.max(max, task.seq || 0), 0) + 1;
    const now = nowIso();
    const task = {
      id: randomUUID(),
      projectId: session.projectId,
      sessionId: session.id,
      seq,
      priority: Number.isFinite(Number(priority)) ? Math.trunc(Number(priority)) : 0,
      title: cleanTitle,
      description: sanitizeStr(description, 4000),
      taskPrompt: sanitizeStr(taskPrompt, 8000),
      executorType: executorType ? sanitizeStr(executorType, 40).toLowerCase() : null,
      model: model ? sanitizeStr(model, 120) : null,
      targetUrl: targetUrl ? sanitizeStr(targetUrl, 500) : null,
      verificationCommand: verificationCommand ? sanitizeStr(verificationCommand, 1000) : null,
      expectedArtifacts: safeArray(expectedArtifacts).map((v) => sanitizeStr(v, 200)).filter(Boolean).slice(0, 32),
      state: 'pending',
      laneId: null,
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(10, Number.parseInt(maxAttempts, 10) || 1)),
      blockedReason: null,
      source: sanitizeStr(context.actor || actor, 80) || 'orchestrator',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      terminatedAt: null,
    };
    this.tasks.push(task);
    // A new task re-arms the batch-completion signal for this session.
    if (session.backlogCompletedAt) {
      session.backlogCompletedAt = null;
    }
    this.recordAudit({
      type: 'task_added',
      actor: task.source,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Task "${task.title}" added to backlog`,
      status: 'passed',
      evidence: { taskId: task.id, priority: task.priority },
    });
    this.persistState();
    return clonePayload(task);
  },

  bulkAddTasks(sessionLocator, { tasks = [], actor = 'orchestrator' } = {}, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const list = safeArray(tasks).slice(0, 200);
    if (!list.length) throw { status: 422, message: 'Provide a non-empty tasks array.' };
    const added = [];
    const errors = [];
    for (const entry of list) {
      try {
        added.push(this.addTask(session.id, { ...entry, actor: entry.actor || actor }, context));
      } catch (error) {
        errors.push({ title: entry?.title || null, error: error.message || 'Could not add task.' });
      }
    }
    return { added: added.length, taskIds: added.map((task) => task.id), tasks: added, errors };
  },

  listTasks(sessionLocator, { state = null } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const wanted = state ? String(state).trim().toLowerCase() : null;
    const filtered = (this.tasks || [])
      .filter((task) => task.sessionId === session.id)
      .filter((task) => !wanted || task.state === wanted);
    return clonePayload(this._sortTasks(filtered));
  },

  updateTask(taskLocator, patch = {}, context = {}) {
    const task = this.getTask(taskLocator);
    if (!task) throw { status: 404, message: 'Task not found.' };
    if (patch.title !== undefined) {
      const cleanTitle = sanitizeStr(patch.title, 200);
      if (!cleanTitle) throw { status: 422, message: 'Task title cannot be empty.' };
      task.title = cleanTitle;
    }
    if (patch.description !== undefined) task.description = sanitizeStr(patch.description, 4000);
    if (patch.taskPrompt !== undefined) task.taskPrompt = sanitizeStr(patch.taskPrompt, 8000);
    if (patch.priority !== undefined) task.priority = Number.isFinite(Number(patch.priority)) ? Math.trunc(Number(patch.priority)) : task.priority;
    if (patch.maxAttempts !== undefined) task.maxAttempts = Math.max(1, Math.min(10, Number.parseInt(patch.maxAttempts, 10) || task.maxAttempts));
    if (patch.executorType !== undefined) task.executorType = patch.executorType ? sanitizeStr(patch.executorType, 40).toLowerCase() : null;
    if (patch.model !== undefined) task.model = patch.model ? sanitizeStr(patch.model, 120) : null;
    if (patch.targetUrl !== undefined) task.targetUrl = patch.targetUrl ? sanitizeStr(patch.targetUrl, 500) : null;
    if (patch.verificationCommand !== undefined) task.verificationCommand = patch.verificationCommand ? sanitizeStr(patch.verificationCommand, 1000) : null;
    if (patch.expectedArtifacts !== undefined) {
      task.expectedArtifacts = safeArray(patch.expectedArtifacts).map((v) => sanitizeStr(v, 200)).filter(Boolean).slice(0, 32);
    }
    // State change (block / unblock) goes through the validated transition path.
    if (patch.state !== undefined) {
      return this.updateTaskState(task.id, patch.state, { reason: patch.blockedReason || patch.reason, actor: context.actor });
    }
    task.updatedAt = nowIso();
    this.persistState();
    return clonePayload(task);
  },

  updateTaskState(taskLocator, nextState, { reason = '', actor = 'orchestrator' } = {}) {
    const task = this.getTask(taskLocator);
    if (!task) throw { status: 404, message: 'Task not found.' };
    const next = String(nextState || '').trim().toLowerCase();
    if (!TASK_STATES.includes(next)) {
      throw { status: 422, message: `Task state must be one of: ${TASK_STATES.join(', ')}.` };
    }
    if (next === task.state) return clonePayload(task);
    const legal = TASK_TRANSITIONS[task.state] || [];
    if (!legal.includes(next)) {
      throw { status: 422, message: `Illegal task transition ${task.state} -> ${next}.` };
    }
    const now = nowIso();
    task.state = next;
    task.updatedAt = now;
    if (next === 'blocked') task.blockedReason = sanitizeStr(reason, 2000) || 'Blocked';
    if (next === 'pending') {
      task.blockedReason = null;
      task.laneId = null;
      // Returning a task to pending re-opens the backlog: re-arm the signal.
      const session = this.getSession(task.sessionId);
      if (session && session.backlogCompletedAt) session.backlogCompletedAt = null;
    }
    if (TERMINAL_TASK_STATES.has(next)) task.terminatedAt = now;
    this.recordAudit({
      type: 'task_state_changed',
      actor: sanitizeStr(actor, 80) || 'orchestrator',
      projectId: task.projectId,
      sessionId: task.sessionId,
      summary: `Task "${task.title}" -> ${next}`,
      status: next === 'failed' ? 'failed' : 'passed',
      evidence: { taskId: task.id, state: next, reason: reason || null },
    });
    this.persistState();
    return clonePayload(task);
  },

  deleteTask(taskLocator, { actor = 'orchestrator' } = {}) {
    const task = this.getTask(taskLocator);
    if (!task) throw { status: 404, message: 'Task not found.' };
    if (task.state === 'in_lane' || task.state === 'assigned') {
      throw { status: 422, message: 'Cannot delete a task while it is being dispatched or running; stop or accept it first.' };
    }
    this.tasks = (this.tasks || []).filter((entry) => entry.id !== task.id);
    this.recordAudit({
      type: 'task_deleted',
      actor: sanitizeStr(actor, 80) || 'orchestrator',
      projectId: task.projectId,
      sessionId: task.sessionId,
      summary: `Task "${task.title}" deleted`,
      status: 'passed',
      evidence: { taskId: task.id },
    });
    this.persistState();
    return { deleted: true, id: task.id };
  },

  // --- auto-spawn engine support -------------------------------------------

  listSpawnableTasks(sessionId) {
    return this._sortTasks((this.tasks || []).filter((task) =>
      task.sessionId === sessionId && task.state === 'pending'));
  },

  // Reserve the next pending task for a spawn this tick (pending -> assigned).
  claimNextPendingTask(sessionId) {
    const next = this.listSpawnableTasks(sessionId)[0];
    if (!next) return null;
    next.state = 'assigned';
    next.updatedAt = nowIso();
    return next;
  },

  linkTaskToLane(taskId, laneId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    task.laneId = String(laneId);
    task.state = 'in_lane';
    task.attempts = (task.attempts || 0) + 1;
    if (!task.startedAt) task.startedAt = nowIso();
    task.updatedAt = nowIso();
    return task;
  },

  _taskForLane(laneId) {
    const id = String(laneId || '');
    return (this.tasks || []).find((task) => task.laneId === id) || null;
  },

  markTaskAcceptedFromLane(laneId) {
    const task = this._taskForLane(laneId);
    if (!task || task.state !== 'in_lane') return null;
    const now = nowIso();
    task.state = 'accepted';
    task.terminatedAt = now;
    task.updatedAt = now;
    this.recordAudit({
      type: 'task_accepted',
      actor: 'auditor',
      projectId: task.projectId,
      sessionId: task.sessionId,
      laneId: task.laneId,
      summary: `Task "${task.title}" accepted`,
      status: 'passed',
      evidence: { taskId: task.id, laneId: task.laneId },
    });
    return task;
  },

  // A linked lane failed/stopped: requeue the task if it still has attempts
  // budget, otherwise mark it failed. Clears the lane link on requeue so the
  // task re-enters the auto-spawn pool next tick.
  markTaskFailedFromLane(laneId, reason = '') {
    const task = this._taskForLane(laneId);
    if (!task || task.state !== 'in_lane') return null;
    const now = nowIso();
    const canRetry = (task.attempts || 0) < (task.maxAttempts || 1);
    if (canRetry) {
      task.state = 'pending';
      task.laneId = null;
      task.updatedAt = now;
      // Re-arm the batch-completion signal: this session is no longer "all done".
      const session = this.getSession(task.sessionId);
      if (session && session.backlogCompletedAt) session.backlogCompletedAt = null;
      this.recordAudit({
        type: 'task_requeued',
        actor: 'scheduler',
        projectId: task.projectId,
        sessionId: task.sessionId,
        summary: `Task "${task.title}" requeued after lane failure (attempt ${task.attempts}/${task.maxAttempts})`,
        status: 'pending',
        evidence: { taskId: task.id, reason: sanitizeStr(reason, 500) || null },
      });
    } else {
      task.state = 'failed';
      task.terminatedAt = now;
      task.updatedAt = now;
      this.recordAudit({
        type: 'task_failed',
        actor: 'scheduler',
        projectId: task.projectId,
        sessionId: task.sessionId,
        laneId,
        summary: `Task "${task.title}" failed`,
        status: 'failed',
        evidence: { taskId: task.id, reason: sanitizeStr(reason, 500) || null },
      });
    }
    return task;
  },

  // Scheduler hook (mirrors dispatchPendingAudits): for sessions with
  // spawnPolicy 'auto', create executor lanes from pending tasks up to
  // approvedCapacity (a TARGET — in-flight tasks count against it), refilling as
  // tasks reach a terminal state. Idempotent and bounded per tick.
  async dispatchPendingTasks() {
    for (const session of this.sessions) {
      if (session.state === 'archived') continue;
      if (normalizeSpawnPolicy(session.spawnPolicy) !== 'auto') continue;
      const pending = this.listSpawnableTasks(session.id);
      // Idle fast-path: no pending tasks => no scans, no persist, no SSE-revision
      // churn. Batch completion is fired by the accept path (acceptLaneAudit), so
      // we don't need to re-evaluate it here every tick.
      if (!pending.length) continue;

      const approvedCapacity = normalizeApprovedCapacity(
        session.approvedCapacity, normalizeApprovedCapacity(session.laneConcurrencyLimit));
      // Measure capacity against ACTUAL live lanes for the session (any owner —
      // executor/auditor/orchestrator lanes all consume the scheduler's slots), so
      // we never pre-create worktrees beyond capacity. Lanes past execution
      // (done/awaiting-audit/accepted) free a slot => refill-on-finish.
      const activeLanes = (this.lanes || []).filter((lane) =>
        lane.sessionId === session.id
        && [QUEUED_STATE, STARTING_STATE, RUNNING_STATE].includes(lane.state)).length;
      let slots = Math.max(0, approvedCapacity - activeLanes);
      let changed = false;

      for (const task of pending) {
        if (slots <= 0) break;
        if (task.state !== 'pending') continue; // already claimed earlier in this list
        task.state = 'assigned';
        task.updatedAt = nowIso();
        slots -= 1;
        changed = true;
        try {
          const lane = await this.createLane(session.id, {
            title: task.title.slice(0, 200),
            taskDescription: task.description || task.title,
            taskPrompt: task.taskPrompt || '',
            executorType: task.executorType || session.leader || 'mock',
            model: task.model || session.defaultModel || '',
            targetUrl: task.targetUrl || '',
            verificationCommand: task.verificationCommand || '',
            expectedArtifacts: task.expectedArtifacts || [],
            owner: 'executor',
          }, { actor: 'scheduler', approved: true });
          this.linkTaskToLane(task.id, lane.id);
        } catch (error) {
          // Spawn failed (e.g. worktree error): release the reservation so it can
          // be retried, and record why.
          task.state = 'pending';
          task.updatedAt = nowIso();
          this.recordAudit({
            type: 'task_spawn_failed',
            actor: 'scheduler',
            projectId: task.projectId,
            sessionId: session.id,
            summary: `Could not spawn lane for task "${task.title}"`,
            status: 'failed',
            evidence: { taskId: task.id, error: error?.message || String(error) },
          });
        }
      }
      if (changed) this.persistState();
    }
  },

  // --- batch-completion signal ---------------------------------------------

  sessionBacklogStatus(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const tasks = (this.tasks || []).filter((task) => task.sessionId === session.id);
    const counts = { pending: 0, assigned: 0, in_lane: 0, accepted: 0, failed: 0, blocked: 0, total: tasks.length };
    for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
    const approvedCapacity = normalizeApprovedCapacity(
      session.approvedCapacity, normalizeApprovedCapacity(session.laneConcurrencyLimit));
    const active = counts.pending + counts.assigned + counts.in_lane > 0;
    const allAccepted = counts.total > 0 && counts.accepted === counts.total;
    const complete = counts.total > 0 && counts.pending === 0 && counts.assigned === 0
      && counts.in_lane === 0 && counts.blocked === 0;
    return {
      sessionId: session.id,
      counts,
      capacity: { approvedCapacity, spawnPolicy: normalizeSpawnPolicy(session.spawnPolicy) },
      active,
      complete,
      allAccepted,
      hasFailures: counts.failed > 0,
      completedAt: session.backlogCompletedAt || null,
    };
  },

  // Edge-triggered: fire once when every task is accepted. Latches on the
  // session record so it isn't re-fired on reload; cleared when a task is added
  // or requeued (so a second batch re-arms).
  evaluateBacklogCompletion(sessionLocator) {
    const session = typeof sessionLocator === 'object' && sessionLocator
      ? sessionLocator
      : this.getSession(sessionLocator);
    if (!session) return;
    const tasks = (this.tasks || []).filter((task) => task.sessionId === session.id);
    if (!tasks.length) return;
    const allAccepted = tasks.every((task) => task.state === 'accepted');
    if (!allAccepted) return;
    if (session.backlogCompletedAt) return; // already signalled
    session.backlogCompletedAt = nowIso();
    this.recordAudit({
      type: 'session_backlog_completed',
      actor: 'scheduler',
      projectId: session.projectId,
      sessionId: session.id,
      summary: `All ${tasks.length} backlog tasks accepted for session "${session.name}"`,
      status: 'passed',
      evidence: { taskCount: tasks.length },
    });
    if (typeof this.enqueueNotification === 'function') {
      this.enqueueNotification({
        type: 'backlog',
        severity: 'success',
        title: 'Backlog complete',
        body: `All ${tasks.length} tasks in "${session.name}" were accepted.`,
        projectId: session.projectId,
        sessionId: session.id,
      });
    }
    if (typeof this.sendOrchestratorMessage === 'function') {
      this.sendOrchestratorMessage(session.id, {
        message: `All ${tasks.length} backlog tasks have been accepted. The session backlog is complete — review the results or add more tasks.`,
      }, { actor: 'scheduler', approved: true }).catch(() => {});
    }
    this.persistState();
  },

  // Reconcile tasks left mid-flight by a crash/restart: an 'assigned' task never
  // got a lane (downgrade to pending); an 'in_lane' task whose lane is gone or
  // already terminal is requeued (or failed if out of attempts). Called from
  // restoreFromDisk after recoverInterruptedLanes.
  recoverInterruptedTasks() {
    let changed = false;
    for (const task of this.tasks || []) {
      if (task.state === 'assigned') {
        // Claimed but never linked to a live lane before the crash.
        task.state = 'pending';
        task.laneId = null;
        task.updatedAt = nowIso();
        changed = true;
      } else if (task.state === 'in_lane') {
        const lane = task.laneId ? this.getLane(task.laneId) : null;
        const laneState = String(lane?.state || '').toLowerCase();
        if (lane && laneState === 'accepted') {
          // The lane's work was accepted before the crash but the task hadn't been
          // synced — sync it now (do NOT re-run completed work).
          task.state = 'accepted';
          task.terminatedAt = nowIso();
          task.updatedAt = nowIso();
          changed = true;
        } else if (lane && laneState === 'done') {
          // Completed and awaiting audit — leave in_lane so the queued audit can
          // still accept it. Re-running it would duplicate finished work.
        } else if (!lane || ['failed', 'stopped'].includes(laneState)) {
          // The lane genuinely failed/vanished — requeue if budget remains, else fail.
          if ((task.attempts || 0) < (task.maxAttempts || 1)) {
            task.state = 'pending';
            task.laneId = null;
          } else {
            task.state = 'failed';
            task.terminatedAt = nowIso();
          }
          task.updatedAt = nowIso();
          changed = true;
        }
        // Any other lane state (queued/starting/running) — recoverInterruptedLanes
        // ran first and already failed truly-running lanes, which synced the task.
      }
    }
    return changed;
  },
};
