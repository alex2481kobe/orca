import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { OrcaRegistry } from '../src/registry.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-lifecycle-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  try { return await callback(registry); } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

// v2: the orchestrator RECORD is the lane container (no session records). It is
// registered against the (approved) temp cwd; lanes hang off its orc_ id and
// carry sessionId === orchestrator.id through the getSession() container bridge.
async function setup(registry, { actor = 'test', title = 'Lifecycle' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
}
const makeLane = (registry, orchestratorId) => registry.createLane(orchestratorId, { title: 'L', executorType: 'mock' }, { actor: 'test', approved: true });

test('terminal handlers are idempotent (stop racing complete cannot double-fire)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    registry.markLaneCompleted(registry.getLane(lane.id));
    assert.equal(registry.getLane(lane.id).state, 'done');
    // A late stop must NOT re-terminalize the already-done lane.
    registry.markLaneStopped(registry.getLane(lane.id), { actor: 'test' });
    assert.equal(registry.getLane(lane.id).state, 'done');
    assert.equal(registry.auditEvents.filter((e) => e.type === 'lane_stopped' && e.laneId === lane.id).length, 0);
  });
});

test('stopAllExecutors kills every live executor child (shutdown sweep)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    await registry.getExecutorForType('mock').start(registry.getLane(lane.id));
    assert.equal(registry.getRunningCountForSession(orchestrator.id), 1);
    await registry.stopAllExecutors('test');
    assert.equal(registry.getRunningCountForSession(orchestrator.id), 0);
  });
});

test('acceptLaneAudit refuses a still-running lane (dashboard path)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    await registry.getExecutorForType('mock').start(registry.getLane(lane.id));
    registry.getLane(lane.id).state = 'running';
    assert.throws(() => registry.acceptLaneAudit(lane.id, { actor: 'dashboard' }), (e) => e.status === 409);
    // A terminal lane accepts fine.
    registry.getLane(lane.id).state = 'done';
    const r = registry.acceptLaneAudit(lane.id, { actor: 'dashboard', findings: ['reviewed'] });
    assert.equal(r.lane.state, 'accepted');
  });
});

test('pruneInMemoryRecords caps terminal lanes per orchestrator container (bounds growth)', async () => {
  const prev = process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
  process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = '2';
  try {
    await withRegistry(async (registry) => {
      const { orchestrator } = await setup(registry);
      for (let i = 0; i < 5; i += 1) {
        const lane = makeLane(registry, orchestrator.id);
        registry.markLaneCompleted(registry.getLane(lane.id)); // -> done (terminal)
      }
      assert.equal(registry.lanes.filter((l) => l.sessionId === orchestrator.id).length, 5);
      assert.equal(registry.pruneInMemoryRecords(), true);
      assert.equal(registry.lanes.filter((l) => l.sessionId === orchestrator.id).length, 2);
    });
  } finally {
    if (prev === undefined) delete process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
    else process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = prev;
  }
});

test('deleteLane removes a terminal lane (and refuses a live one)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    // Live lane cannot be deleted.
    const live = makeLane(registry, orchestrator.id);
    await registry.getExecutorForType('mock').start(registry.getLane(live.id));
    registry.getLane(live.id).state = 'running';
    await assert.rejects(() => registry.deleteLane(live.id, { actor: 'test' }), (e) => e.status === 422);
    // Terminal lane can be deleted; runtime maps cleared.
    const done = makeLane(registry, orchestrator.id);
    registry.ensureLaneToolLease(registry.getLane(done.id));
    registry.markLaneCompleted(registry.getLane(done.id)); // -> done
    const result = await registry.deleteLane(done.id, { actor: 'test' });
    assert.equal(result.deleted, true);
    assert.equal(registry.getLane(done.id), undefined);
    assert.equal(registry.laneRuntimeEnv.has(String(done.id)), false);
  });
});

