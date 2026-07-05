import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-loops-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  try {
    return await callback(registry);
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function makeSession(registry, body = {}) {
  const project = registry.createProject({ name: 'Loop Project' }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, {
    name: 'Loop Session',
    leader: 'mock',
    spawnPolicy: 'auto',
    approvedCapacity: 4,
    ...body,
  }, { actor: 'test', approved: true });
  return { project, session };
}

test('loops queue Codex and Claude tasks without duplicating while work is outstanding', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const loop = registry.createLoop(session.id, {
      name: 'Improve Orca',
      goal: 'Keep checking the worker evidence and refine the plan.',
      executorTypes: ['codex', 'claude'],
      cadenceMs: 1000,
      maxIterations: 2,
    }, { actor: 'test', approved: true });

    const firstNow = Date.now() + 10;
    assert.equal(await registry.advanceLoops({ now: firstNow }), true);
    const firstTasks = registry.listTasks(session.id);
    assert.equal(firstTasks.length, 2);
    assert.deepEqual(firstTasks.map((task) => task.executorType).sort(), ['claude', 'codex']);
    assert.equal(firstTasks.every((task) => task.loopId === loop.id), true);

    assert.equal(await registry.advanceLoops({ now: firstNow + 2000 }), true);
    assert.equal(registry.listTasks(session.id).length, 2, 'outstanding loop work must suppress duplicate prompts');

    for (const task of registry.tasks.filter((entry) => entry.loopId === loop.id)) {
      task.state = 'accepted';
      task.terminatedAt = new Date(firstNow + 3000).toISOString();
    }
    assert.equal(await registry.advanceLoops({ now: firstNow + 4000 }), true);
    const allTasks = registry.listTasks(session.id);
    assert.equal(allTasks.length, 4);
    assert.equal(registry.getLoop(loop.id).iteration, 2);
  });
});

test('loops complete instead of prompting forever after maxIterations', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const loop = registry.createLoop(session.id, {
      name: 'One pass',
      goal: 'Do one careful pass and stop.',
      executorTypes: ['mock'],
      cadenceMs: 1000,
      maxIterations: 1,
    }, { approved: true });

    const now = Date.now() + 10;
    await registry.advanceLoops({ now });
    assert.equal(registry.listTasks(session.id).length, 1);
    registry.tasks.find((task) => task.loopId === loop.id).state = 'accepted';

    await registry.advanceLoops({ now: now + 2000 });
    const completed = registry.getLoop(loop.id);
    assert.equal(completed.state, 'completed');
    assert.equal(registry.listTasks(session.id).length, 1);
  });
});

test('nonstop loops expose an explicit run mode and keep queuing after accepted work', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const loop = registry.createLoop(session.id, {
      name: 'Always-on supervisor',
      goal: 'Keep checking for the next useful verification pass.',
      executorTypes: ['mock'],
      cadenceMs: 1000,
      runMode: 'nonstop',
    }, { approved: true });

    assert.equal(loop.runMode, 'nonstop');
    assert.equal(loop.isNonstop, true);
    assert.equal(loop.maxIterations, 0);

    const now = Date.now() + 10;
    await registry.advanceLoops({ now });
    registry.tasks.find((task) => task.loopId === loop.id).state = 'accepted';
    await registry.advanceLoops({ now: now + 2000 });
    registry.tasks.filter((task) => task.loopId === loop.id).at(-1).state = 'accepted';
    await registry.advanceLoops({ now: now + 4000 });

    const current = registry.getLoop(loop.id);
    assert.equal(current.state, 'running');
    assert.equal(current.iteration, 3);
    assert.equal(registry.publicLoop(current).runMode, 'nonstop');
  });
});

test('loop skills and directives are bounded, public, and injected into task prompts', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const loop = registry.createLoop(session.id, {
      name: 'Skillful loop',
      goal: 'Use project-specific operating rules on every pass.',
      executorTypes: ['mock'],
      cadenceMs: 1000,
      skills: ['clean-architecture', 'web-app-verification', 'clean-architecture', '\u0000'],
      directives: [
        'Use terminal-first evidence when the lane changes shell behavior.',
        'Keep token usage low and pause cleanly on auth or rate limits.',
        '',
      ],
    }, { approved: true });

    assert.deepEqual(loop.skills, ['clean-architecture', 'web-app-verification']);
    assert.deepEqual(loop.directives, [
      'Use terminal-first evidence when the lane changes shell behavior.',
      'Keep token usage low and pause cleanly on auth or rate limits.',
    ]);

    const now = Date.now() + 10;
    await registry.advanceLoops({ now });
    const task = registry.tasks.find((entry) => entry.loopId === loop.id);
    assert.ok(task.taskPrompt.includes('Loop run mode: nonstop'));
    assert.ok(task.taskPrompt.includes('Loop skills to apply: clean-architecture, web-app-verification'));
    assert.ok(task.taskPrompt.includes('- Use terminal-first evidence when the lane changes shell behavior.'));
    assert.ok(task.taskPrompt.includes('conflict with policy, safety, approval gates, or lane scope'));

    const updated = registry.updateLoop(loop.id, {
      runMode: 'bounded',
      maxIterations: 5,
      skillRefs: 'claude-fable\nmodel-agent-orchestration',
      directives: ['Review executor outputs before accepting them.'],
    }, { approved: true });
    assert.equal(updated.runMode, 'bounded');
    assert.equal(updated.isNonstop, false);
    assert.equal(updated.maxIterations, 5);
    assert.deepEqual(updated.skills, ['claude-fable', 'model-agent-orchestration']);
    assert.deepEqual(updated.directives, ['Review executor outputs before accepting them.']);
  });
});

