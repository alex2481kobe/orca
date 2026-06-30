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
    await registry.markLaneFailed(lane, '429 rate limit from executor', 'test');

    await registry.advanceLoops({ now: now + 2000 });
    const paused = registry.getLoop(loop.id);
    assert.equal(paused.state, 'paused');
    assert.equal(paused.pauseReason, 'rate_limited');
    assert.ok(registry.notifications.some((item) =>
      item.type === 'loop_paused'
      && item.metadata?.loopId === loop.id
      && item.metadata?.reason === 'rate_limited'));
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