test('acceptLaneAudit overrides an escalated audit (clears the dead end)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    registry.markLaneCompleted(registry.getLane(lane.id));
    registry.queueLaneAudit(lane.id, { actor: 'auditor', approved: true });
    // Exhaust the loop budget -> escalated.
    registry.requestLaneFix(lane.id, { actor: 'auditor', findings: ['x'] });
    registry.requestLaneFix(lane.id, { actor: 'auditor', findings: ['still'] });
    assert.equal(registry.getLane(lane.id).auditState, 'escalated');
    // Operator override accepts it.
    registry.acceptLaneAudit(lane.id, { actor: 'dashboard', findings: ['override'] });
    assert.equal(registry.getLane(lane.id).state, 'accepted');
    assert.equal(registry.getLane(lane.id).auditState, 'accepted');
  });
});

test('deleting an orchestrator-container project stops a running lane and clears its runtime maps (no orphan)', async () => {
  await withRegistry(async (registry) => {
    // v2 has no deleteSession; the orchestrator container is torn down when its
    // (archived) project is permanently deleted. deleteProject sweeps every
    // container lane: it kills the live child, drops the record, and reclaims the
    // managed worktree — the orchestrator-native replacement for deleteSession.
    const { orchestrator } = await setup(registry);
    const lane = makeLane(registry, orchestrator.id);
    registry.ensureLaneToolLease(registry.getLane(lane.id));
    await registry.getExecutorForType('mock').start(registry.getLane(lane.id));
    assert.equal(registry.laneRuntimeEnv.has(String(lane.id)), true);
    assert.equal(registry.getRunningCountForSession(orchestrator.id), 1);

    registry.updateProject(orchestrator.projectId, { state: 'archived' }, { actor: 'test', approved: true });
    await registry.deleteProject(orchestrator.projectId, { actor: 'test', approved: true });

    assert.equal(registry.getRunningCountForSession(orchestrator.id), 0);
    assert.equal(registry.laneRuntimeEnv.has(String(lane.id)), false);
    assert.equal(registry.lanes.filter((l) => l.sessionId === orchestrator.id).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Exclusive startup and shutdown ownership.
//
// These spawn REAL daemons (`node src/server.js`), because the defect is in the
// entrypoint's ordering: a second start used to restore, migrate and recover
// (recovery SIGKILLs the process groups persisted lanes point at) BEFORE it
// discovered the state or the port was already owned.
//
// Orca's state is <cwd>/.orca, so every daemon here runs with cwd = a fresh
// fixture under the OS temp dir, HOME inside that fixture, and an ephemeral
// port — never 3000. The only processes signaled are ones this file spawned.
// ---------------------------------------------------------------------------

const SERVER_ENTRY = fileURLToPath(new URL('../src/server.js', import.meta.url));
const CHECKOUT_ROOT = path.resolve(path.dirname(SERVER_ENTRY), '..');
const FORBIDDEN_PORT = 3000;
const DAEMON_TOKEN = 'exclusive-startup-token';
// A daemon with this heartbeat writes nothing on its own while a test inspects its state.
const QUIET_HEARTBEAT_MS = 3_600_000;
const EPOCH_START = 'Thu Jan 1 00:00:00 1970';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, ms = 10_000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function makeFixture(label) {
  const tmpRoot = await fs.realpath(os.tmpdir());
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `orca-excl-${label}-`)));
  assert.ok(dir.startsWith(`${tmpRoot}${path.sep}`), `fixture ${dir} must live under the OS temp dir`);
  assert.ok(!dir.startsWith(`${CHECKOUT_ROOT}${path.sep}`), 'a fixture must never be inside a checkout');
  await fs.mkdir(path.join(dir, 'home'));
  return dir;
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function startDaemon(cwd, port, { heartbeatMs = QUIET_HEARTBEAT_MS, env = {} } = {}) {
  assert.ok(Number.isInteger(port) && port > 0 && port !== FORBIDDEN_PORT, `refusing to start a test daemon on port ${port}`);
  assert.ok(cwd.startsWith(os.tmpdir()) || cwd.startsWith('/private/var/') || cwd.startsWith('/tmp/') || cwd.startsWith('/private/tmp/'), `refusing to start a test daemon outside a temp fixture: ${cwd}`);
  const env0 = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: path.join(cwd, 'home'),
    PORT: String(port),
    ORCA_HOST: '127.0.0.1',
    ORCA_API_TOKEN: DAEMON_TOKEN,
    ORCA_REPO_ROOTS: cwd,
    ORCA_AUTO_AUDIT: 'false',
    ORCA_CREDENTIAL_BACKEND: 'memory',
    ORCA_RATE_LIMIT_DISABLED: 'true',
    ORCA_HEARTBEAT_MS: String(heartbeatMs),
    ...env,
  };
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd,
    env: Object.fromEntries(Object.entries(env0).filter(([, value]) => value !== undefined)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let exit = null;
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  return { child, pid: child.pid, port, cwd, output: () => output, exit: () => exit, exited };
}

function waitForExit(daemon, ms) {
  return Promise.race([daemon.exited, delay(ms).then(() => null)]);
}

async function stopDaemon(daemon) {
  if (!daemon) return null;
  if (daemon.exit()) return daemon.exit();
  daemon.child.kill('SIGTERM');
  const result = await waitForExit(daemon, 15_000);
  if (result) return result;
  daemon.child.kill('SIGKILL');
  return waitForExit(daemon, 5_000);
}

async function httpJson(port, route, { method = 'GET', body, headers = {} } = {}) {
  assert.notEqual(port, FORBIDDEN_PORT);
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-orca-token': DAEMON_TOKEN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: response.status, body: json, text };
}

async function waitForHealthy(daemon, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (daemon.exit()) throw new Error(`daemon exited during startup ${JSON.stringify(daemon.exit())}\n${daemon.output()}`);
    try {
      const health = await httpJson(daemon.port, '/api/health');
      if (health.status === 200) return health.body;
    } catch { /* not listening yet */ }
    await delay(50);
  }
  throw new Error(`daemon never became healthy on :${daemon.port}\n${daemon.output()}`);
}

// Every file (content hash) and directory under a fixture, minus the test's
// own home/ and bin/. Equality before/after == "no state change".
async function snapshotTree(root, { skip = ['home', 'bin'] } = {}) {
  const entries = [];
  async function walk(dir, rel) {
    let items;
    try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (!rel && skip.includes(item.name)) continue;
      const relPath = rel ? `${rel}/${item.name}` : item.name;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        entries.push(`${relPath}/`);
        await walk(full, relPath);
      } else if (item.isFile()) {
        entries.push(`${relPath} ${crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex').slice(0, 16)}`);
      } else {
        entries.push(`${relPath} (non-file)`);
      }
    }
  }
  await walk(root, '');
  return entries;
}

