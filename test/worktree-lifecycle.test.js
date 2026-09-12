// "why is orca not auto getting rid of stuff? cause i thought there was a flow
// where the work gets accepted and then the worktree removed so that its not
// taking up space?" — the owner, 2026-09-12.
//
// There was no such flow. `lane.integrate` and `lane.worktree.discard` both
// existed and nothing ever fired either, so 34 lane worktrees from July were
// still on this machine, and a lane retired at runtime left its whole artifacts
// folder in the hot tree for a `gc` run that might never come.
//
// These tests pin the closed loop, and — more importantly — pin what it must
// REFUSE to do. Automatic removal is only ever allowed to take a folder that is
// a redundant second copy of work that lives somewhere else; every case where
// Orca cannot PROVE that keeps the worktree and says why.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { OrcaRegistry } from '../src/registry.js';
import { laneBranchIntegration } from '../src/worktree-manager.js';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';

async function inTempDir(fn) {
  const previousCwd = process.cwd();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-wt-life-'));
  process.chdir(dir);
  approveFixtureRoot(process.cwd());
  try { return await fn(process.cwd()); } finally {
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function withRegistry(fn) {
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  try { return await fn(registry); } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
  }
}

function makeGitRepo(name) {
  const repoDir = path.join(process.cwd(), name);
  fs.mkdirSync(repoDir, { recursive: true });
  const g = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@local'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'hi');
  g('add', 'README.md'); g('commit', '-qm', 'init');
  return { repoDir, g, baseBranch: g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim() };
}

async function isolatedLane(registry, repoDir, { title = 'lane', branch = 'feat' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'owner' });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: repoDir, actor: 'owner', title: 'owner' },
    { leaseId: lease.id },
  );
  const created = registry.createLane(
    orchestrator.id,
    { title, executorType: 'mock', branch, worktreeMode: 'isolated' },
    { actor: 'test', approved: true },
  );
  const lane = registry.getLane(created.id);
  assert.ok(lane.worktreePath, 'the fixture must produce a real isolated worktree');
  lane.state = 'done';
  return { lane, orchestrator };
}

const commitIn = (dir, file, content, message) => {
  fs.writeFileSync(path.join(dir, file), content);
  const gw = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  gw('add', file); gw('commit', '-qm', message);
};

const refExists = (repoDir, ref) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoDir, encoding: 'utf8' }).status === 0;

// ---------------------------------------------------------------------------
// The reclaim that now happens.
// ---------------------------------------------------------------------------

test('accepting a lane whose worktree holds nothing unique reclaims the folder and keeps the branch', async () => {
  await inTempDir(async () => {
    await withRegistry(async (registry) => {
      const { repoDir } = makeGitRepo('clean-repo');
      const { lane } = await isolatedLane(registry, repoDir, { branch: 'scout' });
      const worktreePath = lane.worktreePath;
      assert.equal(fs.existsSync(worktreePath), true);

      const accepted = registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });

      assert.equal(accepted.worktreeCleanup.removed, true, 'a clean, fully-integrated worktree is redundant and goes');
      assert.equal(fs.existsSync(worktreePath), false, 'the folder is off disk');
      assert.equal(registry.getLane(lane.id).worktreePath, '', 'and the lane no longer points at it');
      assert.ok(registry.getLane(lane.id).worktreeReclaimedAt);
      // The BRANCH survives: removal is never allowed to be the thing that
      // destroys a commit, even when there are none to destroy today.
      assert.equal(refExists(repoDir, 'scout'), true, 'the lane branch is never deleted');
      assert.ok(
        registry.auditEvents.some((event) => event.type === 'lane_worktree_reclaimed' && event.laneId === lane.id),
        'the reclaim is on the audit trail',
      );
      // Accepting no longer points at lane.integrate for a lane with nothing left.
      assert.notEqual(accepted.nextAction?.nextRequiredTool, 'lane.integrate');
    });
  });
});

test('un-integrated commits are never removed automatically — the worktree stays and says why', async () => {
  await inTempDir(async () => {
    await withRegistry(async (registry) => {
      const { repoDir, baseBranch } = makeGitRepo('unmerged-repo');
      const { lane } = await isolatedLane(registry, repoDir, { branch: 'work' });
      const worktreePath = lane.worktreePath;
      commitIn(worktreePath, 'feature.txt', 'new feature', 'add feature');

      const accepted = registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });

      assert.equal(accepted.worktreeCleanup.removed, false);
      assert.equal(accepted.worktreeCleanup.unmergedCommits, 1);
      assert.match(accepted.worktreeCleanup.reason, /not in .*(main|master)/);
      assert.equal(accepted.worktreeCleanup.baseBranch, baseBranch);
      assert.equal(fs.existsSync(worktreePath), true, 'work that exists nowhere else must survive an accept');
      assert.equal(registry.getLane(lane.id).worktreePath, worktreePath);
      // A refusal is LOUD: on the record, in the log, and in the reply.
      assert.equal(registry.getLane(lane.id).worktreeReclaim.removed, false);
      assert.ok(
        registry.getLane(lane.id).logs.some((entry) => /worktree kept after audit\.accept/.test(entry.message)),
        'the lane log says the worktree was kept and what to do about it',
      );
      assert.equal(accepted.nextAction?.nextRequiredTool, 'lane.integrate', 'and the reply points at the tool that resolves it');
    });
  });
});