test('loops pause and notify when a loop-owned lane reports a rate limit', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const loop = registry.createLoop(session.id, {
      name: 'Rate limit aware',
      goal: 'Keep going unless the CLI is rate limited.',
      executorTypes: ['mock'],
      cadenceMs: 1000,
    }, { approved: true });

    const now = Date.now() + 10;
    await registry.advanceLoops({ now });
    await registry.dispatchPendingTasks();
    const lane = registry.lanes.find((entry) => entry.metadataLoopId === loop.id);
    assert.ok(lane, 'loop task should spawn a tagged lane');
    await registry.markLaneFailed(lane, '429 rate limit from executor; Retry-After: 120 seconds', 'test');

    await registry.advanceLoops({ now: now + 2000 });
    const paused = registry.getLoop(loop.id);
    assert.equal(paused.state, 'paused');
    assert.equal(paused.pauseReason, 'rate_limited');
    assert.equal(Date.parse(paused.resumeAt) > now + 100_000, true);
    assert.ok(registry.notifications.some((item) =>
      item.type === 'loop_paused'
      && item.metadata?.loopId === loop.id
      && item.metadata?.reason === 'rate_limited'));
  });
});

test('rate-limited loops wait until resumeAt, then continue without replaying the old pause signal', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const loop = registry.createLoop(session.id, {
      name: 'Resume after rate limit',
      goal: 'Pause on rate limits and then keep going.',
      executorTypes: ['mock'],
      cadenceMs: 1000,
      maxIterations: 2,
    }, { approved: true });

    const now = Date.now() + 10;
    await registry.advanceLoops({ now });
    await registry.dispatchPendingTasks();
    const lane = registry.lanes.find((entry) => entry.metadataLoopId === loop.id);
    await registry.markLaneFailed(lane, 'Usage limit reached. Retry-After: 2 seconds', 'test');
    await registry.advanceLoops({ now: now + 1000 });

    const paused = registry.getLoop(loop.id);
    assert.equal(paused.state, 'paused');
    assert.equal(paused.iteration, 1);
    assert.equal(registry.listTasks(session.id).length, 1);

    assert.equal(await registry.advanceLoops({ now: now + 1500 }), false, 'not yet due: no churn and no duplicate prompt');
    assert.equal(registry.listTasks(session.id).length, 1);

    assert.equal(await registry.advanceLoops({ now: now + 3000 }), true);
    const resumed = registry.getLoop(loop.id);
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.pauseReason, null);
    assert.equal(resumed.resumeAt, null);
    assert.equal(resumed.iteration, 2);
    assert.equal(registry.listTasks(session.id).length, 2);
    assert.ok(registry.notifications.some((item) =>
      item.type === 'loop_resumed'
      && item.metadata?.loopId === loop.id
      && item.metadata?.previousReason === 'rate_limited'));
  });
});

test('running loops do not churn while nextRunAt is in the future', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    registry.createLoop(session.id, {
      name: 'Quiet loop',
      goal: 'Stay idle until the cadence says to run.',
      executorTypes: ['mock'],
      cadenceMs: 60_000,
    }, { approved: true });

    const now = Date.now() + 10;
    assert.equal(await registry.advanceLoops({ now }), true);
    const revisionAfterQueue = registry.getStreamRevision();
    const taskCountAfterQueue = registry.listTasks(session.id).length;

    assert.equal(await registry.advanceLoops({ now: now + 1000 }), false);
    assert.equal(registry.getStreamRevision(), revisionAfterQueue);
    assert.equal(registry.listTasks(session.id).length, taskCountAfterQueue);
  });
});

test('loops pause for CLI authentication failures so the user can re-login', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const loop = registry.createLoop(session.id, {
      name: 'Auth aware',
      goal: 'Continue after authentication is restored.',
      executorTypes: ['mock'],
      cadenceMs: 1000,
    }, { approved: true });

    const now = Date.now() + 10;
    await registry.advanceLoops({ now });
    await registry.dispatchPendingTasks();
    const lane = registry.lanes.find((entry) => entry.metadataLoopId === loop.id);
    await registry.markLaneFailed(lane, 'Claude CLI says /login is required', 'test');

    await registry.advanceLoops({ now: now + 2000 });
    const paused = registry.getLoop(loop.id);
    assert.equal(paused.state, 'paused');
    assert.equal(paused.pauseReason, 'auth_required');
    assert.match(paused.pauseMessage, /Re-authenticate/i);
  });
});