// The daemon's own startup writes (the debounced post-recovery persist) must
// land before a test takes its "before" snapshot.
async function waitForQuietState(fixture) {
  await waitUntil(() => fs.access(path.join(fixture, '.orca', 'state.json')).then(() => true, () => false), 10_000, 'state.json');
  let previous = null;
  await waitUntil(async () => {
    const current = JSON.stringify(await snapshotTree(fixture));
    const stable = current === previous;
    previous = current;
    if (!stable) await delay(300);
    return stable;
  }, 10_000, 'a quiet state directory');
}

function commandOf(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// Stands in for an executor CLI a daemon launched: a detached process group
// whose command line names `claude` — exactly what interrupted-lane recovery
// (registry-lifecycle.js) is willing to SIGKILL.
async function startFakeWorker(fixture) {
  const binDir = path.join(fixture, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const executable = path.join(binDir, 'claude');
  await fs.symlink(process.execPath, executable);
  const child = spawn(executable, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  await waitUntil(() => /\bclaude\b/.test(commandOf(child.pid)), 5_000, 'the fake worker');
  return {
    pid: child.pid,
    exit: () => exit,
    cleanup: () => { if (!exit) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } },
  };
}

// A non-executor process: what a reused pid points at.
async function startBystander() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  await waitUntil(() => commandOf(child.pid) !== '', 5_000, 'the bystander');
  return { pid: child.pid, exit: () => exit, cleanup: () => { if (!exit) child.kill('SIGKILL'); } };
}

function runningLaneRecord(worker) {
  const now = new Date().toISOString();
  return {
    id: 'lane-worker-owned-by-first-daemon',
    sessionId: 'orc_first',
    orchestratorId: 'orc_first',
    projectId: 'prj_first',
    title: 'a worker the first daemon is running',
    state: 'running',
    executorType: 'claude',
    processMeta: { pid: worker.pid, pgid: worker.pid, startedAt: now },
    logs: [],
    agentEvents: [],
    createdAt: now,
  };
}

const emptyState = (lanes = []) => ({
  version: 3, projects: [], orchestrators: [], lanes, auditEvents: [], toolLeases: [], agentQueue: [], policies: {},
});
const statePath = (fixture) => path.join(fixture, '.orca', 'state.json');
const lockPath = (fixture) => path.join(fixture, '.orca', 'daemon.lock');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
async function writeState(fixture, state) {
  await fs.mkdir(path.join(fixture, '.orca'), { recursive: true });
  await fs.writeFile(statePath(fixture), JSON.stringify(state));
}
const exists = (file) => fs.access(file).then(() => true, () => false);

async function runCleanups(cleanups, fixtures) {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch { /* best-effort */ }
  }
  for (const fixture of fixtures) {
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test('exclusive startup: a second daemon on the SAME state refuses — no state change, no signal to the first daemon or its worker', { timeout: 120_000 }, async () => {
  const fixture = await makeFixture('same-state');
  const cleanups = [];
  try {
    const first = startDaemon(fixture, await freePort());
    cleanups.push(() => stopDaemon(first));
    await waitForHealthy(first);
    await waitForQuietState(fixture);

    // The first daemon's persisted record of a worker it is running.
    const worker = await startFakeWorker(fixture);
    cleanups.push(worker.cleanup);
    const state = await readJson(statePath(fixture));
    state.lanes = [...(state.lanes || []), runningLaneRecord(worker)];
    await writeState(fixture, state);
    const before = await snapshotTree(fixture);

    // A DIFFERENT free port, so the port cannot be what stops it: only state ownership can.
    const second = startDaemon(fixture, await freePort());
    cleanups.push(() => stopDaemon(second));
    const secondExit = await waitForExit(second, 15_000);
    await delay(500); // let any late signal or debounced persist land before judging

    assert.equal(worker.exit(), null, `the second start KILLED the first daemon's worker ${JSON.stringify(worker.exit())}\n--- second daemon ---\n${second.output()}`);
    assert.deepEqual(await snapshotTree(fixture), before, `the second start CHANGED the first daemon's state\n--- second daemon ---\n${second.output()}`);
    assert.ok(secondExit, `the second daemon kept running alongside the first\n${second.output()}`);
    assert.notEqual(secondExit.code, 0, 'a refused start exits non-zero');
    assert.match(second.output(), /another Orca daemon already owns this state directory/);
    assert.match(second.output(), new RegExp(`pid ${first.pid}\\b`), 'names the existing instance');
    assert.match(second.output(), new RegExp(`http://127\\.0\\.0\\.1:${first.port}\\b`), 'says where the existing instance listens');
    assert.equal(first.exit(), null, 'the first daemon is still running');
    assert.equal((await httpJson(first.port, '/api/health')).status, 200);
  } finally {
    await runCleanups(cleanups, [fixture]);
  }
});

test('exclusive startup: a daemon whose PORT is taken fails before recovery — its state is unchanged and the worker its records name is not signaled', { timeout: 120_000 }, async () => {
  const ownerFixture = await makeFixture('port-owner');
  const contenderFixture = await makeFixture('port-contender');
  const cleanups = [];
  try {
    const owner = startDaemon(ownerFixture, await freePort());
    cleanups.push(() => stopDaemon(owner));
    await waitForHealthy(owner);
    await waitForQuietState(ownerFixture);

    // The contender's state records a live worker as running — e.g. a copied or
    // restored state directory. Recovery would reap it; the bind must fail first.
    const worker = await startFakeWorker(contenderFixture);
    cleanups.push(worker.cleanup);
    await writeState(contenderFixture, emptyState([runningLaneRecord(worker)]));
    const ownerBefore = await snapshotTree(ownerFixture);
    const contenderBefore = await snapshotTree(contenderFixture);

    const contender = startDaemon(contenderFixture, owner.port);
    cleanups.push(() => stopDaemon(contender));
    const contenderExit = await waitForExit(contender, 15_000);
    await delay(500);

    assert.equal(worker.exit(), null, `the port-conflicting start KILLED a live worker before discovering the port was taken ${JSON.stringify(worker.exit())}\n--- contender ---\n${contender.output()}`);
    assert.deepEqual(await snapshotTree(contenderFixture), contenderBefore, `the port-conflicting start CHANGED its state before failing\n--- contender ---\n${contender.output()}`);
    assert.deepEqual(await snapshotTree(ownerFixture), ownerBefore, 'the running daemon\'s state is untouched');
    assert.ok(contenderExit, `the port-conflicting daemon did not exit\n${contender.output()}`);
    assert.notEqual(contenderExit.code, 0);
    assert.match(contender.output(), new RegExp(`port ${owner.port}\\b.*already in use`));
    assert.equal(owner.exit(), null, 'the port owner is still running');
    assert.equal((await httpJson(owner.port, '/api/health')).status, 200);
  } finally {
    await runCleanups(cleanups, [ownerFixture, contenderFixture]);
  }
});

test('exclusive startup: a stale lock (owner exited) and a REUSED pid (live, different start time) are taken over safely — the start proceeds and signals nothing', { timeout: 120_000 }, async () => {
  for (const scenario of ['owner-exited', 'pid-reused']) {
    const fixture = await makeFixture(`stale-${scenario}`);
    const cleanups = [];
    try {
      let lockPid;
      let bystander = null;
      if (scenario === 'owner-exited') {
        const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
        await new Promise((resolve) => gone.once('exit', resolve));
        lockPid = gone.pid;
      } else {
        bystander = await startBystander();
        cleanups.push(bystander.cleanup);
        lockPid = bystander.pid;
      }
      await writeState(fixture, emptyState([{ id: 'lane-kept', sessionId: 'orc_x', title: 'kept', state: 'done', executorType: 'mock', logs: [], agentEvents: [], createdAt: new Date().toISOString() }]));
      await fs.writeFile(lockPath(fixture), `${JSON.stringify({
        schema: 'orca.instance-lock.v1', pid: lockPid, processStart: EPOCH_START, hostname: os.hostname(),
        nonce: 'left-behind', stateDir: path.join(fixture, '.orca'), acquiredAt: new Date(0).toISOString(), listen: null,
      })}\n`);

      const daemon = startDaemon(fixture, await freePort());
      cleanups.push(() => stopDaemon(daemon));
      const health = await waitForHealthy(daemon);
      assert.equal(health.counts?.lanes, 1, `${scenario}: state was restored (records retained)`);
      assert.equal((await readJson(lockPath(fixture))).pid, daemon.pid, `${scenario}: the new daemon owns the lock`);
      assert.match(daemon.output(), new RegExp(`stale.*${scenario}`), `${scenario}: the takeover is reported`);
      if (bystander) assert.equal(bystander.exit(), null, 'the process holding the reused pid was not signaled');

      const stopped = await stopDaemon(daemon);
      assert.deepEqual(stopped, { code: 0, signal: null }, daemon.output());
      assert.equal(await exists(lockPath(fixture)), false, `${scenario}: a normal stop releases the lock`);
      if (bystander) assert.equal(bystander.exit(), null, 'the process holding the reused pid survived the whole run');
    } finally {
      await runCleanups(cleanups, [fixture]);
    }
  }
});

test('exclusive startup: a normal stop releases ownership, and a restart retains records and artifacts', { timeout: 120_000 }, async () => {
  const fixture = await makeFixture('restart');
  const cleanups = [];
  const env = { ORCA_AUTO_COMPLETE_MS: '100' };
  try {
    const port = await freePort();
    const first = startDaemon(fixture, port, { heartbeatMs: 100, env });
    cleanups.push(() => stopDaemon(first));
    await waitForHealthy(first);

    const lease = await httpJson(port, '/api/agent-tools/leases', { method: 'POST', body: { role: 'orchestrator', actor: 'restart-test', ttlMs: 600_000 } });
    assert.equal(lease.status, 201, lease.text);
    const withLease = { 'x-orca-tool-lease': lease.body.leaseToken };
    const orchestrator = await httpJson(port, '/api/orchestrators', { method: 'POST', headers: withLease, body: { cwd: fixture, actor: 'restart-test', title: 'Restart' } });
    assert.equal(orchestrator.status, 200, orchestrator.text);
    const lane = await httpJson(port, `/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      headers: withLease,
      body: { actor: 'restart-test', approved: true, title: 'Restart lane', role: 'executor', executorType: 'mock', taskPrompt: 'Finish so a restart has something to keep.' },
    });
    assert.equal(lane.status, 201, lane.text);
    let laneBefore = null;
    await waitUntil(async () => {
      laneBefore = (await httpJson(port, `/api/lanes/${lane.body.id}`)).body;
      return ['done', 'ready_for_audit'].includes(laneBefore?.state);
    }, 15_000, 'the lane to finish');
    const artifactDir = path.join(fixture, 'artifacts', orchestrator.body.id, lane.body.id);
    await waitUntil(async () => (await snapshotTree(artifactDir)).some((entry) => !entry.endsWith('/')), 10_000, 'lane artifacts');
    const artifactsBefore = await snapshotTree(artifactDir);
    const countsBefore = (await httpJson(port, '/api/health')).body.counts;

    assert.deepEqual(await stopDaemon(first), { code: 0, signal: null }, first.output());
    assert.equal(await exists(lockPath(fixture)), false, 'a normal stop releases the state lock');
    assert.ok((await readJson(statePath(fixture))).lanes.some((entry) => entry.id === lane.body.id), 'the lane record was persisted on stop');

    // Same port and same state: both were released by the stop.
    const second = startDaemon(fixture, port, { heartbeatMs: 100, env });
    cleanups.push(() => stopDaemon(second));
    const health = await waitForHealthy(second);
    assert.equal((await readJson(lockPath(fixture))).pid, second.pid, 'the restarted daemon owns the state');
    const laneAfter = await httpJson(port, `/api/lanes/${lane.body.id}`);
    assert.equal(laneAfter.status, 200, laneAfter.text);
    assert.equal(laneAfter.body.state, laneBefore.state, 'the lane keeps its state across the restart');
    assert.equal(health.counts.projects, countsBefore.projects);
    assert.equal(health.counts.orchestrators, countsBefore.orchestrators);
    assert.equal(health.counts.lanes, countsBefore.lanes);
    assert.deepEqual(await snapshotTree(artifactDir), artifactsBefore, 'lane artifacts survive stop + restart byte-for-byte');

    assert.deepEqual(await stopDaemon(second), { code: 0, signal: null }, second.output());
    assert.equal(await exists(lockPath(fixture)), false);
  } finally {
    await runCleanups(cleanups, [fixture]);
  }
});
