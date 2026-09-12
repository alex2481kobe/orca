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
      assertFenceConfigured() { return { roots: this.getApprovedRepoRoots() }; },
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

test('buildOverview groups by project, ranks live first, and marks stale executors', () => {
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
  // Recency ranks and dims; it no longer deletes. Both lanes are projected, the
  // live one first, and the 10-minute-old terminal one is flagged, not dropped.
  assert.equal(o.executors.length, 2, 'a terminal lane past the 5min window is kept, marked, not dropped');
  assert.equal(o.executorCount, 2);
  assert.equal(o.executorsOmitted, 0);
  assert.equal(o.executors[0].id, 'l1');
  assert.equal(o.executors[0].statusTag, 'working');
  assert.equal(o.executors[0].terminal, false);
  assert.equal(o.executors[0].recent, true);
  assert.equal(o.executors[1].id, 'l2');
  assert.equal(o.executors[1].terminal, true);
  assert.equal(o.executors[1].recent, false, 'the old terminal lane is flagged as not recent');
});

// docs/audits/2026-09-11-overview-empty.md: the live daemon held 3 projects, 11
// orchestrators and 86 lanes — every lane terminal, nothing touched for hours —
// and /api/overview answered `projects: []`. That is the shape reproduced here.
test('an all-terminal, all-stale state still yields a non-empty overview', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agents-'));
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const reg = mockRegistry(root, new Set()); // no live leases: every orchestrator is stale
  reg.projects = [
    { id: 'p1', name: 'orca', parentName: 'web', cwd: '/x', lastActivityAt: old },
    { id: 'p2', name: 'realm-shaper', parentName: 'web', cwd: '/y', lastActivityAt: old },
  ];
  reg.orchestrators = [
    { id: 'o1', projectId: 'p1', actor: 'claude', title: 'A', leaseId: 'GONE', registeredAt: old, lastSeenAt: old, resignedAt: null },
    { id: 'o2', projectId: 'p1', actor: 'codex', title: 'B', leaseId: 'dashboard', registeredAt: old, lastSeenAt: old, resignedAt: old },
    { id: 'o3', projectId: 'p2', actor: 'claude', title: 'C', leaseId: 'dashboard', registeredAt: old, lastSeenAt: old, resignedAt: null },
  ];
  reg.lanes = [
    { id: 'l1', orchestratorId: 'o1', title: 'done work', executorType: 'codex', state: 'done', completedAt: old, updatedAt: old },
    { id: 'l2', orchestratorId: 'o1', title: 'failed work', executorType: 'codex', state: 'failed', completedAt: old, updatedAt: old },
    { id: 'l3', orchestratorId: 'o2', title: 'accepted work', executorType: 'claude', state: 'accepted', completedAt: old, updatedAt: old },
    { id: 'l4', orchestratorId: 'o3', title: 'stopped work', executorType: 'claude', state: 'stopped', completedAt: old, updatedAt: old },
  ];

  const ov = reg.buildOverview();
  assert.equal(ov.projects.length, 2, 'a state holding projects must never project as an empty dashboard');
  // The dashboard's own endpoint now carries the totals /api/health reports, so
  // the two can be compared instead of silently disagreeing.
  assert.deepEqual(ov.counts, {
    projects: 2,
    orchestrators: 3,
    lanes: 4,
    shownProjects: 2,
    shownOrchestrators: 3,
    shownExecutors: 4,
  });
  const p1 = ov.projects.find((project) => project.id === 'p1');
  assert.equal(p1.orchestrators.length, 2, 'a stale and a resigned orchestrator both stay visible');
  assert.equal(p1.executorCount, 3);
  const o1 = p1.orchestrators.find((orchestrator) => orchestrator.id === 'o1');
  assert.equal(o1.stale, true);
  assert.equal(o1.inactive, true);
  assert.equal(o1.recent, false);
  assert.equal(o1.executors.length, 2);
  const o2 = p1.orchestrators.find((orchestrator) => orchestrator.id === 'o2');
  assert.equal(o2.resigned, true);
  assert.equal(o2.executors.length, 1, 'a resigned orchestrator still shows the work it left behind');
});

test('buildOverview bounds retired executors per orchestrator and reports what it left out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agents-'));
  const now = new Date().toISOString();
  const reg = mockRegistry(root, new Set(['L1']));
  reg.projects = [{ id: 'p1', name: 'orca', parentName: 'web', cwd: '/x', lastActivityAt: now }];
  reg.orchestrators = [{ id: 'o1', projectId: 'p1', actor: 'claude', title: 'T', leaseId: 'L1', registeredAt: now, lastSeenAt: now, resignedAt: null }];
  reg.lanes = Array.from({ length: 40 }, (_, index) => ({
    id: `l${index}`,
    orchestratorId: 'o1',
    title: `lane ${index}`,
    executorType: 'codex',
    state: 'done',
    completedAt: new Date(Date.now() - index * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - index * 60 * 1000).toISOString(),
  }));
  const o = reg.buildOverview().projects[0].orchestrators[0];
  assert.equal(o.executorCount, 40);
  assert.equal(o.executors.length, 25);
  assert.equal(o.executorsOmitted, 15, 'what the window leaves out is counted, never silently dropped');
  assert.equal(o.executors[0].id, 'l0', 'newest first');
});

