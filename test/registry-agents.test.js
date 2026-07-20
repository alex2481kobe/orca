// v2 data-model coverage: orchestrator/project registration + dedupe/takeover,
// the /api/overview projection with linger, and the v1->v2 fresh-start migration.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { agentMethods } from '../src/registry-agents.js';
import { overviewMethods } from '../src/registry-overview.js';

function mockRegistry(root, liveLeases) {
  return Object.assign(
    {
      projects: [],
      orchestrators: [],
      lanes: [],
      getApprovedRepoRoots: () => [fs.realpathSync(root)],
      _leaseActiveById: (id) => ({ active: liveLeases.has(id) }),
      getStreamRevision: () => 7,
    },
    agentMethods,
    overviewMethods,
  );
}

test('registerOrchestrator creates project-by-cwd and an orchestrator record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agents-'));
  const cwd = path.join(root, 'myproj');
  fs.mkdirSync(cwd);
  const reg = mockRegistry(root, new Set(['L1']));
  const o1 = await reg.registerOrchestrator({ cwd, actor: 'claude', title: 'Auth work' }, { leaseId: 'L1' });
  assert.equal(reg.projects.length, 1);
  assert.equal(reg.projects[0].name, 'myproj');
  assert.ok(reg.projects[0].id.startsWith('prj_'));
  assert.equal(o1.title, 'Auth work');
  assert.ok(o1.id.startsWith('orc_'));
  assert.equal(o1.resignedAt, null);
});

test('live same-actor register makes a new record; stale one dedupes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agents-'));
  const cwd = path.join(root, 'p');
  fs.mkdirSync(cwd);
  const live = new Set(['L1', 'L2', 'L3']);
  const reg = mockRegistry(root, live);
  const o1 = await reg.registerOrchestrator({ cwd, actor: 'claude' }, { leaseId: 'L1' });
  const o2 = await reg.registerOrchestrator({ cwd, actor: 'claude' }, { leaseId: 'L2' });
  assert.notEqual(o1.id, o2.id, 'two live same-actor agents get distinct records');
  assert.equal(reg.orchestrators.length, 2);

  live.delete('L1'); // o1 becomes stale
  assert.equal(reg._orchestratorStale(o1), true);
  const o3 = await reg.registerOrchestrator({ cwd, actor: 'claude' }, { leaseId: 'L3' });
  assert.equal(o3.id, o1.id, 'stale same-actor register reuses the stale record');
  assert.equal(o3.leaseId, 'L3');
  assert.equal(reg.orchestrators.length, 2, 'no new record created on dedupe');
});

test('ownership: mutations require the owning lease; takeover swaps it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agents-'));
  const cwd = path.join(root, 'p');
  fs.mkdirSync(cwd);
  const reg = mockRegistry(root, new Set(['L1', 'L9']));
  const o = await reg.registerOrchestrator({ cwd, actor: 'a' }, { leaseId: 'L1' });
  assert.throws(() => reg.updateOrchestrator(o.id, { title: 'x' }, { leaseId: 'WRONG' }), (e) => e.status === 403);
  assert.throws(() => reg.resignOrchestrator('missing', {}, { leaseId: 'L1' }), (e) => e.status === 404);

  reg.resignOrchestrator(o.id, {}, { leaseId: 'L1' });
  const taken = await reg.registerOrchestrator({ cwd, actor: 'b', takeoverOrchestratorId: o.id }, { leaseId: 'L9' });
  assert.equal(taken.id, o.id, 'takeover keeps the id');
  assert.equal(taken.leaseId, 'L9');
  assert.equal(taken.resignedAt, null);
});

test('registerOrchestrator rejects a cwd outside the approved repo roots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agents-'));
  const reg = mockRegistry(root, new Set(['L1']));
  await assert.rejects(
    reg.registerOrchestrator({ cwd: os.tmpdir(), actor: 'x' }, { leaseId: 'L1' }),
    (e) => e.status === 422,
  );
});

test('buildOverview groups by project and drops long-terminal executors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agents-'));
  const now = new Date().toISOString();
  const reg = mockRegistry(root, new Set(['L1']));
  reg.projects = [{ id: 'p1', name: 'orca', parentName: 'web', cwd: '/x', lastActivityAt: now }];
  reg.orchestrators = [{ id: 'o1', projectId: 'p1', actor: 'claude', title: 'T', focus: 'f', leaseId: 'L1', registeredAt: now, lastSeenAt: now, resignedAt: null }];
  reg.lanes = [
    { id: 'l1', orchestratorId: 'o1', title: 'live', executorType: 'codex', state: 'running', updatedAt: now },
    { id: 'l2', orchestratorId: 'o1', title: 'old', state: 'done', completedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
  ];
  const ov = reg.buildOverview();
  assert.equal(ov.revision, 7);
  assert.equal(ov.projects.length, 1);
  const o = ov.projects[0].orchestrators[0];
  assert.equal(o.executors.length, 1, 'terminal lane completed 10min ago is dropped past the 5min linger');
  assert.equal(o.executors[0].id, 'l1');
  assert.equal(o.executors[0].statusTag, 'working');
  assert.equal(o.executors[0].terminal, false);
});

test('v1 state migrates to a fresh v2 store with a backup and audit, idempotently', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-mig-'));
  fs.mkdirSync(path.join(root, '.orca'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.orca', 'state.json'),
    JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'old' }], sessions: [{ id: 's1' }], lanes: [{ id: 'l1' }] }),
  );
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    const { OrcaRegistry } = await import('../src/registry.js');
    const r = new OrcaRegistry();
    assert.ok(fs.existsSync(path.join(root, '.orca', 'state.json.v1.bak')), 'v1 backup exists');
    assert.equal(r.projects.length, 0, 'projects wiped on migration');
    assert.equal(r.orchestrators.length, 0, 'orchestrators start empty');
    assert.ok(r.auditEvents.some((e) => e.type === 'registry_state_migrated'), 'migration audit recorded');
    const r2 = new OrcaRegistry();
    assert.ok(!r2.auditEvents.some((e) => e.type === 'registry_state_migrated'), 'no re-migration on the now-v2 store');
  } finally {
    process.chdir(previousCwd);
  }
});
