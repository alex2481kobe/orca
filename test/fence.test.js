// Stage 3 (audit P1 #2): the fence means exactly what it says.
//   - An explicit root list is exactly that list; the daemon's working
//     directory gains no authority, for registration or for execution.
//   - Roots are validated real absolute paths; a bad or empty list approves
//     nothing (and says so), it is never silently widened or ignored.
//   - No roots is setup-required: nothing registers, nothing launches, and the
//     refusal names the setup command. Queued work is checked again at launch.
//   - A whole-home root needs a recorded acknowledgement and keeps warning.
//   - Orca still orchestrates work on its own repo when that repo is a root.
//
// Each registry runs in a temp cwd (the stand-in for "the directory the daemon
// was launched from") with ORCA_REPO_ROOTS set per test and restored after.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OrcaRegistry } from '../src/registry.js';

async function withFixture(fn) {
  const previousCwd = process.cwd();
  const saved = {
    ORCA_REPO_ROOTS: process.env.ORCA_REPO_ROOTS,
    ORCA_CODEX_WORKDIR_ROOTS: process.env.ORCA_CODEX_WORKDIR_ROOTS,
  };
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-fence-')));
  const dirs = {
    tmp,
    launch: path.join(tmp, 'launch'),
    project: path.join(tmp, 'project'),
    orca: path.join(tmp, 'orca'),
    sibling: path.join(tmp, 'sibling'),
    other: path.join(tmp, 'other'),
    file: path.join(tmp, 'a-file'),
  };
  for (const key of ['launch', 'project', 'orca', 'sibling', 'other']) await fs.mkdir(dirs[key]);
  await fs.writeFile(dirs.file, '');
  await fs.symlink(dirs.sibling, path.join(dirs.project, 'escape'));
  process.chdir(dirs.launch);
  delete process.env.ORCA_CODEX_WORKDIR_ROOTS;
  const registries = [];
  const open = (options = {}) => {
    const registry = new OrcaRegistry({ autoAudit: false, autoCompleteMs: 60 * 60 * 1000, ...options });
    registry.stopScheduler();
    registries.push(registry);
    return registry;
  };
  const setRoots = (value) => {
    if (value === undefined) delete process.env.ORCA_REPO_ROOTS;
    else process.env.ORCA_REPO_ROOTS = value;
  };
  try {
    await fn({ dirs, open, setRoots });
  } finally {
    for (const registry of registries) {
      registry.stopScheduler();
      await registry.drainPendingWrites();
    }
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function register(registry, cwd, actor = 'fence-test') {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  return registry.registerOrchestrator({ cwd, actor, title: 'Fence' }, { leaseId: lease.id });
}

// createLane may throw synchronously; make every refusal a rejection.
const attempt = (fn) => Promise.resolve().then(fn);

const isSetupRequired = (error) => {
  assert.equal(error.status, 409, JSON.stringify(error));
  assert.equal(error.code, 'ORCA_SETUP_REQUIRED');
  assert.match(error.message, /orca-cli\.js'? setup --roots/, error.message);
  assert.match(error.fix, /orca-cli\.js'? setup --roots/);
  return true;
};

test('an explicit root list is exactly that list: the launch directory gains no authority', async () => {
  await withFixture(async ({ dirs, open, setRoots }) => {
    setRoots(dirs.project);
    const registry = open();
    assert.deepEqual(registry.getApprovedRepoRoots(), [dirs.project]);
    await register(registry, dirs.project);
    await assert.rejects(() => register(registry, dirs.launch), (error) => {
      assert.equal(error.status, 422);
      assert.match(error.message, /outside the approved repo roots/);
      assert.ok(error.message.includes(dirs.launch), error.message);
      assert.match(error.fix, /setup --roots/);
      return true;
    });
  });
});

test('roots must be real absolute directories: relative, missing, file and empty lists approve nothing', async () => {
  await withFixture(async ({ dirs, open, setRoots }) => {
    for (const bad of ['relative/dir', path.join(dirs.tmp, 'missing'), dirs.file, '', ' , ', `${dirs.project},relative`]) {
      setRoots(bad);
      const registry = open();
      assert.deepEqual(registry.getApprovedRepoRoots(), [], `ORCA_REPO_ROOTS=${JSON.stringify(bad)} must approve nothing`);
      const fence = registry.describeFence();
      assert.equal(fence.status, 'invalid', JSON.stringify(fence));
      assert.ok(fence.errors.length > 0);
      await assert.rejects(() => register(registry, dirs.project), isSetupRequired);
    }
  });
});

test('no roots configured is setup-required: nothing registers or spawns, and the refusal names the setup command', async () => {
  await withFixture(async ({ dirs, open, setRoots }) => {
    setRoots(undefined);
    const registry = open();
    assert.deepEqual(registry.getApprovedRepoRoots(), []);
    assert.equal(registry.describeFence().status, 'setup-required');
    await assert.rejects(() => register(registry, dirs.project), isSetupRequired);
    await assert.rejects(() => register(registry, dirs.launch), isSetupRequired);
    const picker = await registry.listWorkstationDirs({});
    assert.deepEqual(picker.roots, [], 'the directory picker offers nothing');
    assert.deepEqual(picker.entries, []);
    assert.equal(registry.buildOverview().fence.status, 'setup-required', 'the dashboard overview carries the fence');
  });
});

async function queueLane(open, setRoots, dirs) {
  setRoots(dirs.project);
  const first = open();
  const orchestrator = await register(first, dirs.project);
  const lane = await first.createLane(orchestrator.id, { title: 'Queued mock', executorType: 'mock' }, { actor: 'fence-test', approved: true });
  assert.equal(first.getLane(lane.id).state, 'queued');
  await first.persistState();
  await first.drainPendingWrites();
  return { orchestrator, lane };
}

test('a lane queued before Orca lost its setup is held in the queue, not launched', async () => {
  await withFixture(async ({ dirs, open, setRoots }) => {
    const { orchestrator, lane } = await queueLane(open, setRoots, dirs);
    setRoots(undefined);
    const restarted = open();
    assert.equal(restarted.getLane(lane.id)?.state, 'queued', 'the restored lane is queued');
    await restarted.advanceLanes();
    await restarted.advanceLanes();
    const held = restarted.getLane(lane.id);
    assert.equal(held.state, 'queued', 'no executor launches while Orca is not set up');
    assert.match(JSON.stringify(held.logs), /setup --roots/, 'the lane says why it is held, once');
    assert.equal(JSON.stringify(held.logs).match(/Held in the queue/g)?.length, 1);
    await assert.rejects(
      () => attempt(() => restarted.createLane(orchestrator.id, { title: 'New', executorType: 'mock' }, { actor: 'fence-test', approved: true })),
      isSetupRequired,
    );
  });
});

test('a lane queued under an earlier fence fails at launch when its directory is outside the current one', async () => {
  await withFixture(async ({ dirs, open, setRoots }) => {
    const { lane } = await queueLane(open, setRoots, dirs);
    setRoots(dirs.other);
    const restarted = open();
    await restarted.advanceLanes();
    const refused = restarted.getLane(lane.id);
    assert.equal(refused.state, 'failed', `state ${refused.state}`);
    assert.match(refused.exitReason, /outside Orca's approved roots/);
  });
});

test("executor adapters get no execution authority from the daemon's working directory", async () => {
  await withFixture(async ({ dirs, open, setRoots }) => {
    setRoots(dirs.project);
    const registry = open();
    const adapter = registry.getExecutorForType('codex');
    assert.ok(!adapter.workdirRoots.some((root) => path.resolve(root) === dirs.launch || path.resolve(root) === path.resolve(process.cwd())),
      `execution roots ${adapter.workdirRoots.join(', ')} must not include the cwd`);
    await assert.rejects(() => adapter._resolveWorkdir(dirs.launch), /outside allowed execution roots/);
    assert.equal(path.resolve(await adapter._resolveWorkdir(dirs.project)), dirs.project);
  });
});

test("self-orchestration: with Orca's own repo in the roots an agent registers there; siblings, traversal and symlink escapes are refused", async () => {
  await withFixture(async ({ dirs, open, setRoots }) => {
    setRoots(`${dirs.project},${dirs.orca}`);
    const registry = open();
    assert.deepEqual(registry.getApprovedRepoRoots(), [dirs.project, dirs.orca]);
    const orchestrator = await register(registry, dirs.orca, 'orca-on-orca');
    assert.ok(orchestrator.id);
    const lane = await registry.createLane(orchestrator.id, { title: 'Work on Orca', executorType: 'mock' }, { actor: 'orca-on-orca', approved: true });
    assert.equal(registry.getLane(lane.id).state, 'queued');
    for (const escape of [dirs.sibling, path.join(dirs.orca, '..', 'sibling'), path.join(dirs.project, 'escape')]) {
      await assert.rejects(() => register(registry, escape), (error) => {
        assert.equal(error.status, 422, escape);
        assert.match(error.message, /outside the approved repo roots/);
        return true;
      });
    }
  });
});

test('a root covering the whole home directory needs a recorded acknowledgement, and warns once acknowledged', async () => {
  const { resolveFence } = await import('../src/fence.js');
  await withFixture(async ({ dirs }) => {
    const home = path.join(dirs.tmp, 'home');
    await fs.mkdir(home);
    for (const roots of [home, dirs.tmp, `${dirs.project},${home}`]) {
      const fence = resolveFence({ env: { ORCA_REPO_ROOTS: roots }, home });
      assert.equal(fence.status, 'invalid', roots);
      assert.deepEqual(fence.roots, []);
      assert.match(fence.summary, /whole home directory/);
      assert.match(fence.summary, /--allow-home-root/);
    }
    const acknowledged = { roots: [home], homeRootAcknowledgedAt: '2026-09-10T12:00:00.000Z' };
    for (const input of [
      { env: {}, config: acknowledged, configPath: '/cfg/config.json' },
      { env: { ORCA_REPO_ROOTS: home }, config: { homeRootAcknowledgedAt: acknowledged.homeRootAcknowledgedAt } },
    ]) {
      const fence = resolveFence({ ...input, home });
      assert.equal(fence.status, 'configured', JSON.stringify(fence));
      assert.equal(fence.homeWide, true);
      assert.deepEqual(fence.roots, [home]);
      assert.equal(fence.warnings.length, 1);
      assert.match(fence.warnings[0], /whole home directory \(acknowledged 2026-09-10T12:00:00.000Z\)/);
    }
    const narrow = resolveFence({ env: {}, config: { roots: [dirs.project] }, home });
    assert.equal(narrow.status, 'configured');
    assert.equal(narrow.source, 'config');
    assert.equal(narrow.homeWide, false);
    assert.deepEqual(narrow.warnings, []);
    assert.equal(resolveFence({ env: {}, configError: 'config.json is not valid', home }).status, 'invalid');
    assert.equal(resolveFence({ env: {}, config: { roots: 'not-a-list' }, home }).status, 'invalid');
    assert.equal(resolveFence({ env: {}, config: {}, home }).status, 'setup-required');
  });
});
