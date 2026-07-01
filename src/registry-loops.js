// Durable autonomous loop controller for Orca. A loop owns intent + cadence and
// queues bounded backlog tasks for existing Codex/Claude/etc. executors; the
// scheduler and task/audit machinery still enforce capacity, worktree isolation,
// tool leases, and review gates.

import { randomUUID } from 'node:crypto';
import { clonePayload, nowIso, safeArray } from './registry-utils.js';

export const LOOP_STATES = ['running', 'paused', 'completed', 'archived'];
export const LOOP_PAUSE_REASONS = [
  'manual',
  'auth_required',
  'rate_limited',
  'missing_scope',
  'blocked',
  'error',
];

const LOOP_TERMINAL_TASK_STATES = new Set(['accepted', 'failed']);
const AUTH_PATTERN = /\b(401|403|auth(?:entication|orization)?|unauthorized|forbidden|login|\/login|api key|token expired|credentials?)\b/i;
const RATE_LIMIT_PATTERN = /\b(429|rate.?limit|too many requests|quota|usage limit|try again later|retry-after)\b/i;
const RETRY_AFTER_PATTERN = /\b(?:retry-after|retry after|try again in)\s*:?\s*(\d{1,6})\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes)?\b/i;

function cleanText(value, max, fallback = '') {
  const text = String(value || '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .trim();
  return (text || fallback).slice(0, max);
}

function normalizeLoopState(value, fallback = 'paused') {
  const state = String(value || '').trim().toLowerCase();
  return LOOP_STATES.includes(state) ? state : fallback;
}

function normalizePauseReason(value, fallback = 'manual') {
  const reason = String(value || '').trim().toLowerCase();
  return LOOP_PAUSE_REASONS.includes(reason) ? reason : fallback;
}

function normalizeResumeAt(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function retryAfterMsFromText(text) {
  const match = String(text || '').match(RETRY_AFTER_PATTERN);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = String(match[2] || 'seconds').toLowerCase();
  const multiplier = unit.startsWith('ms') || unit.startsWith('millisecond') ? 1
    : unit === 'm' || unit.startsWith('min') || unit.startsWith('minute') ? 60 * 1000
      : 1000;
  return Math.max(1000, Math.min(24 * 60 * 60 * 1000, amount * multiplier));
}

function resumeAtFromPause({ resumeAt = null, retryAfterMs = null } = {}, now = Date.now()) {
  const explicit = normalizeResumeAt(resumeAt);
  if (explicit) return explicit;
  const retryMs = Number.parseInt(retryAfterMs, 10);
  if (Number.isFinite(retryMs) && retryMs > 0) {
    return new Date(now + Math.max(1000, Math.min(24 * 60 * 60 * 1000, retryMs))).toISOString();
  }
  return null;
}

function normalizeExecutorTypes(registry, value) {
  const requested = safeArray(value, [])
    .map((item) => cleanText(item, 40).toLowerCase())
    .filter(Boolean);
  const defaults = ['codex', 'claude'];
  const supported = new Set(typeof registry.getSupportedExecutorTypes === 'function'
    ? registry.getSupportedExecutorTypes()
    : ['mock']);
  const source = requested.length ? requested : defaults.filter((type) => supported.has(type));
  const normalized = [];
  for (const type of source) {
    if (!supported.has(type)) {
      throw { status: 422, message: `Loop executorType must be one of: ${[...supported].join(', ')}.` };
    }
    if (!normalized.includes(type)) normalized.push(type);
    if (normalized.length >= 4) break;
  }
  return normalized.length ? normalized : ['mock'];
}

function loopTaskPrompt(loop, { iteration, executorType }) {
  return [
    `Loop goal: ${loop.goal}`,
    `Loop iteration: ${iteration}`,
    `Executor lane: ${executorType}`,
    '',
    'Operate as part of a persistent Orca loop:',
    '- inspect the existing session/orchestrator/supervisor state before acting;',
    '- do not accept weak success claims without evidence;',
    '- produce concrete work, tests, or a concise blocker with the exact next action;',
    '- if blocked by auth or rate limits, report that clearly so the loop can pause and notify the user.',
  ].join('\n');
}

function loopLaneText(lane) {
  const logs = safeArray(lane?.logs, []).slice(-12).map((entry) => entry?.message || '').join('\n');
  const events = safeArray(lane?.agentEvents, []).slice(-12).map((entry) =>
    `${entry?.title || ''}\n${entry?.content || ''}`).join('\n');
  return [
    lane?.exitReason || '',
    lane?.resultText || '',
    logs,
    events,
  ].join('\n');
}

export const loopMethods = {
  getLoop(loopLocator) {
    const id = String(loopLocator || '');
    return (this.loops || []).find((loop) => loop.id === id) || null;
  },

  listLoops(sessionLocator = null, { state = null } = {}) {
    const session = sessionLocator ? this.getSession(sessionLocator) : null;
    if (sessionLocator && !session) throw { status: 404, message: 'Session not found.' };
    const wanted = state ? normalizeLoopState(state, '') : '';
    const loops = (this.loops || [])
      .filter((loop) => !session || loop.sessionId === session.id)
      .filter((loop) => !wanted || loop.state === wanted)
      .map((loop) => this.publicLoop(loop));
    return clonePayload(loops);
  },

  publicLoop(loop) {
    if (!loop) return null;
    const tasks = (this.tasks || []).filter((task) => task.loopId === loop.id);
    const activeTasks = tasks.filter((task) => !LOOP_TERMINAL_TASK_STATES.has(task.state));
    return {
      ...clonePayload(loop),
      progress: {
        taskCount: tasks.length,
        activeTaskCount: activeTasks.length,
        acceptedTaskCount: tasks.filter((task) => task.state === 'accepted').length,
        failedTaskCount: tasks.filter((task) => task.state === 'failed').length,
        lastTaskIds: safeArray(loop.lastTaskIds, []),
      },
    };
  },

  createLoop(sessionLocator, {
    name = '',
    goal,
    cadenceMs = 60_000,
    maxIterations = 0,
    executorTypes = null,
    state = 'running',
    actor = 'orchestrator',
  } = {}, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const cleanGoal = cleanText(goal, 6000);
    if (!cleanGoal) throw { status: 422, message: 'Loop goal is required.' };
    const now = nowIso();
    const initialState = normalizeLoopState(state, 'running');
    if (initialState === 'running') {
      const policyCheck = this.evaluateActionPolicy('createLane', context);
      if (!policyCheck.allowed) {
        throw {
          status: 409,
          message: policyCheck.message,
          requiresApproval: true,
          risk: policyCheck.policy.risk,
        };
      }
    }
    const loop = {
      id: randomUUID(),
      projectId: session.projectId,
      sessionId: session.id,
      name: cleanText(name, 160, cleanGoal.split(/\r?\n/)[0] || 'Orca loop'),
      goal: cleanGoal,
      state: initialState,
      pauseReason: initialState === 'paused' ? 'manual' : null,
      pauseMessage: initialState === 'paused' ? 'Loop created paused.' : null,
      resumeAt: null,
      pauseSignalLaneIds: [],
      cadenceMs: Math.max(1_000, Math.min(24 * 60 * 60 * 1000, Number.parseInt(cadenceMs, 10) || 60_000)),
      maxIterations: Math.max(0, Math.min(10_000, Number.parseInt(maxIterations, 10) || 0)),
      iteration: 0,
      executorTypes: normalizeExecutorTypes(this, executorTypes),
      lastRunAt: null,
      nextRunAt: initialState === 'running' ? now : null,
      lastTaskIds: [],
      createdAt: now,
      updatedAt: now,
      createdBy: cleanText(context.actor || actor, 120, 'orchestrator'),
    };
    this.loops.push(loop);
    this.recordAudit({
      type: 'loop_created',
      actor: loop.createdBy,
      projectId: loop.projectId,
      sessionId: loop.sessionId,
      summary: `Loop "${loop.name}" created`,
      status: 'passed',
      evidence: { loopId: loop.id, executorTypes: loop.executorTypes, cadenceMs: loop.cadenceMs },
    });
    this.persistState();
    return this.publicLoop(loop);
  },

  updateLoop(loopLocator, patch = {}, context = {}) {
    const loop = this.getLoop(loopLocator);
    if (!loop) throw { status: 404, message: 'Loop not found.' };
    if (patch.name !== undefined) loop.name = cleanText(patch.name, 160, loop.name);
    if (patch.goal !== undefined) {
      const goal = cleanText(patch.goal, 6000);
      if (!goal) throw { status: 422, message: 'Loop goal cannot be empty.' };
      loop.goal = goal;
    }
    if (patch.cadenceMs !== undefined) {
      loop.cadenceMs = Math.max(1_000, Math.min(24 * 60 * 60 * 1000, Number.parseInt(patch.cadenceMs, 10) || loop.cadenceMs));
    }
    if (patch.maxIterations !== undefined) {
      loop.maxIterations = Math.max(0, Math.min(10_000, Number.parseInt(patch.maxIterations, 10) || 0));
    }
    if (patch.executorTypes !== undefined) loop.executorTypes = normalizeExecutorTypes(this, patch.executorTypes);
    if (patch.state !== undefined) {
      const next = normalizeLoopState(patch.state, loop.state);
      if (next === 'running' && loop.state !== 'running') {
        const policyCheck = this.evaluateActionPolicy('createLane', context);
        if (!policyCheck.allowed) {
          throw {
            status: 409,
            message: policyCheck.message,
            requiresApproval: true,
            risk: policyCheck.policy.risk,
          };
        }
      }
      loop.state = next;
      if (next === 'running') {
        loop.pauseReason = null;
        loop.pauseMessage = null;
        loop.resumeAt = null;
        loop.nextRunAt = nowIso();
      } else if (next === 'paused') {
        loop.pauseReason = normalizePauseReason(patch.pauseReason, 'manual');
        loop.pauseMessage = cleanText(patch.pauseMessage || 'Loop paused.', 500);
        loop.resumeAt = resumeAtFromPause(patch);
        loop.nextRunAt = null;
      }
    }
    loop.updatedAt = nowIso();
    this.recordAudit({
      type: 'loop_updated',
      actor: cleanText(context.actor || patch.actor, 120, 'orchestrator'),
      projectId: loop.projectId,
      sessionId: loop.sessionId,
      summary: `Loop "${loop.name}" updated`,
      status: 'passed',
      evidence: { loopId: loop.id, state: loop.state, pauseReason: loop.pauseReason || null, resumeAt: loop.resumeAt || null },
    });
    this.persistState();
    return this.publicLoop(loop);
  },

  pauseLoop(loopLocator, { reason = 'manual', message = 'Loop paused.', actor = 'orchestrator', resumeAt = null, retryAfterMs = null, signalLaneId = null } = {}) {
    const loop = this.getLoop(loopLocator);
    if (loop && signalLaneId) {
      loop.pauseSignalLaneIds = [
        ...new Set([...safeArray(loop.pauseSignalLaneIds, []), String(signalLaneId)]),
      ].slice(-100);
    }
    return this.updateLoop(loopLocator, {
      state: 'paused',
      pauseReason: normalizePauseReason(reason, 'manual'),
      pauseMessage: cleanText(message, 500, 'Loop paused.'),
      resumeAt,
      retryAfterMs,
    }, { actor });
  },

  resumeLoop(loopLocator, { actor = 'orchestrator' } = {}) {
    return this.updateLoop(loopLocator, { state: 'running' }, { actor });
  },

  _loopTasks(loop) {
    return (this.tasks || []).filter((task) => task.loopId === loop.id);
  },

  _loopHasOutstandingWork(loop) {
    return this._loopTasks(loop).some((task) => !LOOP_TERMINAL_TASK_STATES.has(task.state));
  },

  _detectLoopPauseSignal(loop, now = Date.now()) {
    const tasks = this._loopTasks(loop);
    const laneIds = new Set(tasks.map((task) => task.laneId).filter(Boolean));
    const handledLaneIds = new Set(safeArray(loop.pauseSignalLaneIds, []).map((id) => String(id)));
    const lanes = (this.lanes || []).filter((lane) =>
      laneIds.has(lane.id) || (lane.metadataLoopId && lane.metadataLoopId === loop.id));
    for (const lane of lanes.slice(-20)) {
      if (handledLaneIds.has(String(lane.id))) continue;
      const text = loopLaneText(lane);
      if (RATE_LIMIT_PATTERN.test(text)) {
        const retryAfterMs = retryAfterMsFromText(text);
        return {
          reason: 'rate_limited',
          message: `Loop paused after ${lane.executorType} reported a rate/usage limit.${retryAfterMs ? ' Orca will resume automatically after the retry window.' : ''}`,
          resumeAt: retryAfterMs ? new Date(now + retryAfterMs).toISOString() : null,
          signalLaneId: lane.id,
        };
      }
      if (AUTH_PATTERN.test(text)) {
        return {
          reason: 'auth_required',
          message: `Loop paused after ${lane.executorType} reported an authentication issue. Re-authenticate the CLI, then resume the loop.`,
          signalLaneId: lane.id,
        };
      }
    }
    return null;
  },

  async advanceLoops({ now = Date.now() } = {}) {
    let changed = false;
    for (const loop of this.loops || []) {
      if (loop.state === 'paused') {
        const resumeAt = Date.parse(loop.resumeAt || 0);
        if (loop.pauseReason === 'rate_limited' && Number.isFinite(resumeAt) && resumeAt <= now) {
          const previousReason = loop.pauseReason;
          loop.state = 'running';
          loop.pauseReason = null;
          loop.pauseMessage = null;
          loop.resumeAt = null;
          loop.nextRunAt = new Date(now).toISOString();
          loop.updatedAt = nowIso();
          this.recordAudit({
            type: 'loop_resumed',
            actor: 'scheduler',
            projectId: loop.projectId,
            sessionId: loop.sessionId,
            summary: `Loop "${loop.name}" resumed after ${previousReason}`,
            status: 'passed',
            evidence: { loopId: loop.id, previousReason },
          });
          if (typeof this.enqueueNotification === 'function') {
            this.enqueueNotification({
              type: 'loop_resumed',
              severity: 'info',
              title: 'Loop resumed',
              body: `Resuming "${loop.name}" after ${previousReason}.`,
              actor: 'scheduler',
              projectId: loop.projectId,
              sessionId: loop.sessionId,
              metadata: { loopId: loop.id, previousReason },
            });
          }
          if (typeof this.enqueueAgentEvent === 'function') {
            this.enqueueAgentEvent({
              type: 'loop_resumed',
              targetRole: 'orchestrator',
              severity: 'info',
              title: 'Loop resumed',
              body: `Resuming "${loop.name}" after ${previousReason}.`,
              actor: 'scheduler',
              projectId: loop.projectId,
              sessionId: loop.sessionId,
              loopId: loop.id,
              dedupeKey: `loop-resumed:${loop.id}:${loop.updatedAt}`,
              metadata: { previousReason },
            });
          }
          changed = true;
        } else {
          continue;
        }
      }
      if (loop.state !== 'running') continue;
      const session = this.getSession(loop.sessionId);
      if (!session || session.state === 'archived') {
        this.pauseLoop(loop.id, {
          reason: 'missing_scope',
          message: 'Loop paused because its session is missing or archived.',
          actor: 'scheduler',
        });
        changed = true;
        continue;
      }
      const next = Date.parse(loop.nextRunAt || 0);
      if (Number.isFinite(next) && next > now) continue;

      const pause = this._detectLoopPauseSignal(loop, now);
      if (pause) {
        this.pauseLoop(loop.id, { ...pause, actor: 'scheduler' });
        if (typeof this.enqueueNotification === 'function') {
          this.enqueueNotification({
            type: 'loop_paused',
            severity: pause.reason === 'rate_limited' ? 'warning' : 'error',
            title: pause.reason === 'rate_limited' ? 'Loop paused for rate limit' : 'Loop paused for login',
            body: pause.message,
            actor: 'scheduler',
            projectId: loop.projectId,
            sessionId: loop.sessionId,
            metadata: { loopId: loop.id, reason: pause.reason },
          });
        }
        if (typeof this.enqueueAgentEvent === 'function') {
          this.enqueueAgentEvent({
            type: 'loop_paused',
            targetRole: 'orchestrator',
            severity: pause.reason === 'rate_limited' ? 'warning' : 'error',
            title: pause.reason === 'rate_limited' ? 'Loop paused for rate limit' : 'Loop paused for login',
            body: pause.message,
            actor: 'scheduler',
            projectId: loop.projectId,
            sessionId: loop.sessionId,
            loopId: loop.id,
            laneId: pause.signalLaneId || null,
            dedupeKey: `loop-paused:${loop.id}:${pause.reason}:${pause.signalLaneId || loop.updatedAt}`,
            metadata: { reason: pause.reason, resumeAt: pause.resumeAt || null },
          });
        }
        changed = true;
        continue;
      }

      if (this._loopHasOutstandingWork(loop)) {
        loop.nextRunAt = new Date(now + loop.cadenceMs).toISOString();
        loop.updatedAt = nowIso();
        changed = true;
        continue;
      }
      if (loop.maxIterations > 0 && loop.iteration >= loop.maxIterations) {
        loop.state = 'completed';
        loop.nextRunAt = null;
        loop.updatedAt = nowIso();
        this.recordAudit({
          type: 'loop_completed',
          actor: 'scheduler',
          projectId: loop.projectId,
          sessionId: loop.sessionId,
          summary: `Loop "${loop.name}" completed after ${loop.iteration} iteration(s)`,
          status: 'passed',
          evidence: { loopId: loop.id, iteration: loop.iteration },
        });
        changed = true;
        continue;
      }

      const iteration = loop.iteration + 1;
      const taskIds = [];
      for (const executorType of safeArray(loop.executorTypes, ['mock'])) {
        const task = this.addTask(session.id, {
          title: `Loop ${iteration}: ${loop.name} (${executorType})`,
          description: loop.goal,
          taskPrompt: loopTaskPrompt(loop, { iteration, executorType }),
          executorType,
          priority: 10,
          maxAttempts: 1,
          actor: 'loop',
          loopId: loop.id,
        }, { actor: 'loop' });
        taskIds.push(task.id);
      }
      loop.iteration = iteration;
      loop.lastRunAt = nowIso();
      loop.nextRunAt = new Date(now + loop.cadenceMs).toISOString();
      loop.lastTaskIds = taskIds;
      loop.updatedAt = loop.lastRunAt;
      this.recordAudit({
        type: 'loop_iteration_queued',
        actor: 'scheduler',
        projectId: loop.projectId,
        sessionId: loop.sessionId,
        summary: `Loop "${loop.name}" queued iteration ${iteration}`,
        status: 'passed',
        evidence: { loopId: loop.id, iteration, taskIds, executorTypes: loop.executorTypes },
      });
      if (typeof this.enqueueAgentEvent === 'function') {
        this.enqueueAgentEvent({
          type: 'loop_iteration_queued',
          targetRole: 'orchestrator',
          severity: 'info',
          title: `Loop iteration ${iteration} queued`,
          body: `Loop "${loop.name}" queued ${taskIds.length} task(s).`,
          actor: 'scheduler',
          projectId: loop.projectId,
          sessionId: loop.sessionId,
          loopId: loop.id,
          dedupeKey: `loop-iteration:${loop.id}:${iteration}`,
          metadata: { iteration, taskIds, executorTypes: loop.executorTypes },
        });
      }
      changed = true;
    }
    if (changed) this.persistState();
    return changed;
  },
};
