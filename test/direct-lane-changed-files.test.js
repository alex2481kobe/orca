import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

test('direct lane completion excludes pre-existing and concurrently-added dirty files', async () => {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-direct-changes-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry();

  try {
    const repoDir = path.join(tempDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    const git = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repoDir, 'baseline.md'), 'clean\n');
    await fs.writeFile(path.join(repoDir, 'lane.md'), 'clean\n');
    await fs.writeFile(path.join(repoDir, 'concurrent.md'), 'clean\n');
    git('add', '.');
    git('commit', '-qm', 'init');

    // Dirty before lane creation: this belongs to the shared checkout, not the lane.
    await fs.writeFile(path.join(repoDir, 'baseline.md'), 'dirty before spawn\n');

    const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'test' });
    const orchestrator = await registry.registerOrchestrator(
      { cwd: repoDir, actor: 'test', title: 'Direct changes' },
      { leaseId: lease.id },
    );
    const lane = registry.createLane(orchestrator.id, {
      title: 'Edit one doc',
      executorType: 'mock',
      worktreeMode: 'auto',
    }, { actor: 'test', approved: true });
    const direct = registry.getLane(lane.id);

    assert.equal(direct.worktreeMode, 'direct');
    assert.equal(direct.worktreePath, await fs.realpath(repoDir),
      'direct lanes still have a truthy worktreePath equal to the shared checkout');
    assert.deepEqual(direct.changedFilesBaseline, ['M baseline.md']);

    await fs.writeFile(path.join(repoDir, 'lane.md'), 'written by lane\n');
    // This simulates another actor touching the checkout after the lane started.
    await fs.writeFile(path.join(repoDir, 'concurrent.md'), 'written concurrently\n');

    // Real Codex order: submit while the child is live, then process exit captures
    // terminal artifacts. The executor reports only the path it wrote.
    direct.state = 'running';
    registry.submitLane(direct.id, {
      actor: 'executor',
      summary: 'Edited one doc',
      changedFiles: ['lane.md'],
    });
    registry.markLaneCompleted(direct);
    await registry.drainPendingWrites();

    assert.deepEqual(direct.changedFiles, ['M lane.md']);

    // An isolated lane starts clean and must keep reporting every dirty path in
    // its own worktree, even when its submit payload names only one of them.
    const isolatedLane = registry.createLane(orchestrator.id, {
      title: 'Isolated edit',
      executorType: 'mock',
      worktreeMode: 'isolated',
    }, { actor: 'test', approved: true });
    const isolated = registry.getLane(isolatedLane.id);
    assert.equal(isolated.worktreeMode, 'isolated');
    assert.notEqual(isolated.worktreePath, repoDir);

    await fs.writeFile(path.join(isolated.worktreePath, 'lane.md'), 'isolated edit\n');
    await fs.writeFile(path.join(isolated.worktreePath, 'isolated-only.txt'), 'new\n');
    isolated.state = 'running';
    registry.submitLane(isolated.id, {
      actor: 'executor',
      summary: 'Edited isolated worktree',
      changedFiles: ['lane.md'],
    });
    registry.markLaneCompleted(isolated);
    await registry.drainPendingWrites();

    assert.deepEqual(isolated.changedFiles.sort(), ['?? isolated-only.txt', 'M lane.md']);
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
