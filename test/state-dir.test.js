// Stage 4: a daemon owned by nobody needs a state directory that does not depend
// on whichever directory launched it. src/orca-paths.js is the one resolver:
// ORCA_STATE_DIR > the config file > an existing <checkout>/.orca (kept in
// place) > the per-user default. Lane artifacts follow the state directory.
//
// Every daemon here runs on temp state with ORCA_STATE_DIR pinned, a temp HOME
// and a free port; the per-user default is checked through the pure resolver
// with an injected checkout, never by starting a daemon that could adopt a real
// checkout's .orca.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OrcaRegistry } from '../src/registry.js';
import { ROOT, cleanChildEnv, freePort } from './helpers/bridge-client.js';

const SERVER = path.join(ROOT, 'src', 'server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempRoot(label) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `orca-state-${label}-`)));
}

async function waitFor(predicate, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('the daemon keeps its state in ORCA_STATE_DIR, and creates nothing in the directory it was launched from', { timeout: 60_000 }, async () => {
  const tmp = await tempRoot('daemon');
  const launch = path.join(tmp, 'launch');
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  const state = path.join(tmp, 'state');
  await Promise.all([launch, home, project].map((dir) => fs.mkdir(dir)));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: launch,
    env: {
      ...cleanChildEnv(),
      HOME: home,
      PORT: String(port),
      ORCA_HOST: '127.0.0.1',
      ORCA_STATE_DIR: state,
      ORCA_REPO_ROOTS: project,
      ORCA_AUTO_AUDIT: 'false',
      ORCA_CREDENTIAL_BACKEND: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    await waitFor(() => output.includes(`Orca listening at http://127.0.0.1:${port}`) || child.exitCode !== null, 'the daemon to listen');
    assert.equal(child.exitCode, null, output);
    assert.ok(fsSync.existsSync(path.join(state, 'daemon.lock')), `the instance lock is in ORCA_STATE_DIR:\n${output}`);
    assert.ok(fsSync.existsSync(path.join(state, 'workspaces')), 'workspaces live in the state directory');
    assert.ok(fsSync.existsSync(path.join(state, 'artifacts')), 'artifacts live in the state directory');
    assert.deepEqual(await fs.readdir(launch), [], 'the launch directory gains no .orca and no artifacts');
    assert.ok(output.includes(`State directory: ${state}`), output);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
  assert.equal(fsSync.existsSync(path.join(state, 'daemon.lock')), false, 'a stopped daemon releases its lock');
});

test('a registry given a state directory keeps state, workspaces and lane artifacts there, not in its cwd', { timeout: 30_000 }, async () => {
  const tmp = await tempRoot('registry');
  const cwd = path.join(tmp, 'cwd');
  const project = path.join(tmp, 'project');
  const stateDir = path.join(tmp, 'state');
  await Promise.all([cwd, project].map((dir) => fs.mkdir(dir)));
  const previousCwd = process.cwd();
  const previousRoots = process.env.ORCA_REPO_ROOTS;
  process.chdir(cwd);
  process.env.ORCA_REPO_ROOTS = project;
  const registry = new OrcaRegistry({ stateDir, autoAudit: false, autoCompleteMs: 50, heartbeatIntervalMs: 25 });
  try {
    assert.equal(registry.storageDir, stateDir);
    assert.equal(registry.workspacesRoot, path.join(stateDir, 'workspaces'));
    assert.equal(registry.artifactRoot, path.join(stateDir, 'artifacts'));
    const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'state-dir' });
    const orchestrator = await registry.registerOrchestrator({ cwd: project, actor: 'state-dir', title: 'State dir' }, { leaseId: lease.id });
    const lane = await registry.createLane(orchestrator.id, { title: 'Mock lane', executorType: 'mock' }, { actor: 'state-dir', approved: true });
    const outcome = path.join(stateDir, 'artifacts', orchestrator.id, lane.id, 'outcome.txt');
    await waitFor(() => fsSync.existsSync(outcome), `the lane's outcome at ${outcome}`, 15_000);
    registry.stopScheduler();
    await registry.drainPendingWrites();
    assert.ok(fsSync.existsSync(path.join(stateDir, 'state.json')), 'state.json is in the state directory');
    assert.deepEqual(await fs.readdir(cwd), [], 'the cwd gains no .orca and no artifacts');
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    process.chdir(previousCwd);
    if (previousRoots === undefined) delete process.env.ORCA_REPO_ROOTS; else process.env.ORCA_REPO_ROOTS = previousRoots;
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('state dir resolution: ORCA_STATE_DIR, then the config file, then an existing checkout .orca, then the per-user default', async () => {
  const { resolveStateDir, defaultStateDir } = await import('../src/orca-paths.js');
  const tmp = await tempRoot('resolve');
  const home = path.join(tmp, 'home');
  const checkout = path.join(tmp, 'checkout');
  const other = path.join(tmp, 'other');
  await Promise.all([home, checkout, other].map((dir) => fs.mkdir(dir)));
  try {
    const fresh = { env: {}, home, orcaDir: checkout, config: null };
    assert.deepEqual(resolveStateDir(fresh), { dir: path.join(home, '.local', 'state', 'orca'), source: 'default' });
    assert.equal(defaultStateDir({ env: {}, home }), path.join(home, '.local', 'state', 'orca'));
    assert.deepEqual(resolveStateDir({ ...fresh, env: { XDG_STATE_HOME: path.join(tmp, 'xdg') } }).dir, path.join(tmp, 'xdg', 'orca'));
    assert.equal(resolveStateDir({ ...fresh, env: { XDG_STATE_HOME: 'relative' } }).source, 'default', 'a relative XDG value is ignored');

    // An install from before the resolver keeps its state where it is.
    await fs.mkdir(path.join(checkout, '.orca'));
    await fs.writeFile(path.join(checkout, '.orca', 'state.json'), '{}');
    assert.deepEqual(resolveStateDir(fresh), { dir: path.join(checkout, '.orca'), source: 'legacy-checkout' });

    assert.deepEqual(resolveStateDir({ ...fresh, config: { stateDir: other } }), { dir: other, source: 'config' });
    assert.deepEqual(
      resolveStateDir({ ...fresh, config: { stateDir: other }, env: { ORCA_STATE_DIR: path.join(tmp, 'pinned') } }),
      { dir: path.join(tmp, 'pinned'), source: 'ORCA_STATE_DIR' },
    );
    assert.throws(() => resolveStateDir({ ...fresh, env: { ORCA_STATE_DIR: 'relative/state' } }), /ORCA_STATE_DIR must be an absolute path/);
    assert.throws(() => resolveStateDir({ ...fresh, config: { stateDir: 'relative' } }), /absolute path/);

    // The directory a command runs in never changes the answer.
    const previousCwd = process.cwd();
    try {
      process.chdir(home);
      const fromHome = resolveStateDir(fresh);
      process.chdir(other);
      assert.deepEqual(resolveStateDir(fresh), fromHome);
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('config dir: ORCA_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config/orca; the config is written owner-only', async () => {
  const { resolveConfigDir, readConfig, writeConfig } = await import('../src/orca-paths.js');
  const tmp = await tempRoot('config');
  try {
    const home = path.join(tmp, 'home');
    assert.equal(resolveConfigDir({ env: {}, home }), path.join(home, '.config', 'orca'));
    assert.equal(resolveConfigDir({ env: { XDG_CONFIG_HOME: path.join(tmp, 'xdg') }, home }), path.join(tmp, 'xdg', 'orca'));
    assert.equal(resolveConfigDir({ env: { ORCA_CONFIG_DIR: path.join(tmp, 'pinned') }, home }), path.join(tmp, 'pinned'));
    assert.throws(() => resolveConfigDir({ env: { ORCA_CONFIG_DIR: 'relative' }, home }), /absolute path/);

    const options = { env: {}, home };
    assert.deepEqual(readConfig(options), { path: path.join(home, '.config', 'orca', 'config.json'), config: null, error: null });
    const file = writeConfig({ roots: ['/a'] }, options);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.deepEqual(readConfig(options).config, { schema: 'orca.config.v1', roots: ['/a'] });
    await fs.writeFile(file, 'not json');
    assert.match(readConfig(options).error, /not a valid Orca config/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('artifacts follow the state directory; the original .orca layout keeps them beside it', async () => {
  const { artifactDirFor, daemonLogPath } = await import('../src/orca-paths.js');
  assert.equal(artifactDirFor('/srv/orca/.orca'), '/srv/orca/artifacts');
  assert.equal(artifactDirFor('/home/me/.local/state/orca'), '/home/me/.local/state/orca/artifacts');
  assert.equal(daemonLogPath('/home/me/.local/state/orca'), '/home/me/.local/state/orca/logs/daemon.log');
});