test('uncommitted edits are never removed automatically either', async () => {
  await inTempDir(async () => {
    await withRegistry(async (registry) => {
      const { repoDir } = makeGitRepo('dirty-repo');
      const { lane } = await isolatedLane(registry, repoDir, { branch: 'dirty' });
      const worktreePath = lane.worktreePath;
      // Not committed anywhere: this file exists ONLY in the worktree.
      fs.writeFileSync(path.join(worktreePath, 'scratch.txt'), 'unsaved work');

      const accepted = registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });

      assert.equal(accepted.worktreeCleanup.removed, false);
      assert.equal(accepted.worktreeCleanup.uncommittedChanges, 1);
      assert.match(accepted.worktreeCleanup.reason, /uncommitted change/);
      assert.equal(fs.existsSync(path.join(worktreePath, 'scratch.txt')), true, 'the only copy of the edit is still there');
    });
  });
});

test('integrating an accepted lane reclaims the worktree once the commits are in the base', async () => {
  await inTempDir(async () => {
    await withRegistry(async (registry) => {
      const { repoDir, baseBranch } = makeGitRepo('integrate-repo');
      const { lane } = await isolatedLane(registry, repoDir, { branch: 'shipit' });
      const worktreePath = lane.worktreePath;
      commitIn(worktreePath, 'feature.txt', 'new feature', 'add feature');

      registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });
      assert.equal(fs.existsSync(worktreePath), true, 'accept alone must not have taken it');

      const result = await registry.integrateLane(lane.id);

      assert.equal(result.integrated, true);
      assert.equal(result.worktreeCleanup.removed, true, 'merged work makes the worktree a second copy');
      assert.equal(fs.existsSync(worktreePath), false);
      assert.equal(registry.getLane(lane.id).worktreePath, '');
      // Everything the lane produced is still reachable two ways.
      assert.equal(fs.readFileSync(path.join(repoDir, 'feature.txt'), 'utf8'), 'new feature');
      assert.equal(refExists(repoDir, 'shipit'), true);
      assert.equal(refExists(repoDir, baseBranch), true);
    });
  });
});

test('integrate still works after the worktree is gone — a missing folder is not "could not tell"', async () => {
  await inTempDir(async () => {
    await withRegistry(async (registry) => {
      const { repoDir } = makeGitRepo('post-discard-repo');
      const { lane } = await isolatedLane(registry, repoDir, { branch: 'late' });
      commitIn(lane.worktreePath, 'late.txt', 'late work', 'add late work');
      registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });
      // An explicit discard leaves the branch and clears the path — exactly the
      // state an automatic reclaim leaves behind too.
      await registry.removeLaneWorktree(lane.id, { approved: true, force: true });
      assert.equal(registry.getLane(lane.id).worktreePath, '');

      const result = await registry.integrateLane(lane.id);
      assert.equal(result.integrated, true, 'the branch is still mergeable with no working tree');
      assert.equal(fs.readFileSync(path.join(repoDir, 'late.txt'), 'utf8'), 'late work');
    });
  });
});

test('ORCA_AUTO_RECLAIM_WORKTREE=false leaves every worktree exactly where it was', async () => {
  await inTempDir(async () => {
    const previous = process.env.ORCA_AUTO_RECLAIM_WORKTREE;
    process.env.ORCA_AUTO_RECLAIM_WORKTREE = 'false';
    try {
      await withRegistry(async (registry) => {
        const { repoDir } = makeGitRepo('optout-repo');
        const { lane } = await isolatedLane(registry, repoDir, { branch: 'kept' });
        const worktreePath = lane.worktreePath;
        const accepted = registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });
        assert.equal(accepted.worktreeCleanup.disabled, true);
        assert.equal(accepted.worktreeCleanup.removed, false);
        assert.equal(fs.existsSync(worktreePath), true);
        assert.equal(registry.getLane(lane.id).worktreePath, worktreePath);
      });
    } finally {
      if (previous === undefined) delete process.env.ORCA_AUTO_RECLAIM_WORKTREE;
      else process.env.ORCA_AUTO_RECLAIM_WORKTREE = previous;
    }
  });
});

test('a direct lane has no managed worktree, and accept does not go near the repo checkout', async () => {
  await inTempDir(async () => {
    await withRegistry(async (registry) => {
      const { repoDir } = makeGitRepo('direct-repo');
      const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'owner' });
      const orchestrator = await registry.registerOrchestrator(
        { cwd: repoDir, actor: 'owner', title: 'owner' },
        { leaseId: lease.id },
      );
      const created = registry.createLane(
        orchestrator.id,
        { title: 'inplace', executorType: 'mock', worktreeMode: 'direct' },
        { actor: 'test', approved: true },
      );
      registry.getLane(created.id).state = 'done';
      const accepted = registry.acceptLaneAudit(created.id, { actor: 'auditor', findings: ['reviewed'] });
      assert.equal(accepted.worktreeCleanup.applicable, false);
      assert.equal(accepted.worktreeCleanup.removed, false);
      assert.equal(fs.existsSync(path.join(repoDir, 'README.md')), true, 'the repo checkout is untouched');
    });
  });
});