test('buildOverview never omits a live executor, however many retired ones there are', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agents-'));
  const now = new Date().toISOString();
  const reg = mockRegistry(root, new Set(['L1']));
  reg.projects = [{ id: 'p1', name: 'orca', parentName: 'web', cwd: '/x', lastActivityAt: now }];
  reg.orchestrators = [{ id: 'o1', projectId: 'p1', actor: 'claude', title: 'T', leaseId: 'L1', registeredAt: now, lastSeenAt: now, resignedAt: null }];
  reg.lanes = [
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `old${index}`, orchestratorId: 'o1', title: 'old', state: 'done', completedAt: now, updatedAt: now,
    })),
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `live${index}`, orchestratorId: 'o1', title: 'live', state: 'running', updatedAt: now,
    })),
  ];
  const o = reg.buildOverview().projects[0].orchestrators[0];
  assert.equal(o.liveExecutorCount, 30);
  assert.equal(o.executors.filter((lane) => !lane.terminal).length, 30, 'all 30 live lanes are projected');
});

test('registerOrchestrator works against a real registry with a real lease + shows in overview', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reg-'));
  const realRoot = fs.realpathSync(root);
  const prevRoots = process.env.ORCA_REPO_ROOTS;
  const prevCwd = process.cwd();
  process.env.ORCA_REPO_ROOTS = realRoot; // make the temp cwd an approved repo root
  process.chdir(root);
  try {
    const { OrcaRegistry } = await import('../src/registry.js');
    const reg = new OrcaRegistry({ autoAudit: false });
    reg.stopScheduler();
    const { lease } = reg.createToolLease({ role: 'orchestrator', actor: 'claude-code', allowedTools: ['orchestrator.register'] });
    const orch = await reg.registerOrchestrator({ cwd: realRoot, actor: 'claude-code', title: 'v2', focus: 'wiring' }, { leaseId: lease.id });
    assert.ok(orch.id.startsWith('orc_'));
    assert.equal(orch.leaseId, lease.id);
    assert.equal(reg._orchestratorStale(orch), false, 'a freshly-registered orchestrator with a live lease is not stale');
    const ov = reg.buildOverview();
    assert.equal(ov.projects.length, 1);
    assert.equal(ov.projects[0].name, path.basename(realRoot));
    assert.equal(ov.projects[0].orchestrators[0].title, 'v2');
    reg.stopScheduler();
    await reg.drainPendingWrites();
  } finally {
    if (prevRoots === undefined) delete process.env.ORCA_REPO_ROOTS; else process.env.ORCA_REPO_ROOTS = prevRoots;
    process.chdir(prevCwd);
  }
});

test('an executor lane spawned under an orchestrator groups under it in the overview', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-spawn-'));
  const realRoot = fs.realpathSync(root);
  const prevRoots = process.env.ORCA_REPO_ROOTS;
  const prevCwd = process.cwd();
  process.env.ORCA_REPO_ROOTS = realRoot;
  process.chdir(root);
  try {
    const { OrcaRegistry } = await import('../src/registry.js');
    const reg = new OrcaRegistry({ autoAudit: false, autoCompleteMs: 60 * 60 * 1000 });
    reg.stopScheduler();
    const { lease } = reg.createToolLease({ role: 'orchestrator', actor: 'claude', allowedTools: ['orchestrator.register', 'executor.spawn'] });
    const orch = await reg.registerOrchestrator({ cwd: realRoot, actor: 'claude', title: 't' }, { leaseId: lease.id });
    // getSession resolves the orchestrator as a lane container (workdir = cwd).
    const container = reg.getSession(orch.id);
    assert.equal(container.orchestratorId, orch.id);
    assert.equal(container.repoRoot, realRoot);
    const lane = await reg.createLane(orch.id, { title: 'build', executorType: 'mock', taskPrompt: 'x' }, { actor: 'claude', approved: true });
    assert.equal(lane.orchestratorId, orch.id, 'lane carries orchestratorId');
    const ov = reg.buildOverview();
    const execs = ov.projects[0].orchestrators[0].executors;
    assert.equal(execs.length, 1);
    assert.equal(execs[0].title, 'build');
    reg.stopScheduler();
    await reg.drainPendingWrites();
  } finally {
    if (prevRoots === undefined) delete process.env.ORCA_REPO_ROOTS; else process.env.ORCA_REPO_ROOTS = prevRoots;
    process.chdir(prevCwd);
  }
});

test('the scheduler launches a queued executor under an orchestrator to completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-run-'));
  const realRoot = fs.realpathSync(root);
  const prevRoots = process.env.ORCA_REPO_ROOTS;
  const prevCwd = process.cwd();
  process.env.ORCA_REPO_ROOTS = realRoot;
  process.chdir(root);
  try {
    const { OrcaRegistry } = await import('../src/registry.js');
    const reg = new OrcaRegistry({ autoAudit: false, heartbeatIntervalMs: 100, autoCompleteMs: 300 });
    const { lease } = reg.createToolLease({ role: 'orchestrator', actor: 'claude', allowedTools: ['orchestrator.register', 'executor.spawn'] });
    const orch = await reg.registerOrchestrator({ cwd: realRoot, actor: 'claude', title: 't' }, { leaseId: lease.id });
    const lane = await reg.createLane(orch.id, { title: 'run me', executorType: 'mock', taskPrompt: 'x' }, { actor: 'claude', approved: true });
    assert.equal(lane.state, 'queued');
    const done = new Set(['done', 'ready_for_audit', 'accepted']);
    for (let i = 0; i < 60 && !done.has(reg.getLane(lane.id).state); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const final = reg.getLane(lane.id);
    assert.ok(done.has(final.state), `mock lane should complete, got ${final.state}`);
    assert.equal(final.orchestratorId, orch.id, 'orchestratorId preserved through the run');
    reg.stopScheduler();
    await reg.drainPendingWrites();
  } finally {
    if (prevRoots === undefined) delete process.env.ORCA_REPO_ROOTS; else process.env.ORCA_REPO_ROOTS = prevRoots;
    process.chdir(prevCwd);
  }
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
