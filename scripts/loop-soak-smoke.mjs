#!/usr/bin/env node
/*
 * Low-token Orca loop soak.
 *
 * This exercises the durable loop daemon with mock executors only: external
 * orchestrator/supervisor registration, executor selection, scheduler ticks,
 * task fan-out, lane lifecycle, audit acceptance, and pause/resume notifications.
 *
 * Defaults are short enough for CI. For a real overnight/local soak:
 *   ORCA_SOAK_DURATION_MS=14400000 ORCA_SOAK_CADENCE_MS=300000 ORCA_SOAK_SAMPLE_MS=60000 npm run smoke:loop-soak
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { OrcaRegistry } from '../src/registry.js';

const readInt = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const durationMs = readInt('ORCA_SOAK_DURATION_MS', 15_000, { min: 3_000 });
const cadenceMs = readInt('ORCA_SOAK_CADENCE_MS', 1_000, { min: 1_000, max: 24 * 60 * 60 * 1000 });
const tickMs = readInt('ORCA_SOAK_TICK_MS', 250, { min: 50, max: 10_000 });
const autoCompleteMs = readInt('ORCA_SOAK_AUTO_COMPLETE_MS', 500, { min: 50, max: 60_000 });
const capacity = readInt('ORCA_SOAK_CAPACITY', 2, { min: 1, max: 8 });
const maxIterations = readInt('ORCA_SOAK_MAX_ITERATIONS', 0, { min: 0, max: 10_000 });
const sampleMs = readInt('ORCA_SOAK_SAMPLE_MS', Math.min(5_000, Math.max(1_000, cadenceMs)), {
  min: 1_000,
  max: 10 * 60 * 1000,
});
const restartMs = readInt('ORCA_SOAK_RESTART_MS', 0, { min: 0, max: 24 * 60 * 60 * 1000 });
const injectRateLimit = process.env.ORCA_SOAK_INJECT_RATE_LIMIT !== 'false';
const requireAudit = process.env.ORCA_SOAK_REQUIRE_AUDIT === 'true';
const exerciseEventQueue = process.env.ORCA_SOAK_EVENT_QUEUE !== 'false';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (label, payload = {}) => {
  const suffix = Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : '';
  console.log(`[loop-soak] ${label}${suffix}`);
};

const previousCwd = process.cwd();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-loop-soak-'));
let registry = null;
const eventStats = {
  drained: 0,
  acked: 0,
  replayed: 0,
  maxSeq: 0,
  lastReplaySeq: 0,
  leftUnackedId: null,
  leftUnackedSeenAgain: false,
  restarts: 0,
};

function loopCounts(loopId) {
  const tasks = registry.tasks.filter((task) => task.loopId === loopId);
  const lanes = registry.lanes.filter((lane) => lane.metadataLoopId === loopId);
  return {
    tasks: tasks.length,
    acceptedTasks: tasks.filter((task) => task.state === 'accepted').length,
    failedTasks: tasks.filter((task) => task.state === 'failed').length,
    activeTasks: tasks.filter((task) => !['accepted', 'failed'].includes(task.state)).length,
    lanes: lanes.length,
    runningLanes: lanes.filter((lane) => ['queued', 'starting', 'running'].includes(lane.state)).length,
    acceptedLanes: lanes.filter((lane) => lane.state === 'accepted').length,
    failedLanes: lanes.filter((lane) => lane.state === 'failed').length,
  };
}

function acceptCompletedLoopLanes(loopId) {
  let accepted = 0;
  for (const lane of registry.lanes.filter((entry) => entry.metadataLoopId === loopId)) {
    if (!['done', 'ready_for_audit', 'auditing'].includes(lane.state)) continue;
    if (lane.auditState === 'accepted') continue;
    registry.acceptLaneAudit(lane.id, {
      actor: 'loop-soak-auditor',
      findings: ['Mock executor completed during low-token loop soak.'],
    });
    accepted += 1;
  }
  return accepted;
}

function exerciseAgentQueue(sessionId) {
  if (!exerciseEventQueue) return;
  const orchestratorDrain = registry.drainAgentEvents(sessionId, {
    role: 'orchestrator',
    actor: 'loop-soak-orchestrator',
    limit: 200,
  });
  const ackIds = [];
  for (const event of orchestratorDrain.events) {
    eventStats.maxSeq = Math.max(eventStats.maxSeq, Number.parseInt(event.seq, 10) || 0);
    if (!eventStats.leftUnackedId && !eventStats.leftUnackedSeenAgain) {
      eventStats.leftUnackedId = event.id;
      continue;
    }
    if (event.id === eventStats.leftUnackedId) {
      eventStats.leftUnackedSeenAgain = true;
      eventStats.leftUnackedId = null;
    }
    ackIds.push(event.id);
  }
  eventStats.drained += orchestratorDrain.events.length;
  if (ackIds.length) {
    eventStats.acked += registry.ackAgentEvents(sessionId, {
      role: 'orchestrator',
      actor: 'loop-soak-orchestrator',
      eventIds: ackIds,
    }).acked;
  }

  const supervisorDrain = registry.drainAgentEvents(sessionId, {
    role: 'supervisor',
    actor: 'loop-soak-supervisor',
    limit: 200,
  });
  eventStats.drained += supervisorDrain.events.length;
  if (supervisorDrain.events.length) {
    eventStats.acked += registry.ackAgentEvents(sessionId, {
      role: 'supervisor',
      actor: 'loop-soak-supervisor',
      eventIds: supervisorDrain.events.map((event) => event.id),
    }).acked;
  }

  if (eventStats.maxSeq > eventStats.lastReplaySeq) {
    const replay = registry.replayAgentEvents(sessionId, {
      role: 'orchestrator',
      actor: 'loop-soak-orchestrator',
      afterSeq: eventStats.lastReplaySeq,
      limit: 200,
    });
    eventStats.replayed += replay.events.length;
    for (const event of replay.events) {
      eventStats.lastReplaySeq = Math.max(eventStats.lastReplaySeq, Number.parseInt(event.seq, 10) || 0);
    }
  }
}

async function restartRegistryIfIdle(loopId, { now, lastRestartAt, startedAt }) {
  if (!restartMs || now - lastRestartAt < restartMs) return lastRestartAt;
  const counts = loopCounts(loopId);
  if (counts.activeTasks || counts.runningLanes) return lastRestartAt;
  registry.stopScheduler();
  await registry.stopAllExecutors('loop soak registry restart').catch(() => {});
  await registry.drainPendingWrites();
  registry = new OrcaRegistry({
    heartbeatIntervalMs: tickMs,
    autoCompleteMs,
    autoAudit: false,
  });
  registry.stopScheduler();
  eventStats.restarts += 1;
  log('registry-restarted', { elapsedMs: now - startedAt, restarts: eventStats.restarts });
  return Date.now();
}

try {
  process.chdir(tempDir);
  registry = new OrcaRegistry({
    heartbeatIntervalMs: tickMs,
    autoCompleteMs,
    autoAudit: false,
  });
  registry.stopScheduler();

  const project = registry.createProject({ name: 'Orca Loop Soak' }, { actor: 'loop-soak', approved: true });
  const session = registry.createSession(project.id, {
    name: 'Mock 24/7 Loop Soak',
    leader: 'mock',
    spawnPolicy: 'auto',
    approvedCapacity: capacity,
    settingsOverrides: { flow: { requireAuditPass: requireAudit } },
  }, { actor: 'loop-soak', approved: true });
  const orchestrator = registry.createOrchestratorMcpBootstrap({
    role: 'orchestrator',
    actor: 'fable-soak-orchestrator',
    projectId: project.id,
    sessionId: session.id,
  });
  const supervisor = registry.createOrchestratorMcpBootstrap({
    role: 'supervisor',
    actor: 'fable-soak-supervisor',
    projectId: project.id,
    sessionId: session.id,
  });
  const orchestratorLease = registry.validateToolLease(orchestrator.leaseToken, {
    role: 'orchestrator',
    toolId: 'orchestrator.enroll',
    projectId: project.id,
    sessionId: session.id,
  });
  registry.enrollOrchestrator(session.id, {
    leaseId: orchestratorLease.id,
    actor: orchestratorLease.actor,
    source: 'mcp',
  });

  const loop = registry.createLoop(session.id, {
    name: 'Low-token Orca beta soak',
    goal: 'Keep Orca itself under mock-agent observation; pause on stoppage signals, notify, and resume safely.',
    executorTypes: ['mock'],
    cadenceMs,
    maxIterations,
  }, { actor: orchestratorLease.actor, approved: true });

  log('start', {
    durationMs,
    cadenceMs,
    tickMs,
    autoCompleteMs,
    capacity,
    maxIterations,
    sampleMs,
    restartMs,
    injectRateLimit,
    requireAudit,
    exerciseEventQueue,
    estimatedAgentTokens: 0,
    projectId: project.id,
    sessionId: session.id,
    loopId: loop.id,
    orchestratorLeaseId: orchestrator.lease.id,
    supervisorLeaseId: supervisor.lease.id,
  });

  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  let lastSampleAt = 0;
  let lastRestartAt = startedAt;
  let acceptedTotal = 0;
  let injected = false;

  while (Date.now() < deadline) {
    await registry.advanceLanes();
    if (injectRateLimit && !injected) {
      const lane = registry.lanes.find((entry) =>
        entry.metadataLoopId === loop.id
        && ['queued', 'starting', 'running'].includes(entry.state));
      if (lane) {
        await registry.markLaneFailed(lane, '429 usage limit during soak; Retry-After: 1 seconds', 'loop-soak');
        injected = true;
        log('injected-rate-limit', { laneId: lane.id });
      }
    }
    if (requireAudit) acceptedTotal += acceptCompletedLoopLanes(loop.id);
    await registry.advanceLanes();
    exerciseAgentQueue(session.id);

    const now = Date.now();
    lastRestartAt = await restartRegistryIfIdle(loop.id, { now, lastRestartAt, startedAt });
    if (now - lastSampleAt >= sampleMs) {
      const current = registry.getLoop(loop.id);
      log('sample', {
        elapsedMs: now - startedAt,
        loopState: current.state,
        pauseReason: current.pauseReason,
        resumeAt: current.resumeAt,
        iteration: current.iteration,
        streamRevision: registry.getStreamRevision(),
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        agentQueue: registry.agentQueue.length,
        agentEventsDrained: eventStats.drained,
        agentEventsAcked: eventStats.acked,
        agentEventsReplayed: eventStats.replayed,
        registryRestarts: eventStats.restarts,
        ...loopCounts(loop.id),
      });
      lastSampleAt = now;
    }
    await sleep(tickMs);
  }

  await registry.advanceLanes();
  if (requireAudit) acceptedTotal += acceptCompletedLoopLanes(loop.id);
  await registry.advanceLoops();
  exerciseAgentQueue(session.id);

  const finalLoop = registry.getLoop(loop.id);
  const finalCounts = loopCounts(loop.id);
  const overview = registry.supervisorOverview({ projectId: project.id, sessionId: session.id });
  const activeSupervisor = overview.activeSupervisors.find((entry) => entry.actor === 'fable-soak-supervisor');
  const activeOrchestrator = overview.projects[0]?.sessions[0]?.activeOrchestrator;
  const pausedNotification = registry.notifications.some((entry) =>
    entry.type === 'loop_paused' && entry.metadata?.loopId === loop.id);
  const resumedNotification = registry.notifications.some((entry) =>
    entry.type === 'loop_resumed' && entry.metadata?.loopId === loop.id);

  assert.ok(activeSupervisor?.active, 'supervisor registration should stay visible');
  assert.equal(activeOrchestrator?.actor, 'fable-soak-orchestrator');
  assert.ok(['running', 'completed'].includes(finalLoop.state), `loop should be running or completed, got ${finalLoop.state}`);
  assert.equal(finalCounts.runningLanes <= capacity, true, 'running lanes must not exceed approved capacity');
  assert.equal(finalCounts.activeTasks <= capacity, true, 'active loop tasks must remain bounded by capacity');
  assert.equal(finalCounts.acceptedTasks > 0 || finalCounts.failedTasks > 0, true, 'soak should exercise at least one terminal task');
  if (injectRateLimit) {
    assert.equal(injected, true, 'rate-limit injection should run');
    assert.equal(pausedNotification, true, 'pause notification should be emitted');
    assert.equal(resumedNotification, true, 'resume notification should be emitted');
  }
  let replayAll = { events: [] };
  if (exerciseEventQueue) {
    const finalDrain = registry.drainAgentEvents(session.id, {
      role: 'orchestrator',
      actor: 'loop-soak-orchestrator',
      limit: 500,
    });
    if (finalDrain.events.length) {
      eventStats.acked += registry.ackAgentEvents(session.id, {
        role: 'orchestrator',
        actor: 'loop-soak-orchestrator',
        eventIds: finalDrain.events.map((event) => event.id),
      }).acked;
    }
    replayAll = registry.replayAgentEvents(session.id, {
      role: 'orchestrator',
      actor: 'loop-soak-orchestrator',
      limit: 1000,
    });
    assert.equal(eventStats.drained > 0, true, 'event queue should be drained by mock consumers');
    assert.equal(eventStats.acked > 0, true, 'event queue should acknowledge drained events');
    assert.equal(eventStats.replayed > 0, true, 'event queue replay should return history');
    assert.equal(eventStats.replayed <= Math.max(25, eventStats.drained * 4), true, 'event queue replay should remain bounded by new work');
    assert.equal(eventStats.leftUnackedSeenAgain, true, 'unacked event should be redelivered on a later drain');
    assert.equal(replayAll.events.some((event) => event.type === 'loop_iteration_queued'), true, 'loop iteration events should be replayable');
  }

  log('done', {
    loopState: finalLoop.state,
    pauseReason: finalLoop.pauseReason,
    iteration: finalLoop.iteration,
    acceptedTotal,
    pausedNotification,
    resumedNotification,
    agentQueue: registry.agentQueue.length,
    agentEventsDrained: eventStats.drained,
    agentEventsAcked: eventStats.acked,
    agentEventsReplayed: eventStats.replayed,
    agentEventsReplayable: replayAll.events.length,
    registryRestarts: eventStats.restarts,
    ...finalCounts,
    estimatedAgentTokens: 0,
  });
} finally {
  if (registry) {
    registry.stopScheduler();
    await registry.stopAllExecutors('loop soak complete').catch(() => {});
    await registry.drainPendingWrites();
  }
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}
