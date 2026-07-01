import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-agent-memory-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  try {
    return await callback(registry, tempDir);
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function makeSession(registry) {
  const project = registry.createProject({ name: 'Memory Project' }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, { name: 'Memory Session', leader: 'mock' }, { actor: 'test', approved: true });
  return { project, session };
}

test('agent memory stores bounded compact state per role/actor/lane', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const lane = await registry.createLane(session.id, {
      title: 'Executor lane',
      executorType: 'mock',
      owner: 'executor',
    }, { actor: 'test', approved: true });

    const orchestratorMemory = registry.updateSessionAgentMemory(session.id, {
      statePhase: 'executing',
      currentFocus: 'Prepare alpha hardening with Bearer abc.def.ghi',
      activeWork: Array.from({ length: 20 }, (_, index) => index < 2 ? 'dedupe-me' : `work-${index}`),
      decisions: ['Registry metadata is the memory source of truth.'],
      blockers: ['None'],
      nextActions: ['Run focused tests'],
      risks: ['Memory profile still needs a soak'],
      futureImplementations: ['Optional markdown export later'],
      openQuestions: ['How long should production soaks run?'],
      activeImplementationIds: ['orca-alpha-hardening'],
      handoffNotes: 'Never store a raw transcript here.',
    }, {
      role: 'orchestrator',
      actor: 'Orch One',
    });
    assert.equal(orchestratorMemory.entries.length, 1);
    assert.equal(orchestratorMemory.entries[0].actor, 'orch one');
    assert.ok(orchestratorMemory.entries[0].compactId);
    assert.equal(orchestratorMemory.entries[0].version, 'orca.agent-memory.v2');
    assert.equal(orchestratorMemory.entries[0].statePhase, 'executing');
    assert.equal(orchestratorMemory.entries[0].activeWork.length, 12);
    assert.equal(orchestratorMemory.entries[0].activeWork.filter((item) => item === 'dedupe-me').length, 1);
    assert.equal(orchestratorMemory.entries[0].currentFocus.includes('[redacted]'), true);

    assert.throws(() => registry.updateSessionAgentMemory(session.id, {
      currentFocus: 'bad field',
      transcript: 'this would turn memory into a chat dump',
    }, {
      role: 'orchestrator',
      actor: 'Orch One',
    }), (error) => error?.status === 422 && /Unknown agent memory field/.test(error.message));

    const oldCompactId = orchestratorMemory.entries[0].compactId;
    const merged = registry.updateSessionAgentMemory(session.id, {
      replace: false,
      ifMatch: oldCompactId,
      nextActions: ['Run full test suite'],
    }, {
      role: 'orchestrator',
      actor: 'Orch One',
    });
    assert.notEqual(merged.entries[0].compactId, oldCompactId);
    assert.equal(merged.entries[0].currentFocus.includes('Prepare alpha hardening'), true);
    assert.deepEqual(merged.entries[0].nextActions, ['Run full test suite']);
    assert.throws(() => registry.updateSessionAgentMemory(session.id, {
      ifMatch: oldCompactId,
      currentFocus: 'stale write',
    }, {
      role: 'orchestrator',
      actor: 'Orch One',
    }), (error) => error?.status === 409 && /ifMatch is stale/.test(error.message));

    assert.throws(() => registry.updateSessionAgentMemory(session.id, {
      currentFocus: 'budget',
      handoffNotes: 'x'.repeat(1200),
      activeWork: Array.from({ length: 12 }, (_, index) => `${index}-${'x'.repeat(258)}`),
      decisions: Array.from({ length: 12 }, (_, index) => `${index}-${'y'.repeat(258)}`),
    }, {
      role: 'orchestrator',
      actor: 'Orch One',
    }), (error) => error?.status === 413 && /compact budget/.test(error.message));

    assert.throws(() => registry.updateSessionAgentMemory(session.id, {
      currentFocus: 'executor without lane',
    }, {
      role: 'executor',
      actor: 'exec-a',
    }), (error) => error?.status === 422 && /lane-scoped lease/.test(error.message));

    registry.updateSessionAgentMemory(session.id, {
      currentFocus: 'Implement lane task',
      nextActions: ['Submit concise summary'],
    }, {
      role: 'executor',
      actor: 'exec-a',
      laneId: lane.id,
    });

    const executorOwn = registry.listSessionAgentMemory(session.id, {
      role: 'executor',
      actor: 'exec-a',
      laneId: lane.id,
    });
    assert.deepEqual(executorOwn.entries.map((entry) => entry.role), ['executor']);
    assert.equal(executorOwn.entries[0].laneId, lane.id);

    const otherExecutor = registry.listSessionAgentMemory(session.id, {
      role: 'executor',
      actor: 'exec-b',
      laneId: lane.id,
    });
    assert.deepEqual(otherExecutor.entries, []);

    const supervisor = registry.listSessionAgentMemory(session.id, {
      role: 'supervisor',
      actor: 'sup-a',
    });
    assert.equal(supervisor.entries.length, 2);
    assert.deepEqual(supervisor.entries.map((entry) => entry.role).sort(), ['executor', 'orchestrator']);
  });
});

test('agent memory persists across registry reloads', async () => {
  await withRegistry(async (registry, tempDir) => {
    const { session } = makeSession(registry);
    registry.updateSessionAgentMemory(session.id, {
      currentFocus: 'Persist compact handoff',
      nextActions: ['Resume from memory'],
    }, {
      role: 'orchestrator',
      actor: 'orch-persist',
    });
    await registry.persistState();
    await registry.drainPendingWrites();
    registry.stopScheduler();

    process.chdir(tempDir);
    const reloaded = new OrcaRegistry({ autoAudit: false });
    reloaded.stopScheduler();
    try {
      const memory = reloaded.listSessionAgentMemory(session.id, {
        role: 'orchestrator',
        actor: 'orch-persist',
      });
      assert.equal(memory.entries.length, 1);
      assert.equal(memory.entries[0].currentFocus, 'Persist compact handoff');
    } finally {
      reloaded.stopScheduler();
      await reloaded.drainPendingWrites();
    }
  });
});
