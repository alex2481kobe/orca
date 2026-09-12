// A lane that SUCCEEDS wakes its orchestrator, exactly as one that fails or stops does.
//
// This is the gap the owner reported three times: Orca never told the orchestrator a
// lane had finished. The cause was not a missing subsystem — the durable, drainable
// agent-event queue already existed and `event.drain` was already implemented. It was
// an ASYMMETRY. `markLaneFailed` and `markLaneStopped` each enqueued a wakeup;
// `markLaneCompleted` carried a comment saying a future notifier would hook in there,
// and nothing ever did.
//
// So the only terminal state an orchestrator was never told about was the GOOD one —
// the one that unblocks whatever comes next. It had to re-poll to find out, and a
// finish that happened while it was not polling was silent.
//
// The test asserts the symmetry rather than the single case, because the single case
// is what was already true for two paths out of three and still left the defect.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';

async function inTempDir(fn) {
  const previousCwd = process.cwd();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-wakeup-'));
  process.chdir(dir);
  approveFixtureRoot(process.cwd());
  try { return await fn(dir); } finally {
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function makeRegistry() {
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  return registry;
}

async function orchestratorFor(registry, actor) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  return await registry.registerOrchestrator({ cwd: process.cwd(), actor, title: actor }, { leaseId: lease.id });
}

function laneFor(registry, orchestrator, title) {
  const created = registry.createLane(orchestrator.id, { title, executorType: 'mock' }, { actor: 'test', approved: true });
  return registry.getLane(created.id);
}

// Drain is the ONLY path an orchestrator has, so the test reads what a real
// orchestrator would read rather than inspecting the queue directly.
function drainTypes(registry, orchestrator) {
  const drained = registry.drainAgentEvents(orchestrator.id, { role: 'orchestrator', actor: 'test', limit: 50 });
  return (drained.events || []).map((event) => event.type);
}

test('a COMPLETED lane enqueues a durable wakeup the orchestrator can drain', async () => {
  await inTempDir(async () => {
    const registry = makeRegistry();
    try {
      const orchestrator = await orchestratorFor(registry, 'orc-complete');
      const lane = laneFor(registry, orchestrator, 'work that succeeded');
      registry.markLaneCompleted(lane);
      assert.ok(
        drainTypes(registry, orchestrator).includes('lane_completed'),
        'a lane finishing successfully must wake its orchestrator; before this fix only failure and stop did',
      );
    } finally {
      registry.stopScheduler();
      await registry.drainPendingWrites();
    }
  });
});

test('ALL THREE terminal states wake the orchestrator — the symmetry, not one case', async () => {
  await inTempDir(async () => {
    const registry = makeRegistry();
    try {
      const orchestrator = await orchestratorFor(registry, 'orc-symmetry');
      registry.markLaneCompleted(laneFor(registry, orchestrator, 'succeeded'));
      registry.markLaneFailed(laneFor(registry, orchestrator, 'failed'), 'blew up');
      const stopped = laneFor(registry, orchestrator, 'stopped');
      registry.markLaneStopped(stopped, 'operator stopped it');
      const types = new Set(drainTypes(registry, orchestrator));
      for (const expected of ['lane_completed', 'lane_failed', 'lane_stopped']) {
        assert.ok(types.has(expected), `no durable wakeup for ${expected}; the three terminal paths must behave alike`);
      }
    } finally {
      registry.stopScheduler();
      await registry.drainPendingWrites();
    }
  });
});

test('draining CONSUMES, so a completion is not re-delivered forever', async () => {
  await inTempDir(async () => {
    const registry = makeRegistry();
    try {
      const orchestrator = await orchestratorFor(registry, 'orc-consume');
      registry.markLaneCompleted(laneFor(registry, orchestrator, 'once only'));
      assert.ok(drainTypes(registry, orchestrator).includes('lane_completed'));
      assert.ok(
        !drainTypes(registry, orchestrator).includes('lane_completed'),
        'a second drain must not return the same completion; an unacked wakeup that never clears is a notification loop',
      );
    } finally {
      registry.stopScheduler();
      await registry.drainPendingWrites();
    }
  });
});
