import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';
import {
  sameExecutionDir,
  findTreeHolders,
  describeTreeConflict,
} from '../src/registry-lane-config.js';

// Stage 7 — sole-writer isolation across orchestrators.
//
// registry-agents.js binds one orchestrator record per (project, lease), so a
// single checkout can carry several live orchestrators. Isolation accounting
// used to be per-container (`lane.sessionId === session.id`), so each of them
// was granted a "sole writer" direct lane and both wrote the same tree.

async function makeRepo(tempDir, name = 'repo') {
  const repoDir = path.join(tempDir, name);
  await fs.mkdir(repoDir, { recursive: true });
  const git = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@local');
  git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repoDir, 'baseline.md'), 'clean\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return await fs.realpath(repoDir);
}

async function twoOrchestrators(registry, cwd) {
  const first = registry.createToolLease({ role: 'orchestrator', actor: 'session-a' });
  const second = registry.createToolLease({ role: 'orchestrator', actor: 'session-b' });
  const alpha = await registry.registerOrchestrator(
    { cwd, actor: 'session-a', title: 'Alpha' },
    { leaseId: first.lease.id },
  );
  const beta = await registry.registerOrchestrator(
    { cwd, actor: 'session-b', title: 'Beta' },
    { leaseId: second.lease.id },
  );
  return { alpha, beta, alphaLease: first.lease, betaLease: second.lease };
}