// ---------------------------------------------------------------------------
// The probe the automatic path leans on, on its own. countUnmergedCommits
// answers 0 for every one of these; this one must not.
// ---------------------------------------------------------------------------

test('laneBranchIntegration fails CLOSED wherever git cannot answer', async () => {
  await inTempDir(async () => {
    const { repoDir, baseBranch } = makeGitRepo('probe-repo');
    const g = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });

    assert.deepEqual(
      { ok: laneBranchIntegration({ repoRoot: repoDir, branch: 'nope' }).ok },
      { ok: false },
      'a branch that is not in the repo is not "nothing unmerged"',
    );
    assert.equal(laneBranchIntegration({ repoRoot: repoDir, branch: '' }).ok, false);
    assert.equal(laneBranchIntegration({ repoRoot: path.join(repoDir, 'nowhere'), branch: 'x' }).ok, false);

    g('branch', 'ahead');
    const gw = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    // A branch that IS the base, and a branch with real commits on it.
    assert.deepEqual(
      laneBranchIntegration({ repoRoot: repoDir, branch: baseBranch }),
      { ok: true, unmerged: 0, baseBranch, branch: baseBranch },
    );
    g('checkout', '-q', 'ahead');
    fs.writeFileSync(path.join(repoDir, 'more.txt'), 'more');
    gw('add', 'more.txt'); gw('commit', '-qm', 'more');
    g('checkout', '-q', baseBranch);
    const behind = laneBranchIntegration({ repoRoot: repoDir, branch: 'ahead' });
    assert.equal(behind.ok, true);
    assert.equal(behind.unmerged, 1);

    // Detached HEAD in the repo root: there is no base branch to compare with,
    // so the honest answer is "cannot tell", not 0.
    g('checkout', '-q', '--detach');
    assert.equal(laneBranchIntegration({ repoRoot: repoDir, branch: 'ahead' }).ok, false);
    assert.match(laneBranchIntegration({ repoRoot: repoDir, branch: 'ahead' }).reason, /detached/);
  });
});

// ---------------------------------------------------------------------------
// Artifacts follow their lane at RUNTIME archival, not only under gc.
// ---------------------------------------------------------------------------

test('a lane retired at runtime takes its artifacts with it, and the archive says where', async () => {
  await inTempDir(async () => {
    await withRegistry(async (registry) => {
      const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'owner' });
      const orchestrator = await registry.registerOrchestrator(
        { cwd: process.cwd(), actor: 'owner', title: 'owner' },
        { leaseId: lease.id },
      );
      const created = registry.createLane(orchestrator.id, { title: 'noisy', executorType: 'mock' }, { actor: 'test', approved: true });
      const lane = registry.getLane(created.id);
      registry.appendLaneAgentEvent(lane, { type: 'message.assistant.final', source: 'mock', content: 'the whole report' });
      registry.markLaneCompleted(lane);
      await registry.drainPendingWrites();

      const hotDir = path.join(registry.artifactRoot, lane.sessionId, lane.id);
      assert.equal(fs.existsSync(path.join(hotDir, 'outcome.txt')), true, 'the fixture must produce real artifacts');
      assert.equal(fs.existsSync(path.join(hotDir, 'result.txt')), true);

      await registry.deleteLane(lane.id, { actor: 'test' });
      await registry.drainPendingWrites();

      // The hot folder is GONE — not deleted, moved.
      assert.equal(fs.existsSync(hotDir), false, 'artifacts must not be left in the hot tree once the lane is archived');
      const archived = path.join(registry.storageDir, 'archive', 'artifacts', lane.sessionId, lane.id);
      assert.equal(fs.existsSync(path.join(archived, 'outcome.txt')), true);
      assert.equal(fs.readFileSync(path.join(archived, 'result.txt'), 'utf8').trim(), 'the whole report');
      assert.equal(fs.existsSync(path.join(archived, '.orca-archived.json')), true, 'gc lists archived artifacts by this marker');

      // lane.get on the archived lane SAYS where they went. Before this, the API
      // simply 404'd on artifacts of an archived lane with no explanation:
      // readArtifactFile resolves through getLane(), which cannot see one.
      const read = registry.readArchivedLane(lane.id);
      assert.equal(read.status, 200);
      assert.equal(read.body.archived.artifacts.hasResult, true);
      assert.match(read.body.archived.artifacts.file, /^archive\/artifacts\//);
      assert.ok(read.body.archived.artifacts.bytes > 0);

      // And the index on disk carries it too, so a restarted daemon still knows.
      const saved = JSON.parse(fs.readFileSync(registry.stateFile, 'utf8'));
      assert.match(saved.archivedLanes.find((entry) => entry.id === lane.id).artifacts.file, /^archive\/artifacts\//);
    });
  });
});