test('two orchestrators on one checkout cannot both hold a sole-writer direct lane', async () => {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-stage7-'));
  process.chdir(tempDir);
  approveFixtureRoot(tempDir);
  const registry = new OrcaRegistry();
  try {
    const repoDir = await makeRepo(tempDir);
    const { alpha, beta } = await twoOrchestrators(registry, repoDir);
    // Two distinct orchestrator records for ONE project is the precondition the
    // audit named (registry-agents.js allows it, and this change keeps it).
    assert.notEqual(alpha.id, beta.id);
    assert.equal(alpha.projectId, beta.projectId);

    const first = registry.createLane(alpha.id, {
      title: 'Alpha writer',
      executorType: 'mock',
      worktreeMode: 'auto',
    }, { actor: 'session-a', approved: true });
    const alphaLane = registry.getLane(first.id);
    assert.equal(alphaLane.worktreeMode, 'direct');
    assert.equal(alphaLane.workdir, repoDir);

    // Beta asks for exactly the same thing. Before Stage 7 it was granted a
    // second `direct` lane in the very same checkout.
    assert.throws(
      () => registry.createLane(beta.id, {
        title: 'Beta writer',
        executorType: 'mock',
        worktreeMode: 'auto',
      }, { actor: 'session-b', approved: true }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.conflictingLaneId, alphaLane.id);
        assert.equal(error.conflictingOrchestratorId, alpha.id);
        // Actionable: names the tree, the lane, the orchestrator, and the ways out.
        assert.match(error.message, new RegExp(repoDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.message, /Alpha writer/);
        assert.match(error.message, new RegExp(alpha.id));
        assert.match(error.message, /wait for that lane to finish/);
        assert.match(error.message, /worktreeMode "isolated"/);
        assert.match(error.message, /takeoverOrchestratorId/);
        return true;
      },
    );

    // Nothing was provisioned for the refused lane.
    assert.equal((registry.lanes || []).filter((lane) => lane.sessionId === beta.id).length, 0);
  } finally {
    await registry.drainPendingWrites().catch(() => {});
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('a second orchestrator may still take an ISOLATED writer lane on a held checkout', async () => {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-stage7-iso-'));
  process.chdir(tempDir);
  approveFixtureRoot(tempDir);
  const registry = new OrcaRegistry();
  try {
    const repoDir = await makeRepo(tempDir);
    const { alpha, beta } = await twoOrchestrators(registry, repoDir);
    registry.createLane(alpha.id, { title: 'Alpha writer', executorType: 'mock' }, { actor: 'session-a', approved: true });

    // The refusal advertises this escape hatch, so it has to work: worktrees are
    // not forced on everything, but they are always available.
    const betaLane = registry.getLane(registry.createLane(beta.id, {
      title: 'Beta isolated',
      executorType: 'mock',
      worktreeMode: 'isolated',
    }, { actor: 'session-b', approved: true }).id);
    assert.equal(betaLane.worktreeMode, 'isolated');
    assert.notEqual(betaLane.workdir, repoDir);

    // And a read-only lane is never refused — it holds no tree.
    const reader = registry.getLane(registry.createLane(beta.id, {
      title: 'Beta reader',
      executorType: 'mock',
      permissionsProfile: 'read-only',
    }, { actor: 'session-b', approved: true }).id);
    assert.equal(reader.worktreeMode, 'direct');
    assert.equal(reader.workdir, repoDir);
  } finally {
    await registry.drainPendingWrites().catch(() => {});
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('a stale orchestrator does not strand the checkout: takeover restores a direct writer', async () => {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-stage7-takeover-'));
  process.chdir(tempDir);
  approveFixtureRoot(tempDir);
  const registry = new OrcaRegistry();
  try {
    const repoDir = await makeRepo(tempDir);
    const { alpha, beta, alphaLease } = await twoOrchestrators(registry, repoDir);
    const held = registry.getLane(registry.createLane(alpha.id, {
      title: 'Abandoned writer',
      executorType: 'mock',
    }, { actor: 'session-a', approved: true }).id);
    held.state = 'running';

    // Alpha's session dies without resigning: its lease lapses while its lane
    // record still says running, so the lane still holds the tree. This is the
    // shape that could strand a project — a live-looking writer under an owner
    // that is gone. (An idle lastSeenAt alone is NOT stale while a lane is live,
    // by design; the lapsed lease is what marks the owner as gone.)
    const alphaRecord = registry.orchestrators.find((item) => item.id === alpha.id);
    alphaRecord.lastSeenAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const storedLease = registry.toolLeases.find((item) => item.id === alphaLease.id);
    storedLease.expiresAt = new Date(Date.now() - 60 * 1000).toISOString();
    assert.equal(registry._orchestratorStale(alphaRecord), true);

    // Beta is still refused, but the refusal now says the takeover is available.
    assert.throws(
      () => registry.createLane(beta.id, { title: 'Beta writer', executorType: 'mock' }, { actor: 'session-b', approved: true }),
      (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /it is stale, so orchestrator\.register with takeoverOrchestratorId/);
        return true;
      },
    );

    // Taking over hands Beta's lease the abandoned container and its lanes, so
    // the project is not stranded.
    const betaLease = registry.createToolLease({ role: 'orchestrator', actor: 'session-b' });
    const takenOver = await registry.registerOrchestrator(
      { cwd: repoDir, actor: 'session-b', title: 'Beta', takeoverOrchestratorId: alpha.id },
      { leaseId: betaLease.lease.id },
    );
    assert.equal(takenOver.id, alpha.id);
    assert.equal(takenOver.leaseId, betaLease.lease.id);

    // Under the taken-over container the same-orchestrator rule applies again:
    // an overlapping writer auto-isolates instead of being refused.
    const next = registry.getLane(registry.createLane(alpha.id, {
      title: 'Recovered writer',
      executorType: 'mock',
    }, { actor: 'session-b', approved: true }).id);
    assert.equal(next.worktreeMode, 'isolated');
  } finally {
    await registry.drainPendingWrites().catch(() => {});
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('a non-git folder has no worktree to fall back to, so the second writer is refused outright', async () => {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-stage7-plain-'));
  process.chdir(tempDir);
  approveFixtureRoot(tempDir);
  const registry = new OrcaRegistry();
  try {
    const plainDir = path.join(tempDir, 'notes');
    await fs.mkdir(plainDir, { recursive: true });
    const realPlain = await fs.realpath(plainDir);
    const { alpha, beta } = await twoOrchestrators(registry, realPlain);

    const first = registry.getLane(registry.createLane(alpha.id, {
      title: 'Alpha writer',
      executorType: 'mock',
    }, { actor: 'session-a', approved: true }).id);
    assert.equal(first.worktreeMode, 'direct');

    assert.throws(
      () => registry.createLane(beta.id, { title: 'Beta writer', executorType: 'mock' }, { actor: 'session-b', approved: true }),
      (error) => {
        assert.equal(error.status, 409);
        // No git working tree here, so isolation must NOT be offered as a remedy.
        assert.doesNotMatch(error.message, /worktreeMode "isolated"/);
        assert.match(error.message, /wait for that lane to finish/);
        return true;
      },
    );
  } finally {
    await registry.drainPendingWrites().catch(() => {});
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('promoting a read-only lane to a writer respects the other orchestrator holding the tree', async () => {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-stage7-controls-'));
  process.chdir(tempDir);
  approveFixtureRoot(tempDir);
  const registry = new OrcaRegistry();
  try {
    const repoDir = await makeRepo(tempDir);
    const { alpha, beta } = await twoOrchestrators(registry, repoDir);

    // Beta gets its read-only lane first, so both lanes are legitimately direct.
    const reader = registry.getLane(registry.createLane(beta.id, {
      title: 'Beta reader',
      executorType: 'mock',
      permissionsProfile: 'read-only',
    }, { actor: 'session-b', approved: true }).id);
    const writer = registry.getLane(registry.createLane(alpha.id, {
      title: 'Alpha writer',
      executorType: 'mock',
    }, { actor: 'session-a', approved: true }).id);
    assert.equal(reader.worktreeMode, 'direct');
    assert.equal(writer.worktreeMode, 'direct');
    assert.equal(reader.workdir, writer.workdir);
    writer.state = 'running';

    // registry-lane-ops.js carried the same per-container restriction, so this
    // reclassification used to slip a second writer into the same checkout.
    assert.throws(
      () => registry.updateLaneControls(reader.id, { permissionsProfile: 'sandboxed' }, { actor: 'session-b', approved: true }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.conflictingLaneId, writer.id);
        assert.equal(error.conflictingOrchestratorId, alpha.id);
        assert.match(error.message, /Alpha writer/);
        assert.match(error.message, new RegExp(alpha.id));
        return true;
      },
    );
    assert.equal(registry.getLane(reader.id).permissionsProfile, 'read-only');
  } finally {
    await registry.drainPendingWrites().catch(() => {});
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('orchestrator.status names the other orchestrators bound to the same project', async () => {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-stage7-status-'));
  process.chdir(tempDir);
  approveFixtureRoot(tempDir);
  const registry = new OrcaRegistry();
  try {
    const repoDir = await makeRepo(tempDir);
    const { alpha, beta } = await twoOrchestrators(registry, repoDir);

    const alphaStatus = registry.orchestratorStatus(alpha.id);
    assert.equal(alphaStatus.activeOrchestrator.active, true);
    assert.deepEqual(alphaStatus.coOrchestrators.map((item) => item.orchestratorId), [beta.id]);
    assert.equal(alphaStatus.coOrchestrators[0].title, 'Beta');
    assert.equal(alphaStatus.coOrchestrators[0].stale, false);

    const betaStatus = registry.orchestratorStatus(beta.id);
    assert.deepEqual(betaStatus.coOrchestrators.map((item) => item.orchestratorId), [alpha.id]);

    // A resigned peer stops being reported.
    registry.resignOrchestrator(beta.id, {}, { leaseId: registry.orchestrators.find((item) => item.id === beta.id).leaseId });
    assert.deepEqual(registry.orchestratorStatus(alpha.id).coOrchestrators, []);
  } finally {
    await registry.drainPendingWrites().catch(() => {});
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// --- the pure predicates -----------------------------------------------------

test('sameExecutionDir: the same tree collides; a nested project does not', () => {
  assert.equal(sameExecutionDir('/repo', '/repo'), true);
  assert.equal(sameExecutionDir('/repo/', '/repo'), true);
  assert.equal(sameExecutionDir('/repo/./.', '/repo'), true);
  // A monorepo root and one of its apps are two legitimate cwd-keyed projects.
  // Sole-writer is a per-PROJECT guarantee, so nesting is deliberately allowed.
  assert.equal(sameExecutionDir('/repo', '/repo/apps/web'), false);
  assert.equal(sameExecutionDir('/repo/apps/web', '/repo'), false);
  assert.equal(sameExecutionDir('/repo', '/repo-two'), false);
  assert.equal(sameExecutionDir('/repo', ''), false);
  assert.equal(sameExecutionDir('', '/repo'), false);
});

test('findTreeHolders: isolated lanes are excluded by MODE, not by path', () => {
  // workspacesRoot is `<cwd>/.orca/workspaces`, so when Orca orchestrates its own
  // checkout a lane worktree sits INSIDE the project directory. A pure path test
  // would report it as holding the checkout it was branched from.
  const lanes = [
    { id: 'w', sessionId: 'orc_a', workdir: '/repo/.orca/workspaces/orc_a/worktrees/w', worktreeMode: 'isolated', permissionsProfile: 'sandboxed' },
    { id: 'r', sessionId: 'orc_a', workdir: '/repo', worktreeMode: 'direct', permissionsProfile: 'read-only' },
    { id: 'd', sessionId: 'orc_b', workdir: '/repo', worktreeMode: 'direct', permissionsProfile: 'sandboxed' },
    { id: 'x', sessionId: 'orc_b', workdir: '/repo', worktreeMode: 'direct', permissionsProfile: 'sandboxed' },
  ];
  const holders = findTreeHolders({ lanes, directory: '/repo', excludeLaneId: 'x' });
  assert.deepEqual(holders.map((lane) => lane.id), ['d']);
  assert.deepEqual(findTreeHolders({ lanes, directory: '' }).map((lane) => lane.id), []);
  assert.deepEqual(
    findTreeHolders({ lanes, directory: '/repo', isLive: () => false }).map((lane) => lane.id),
    [],
  );
});

test('describeTreeConflict: offers a worktree only when there is a tree to branch', () => {
  const holder = { id: 'lane-1', title: 'Held' };
  const orchestrator = { id: 'orc_1', title: 'Alpha' };
  const git = describeTreeConflict({ holder, holderOrchestrator: orchestrator, directory: '/repo', repoIsGit: true, holderStale: true });
  assert.match(git, /worktreeMode "isolated"/);
  assert.match(git, /it is stale/);
  const plain = describeTreeConflict({ holder, holderOrchestrator: orchestrator, directory: '/notes', repoIsGit: false });
  assert.doesNotMatch(plain, /worktreeMode "isolated"/);
  assert.match(plain, /once it is stale or resigned/);
  // Same-container collisions name no orchestrator: "another orchestrator" would
  // be a lie, and the cross-project scope sentence would be noise.
  const own = describeTreeConflict({ holder, directory: '/repo', repoIsGit: true });
  assert.doesNotMatch(own, /orchestrator/);
  assert.match(own, /lane "Held" \(lane-1\)\. To proceed/);
});
