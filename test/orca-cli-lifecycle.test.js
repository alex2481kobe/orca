// Stage 3 setup and Stage 4 lifecycle, through the real CLI.
//
//   setup    one command records the fence in the user's Orca config (never in
//            the repo), validates it, requires a deliberate choice for a
//            whole-home root, and recommends an API token; doctor reports it.
//   setup-required  a daemon with no roots runs and answers, and the start
//            output, the dashboard, doctor and an MCP tool call all name the
//            command that fixes it.
//   start / stop / status  find the daemon by its instance lock and port; a
//            duplicate start reports the running daemon and changes nothing; the
//            daemon survives the death of the process group that started it; stop
//            refuses while an executor runs unless --force.
//   service  a per-user LaunchAgent plist, written and removed under a temp HOME
//            and driven through a fake launchctl. Nothing touches ~/Library.
//
// Every CLI and daemon here runs with a temp HOME, ORCA_STATE_DIR pinned to temp
// state and a free port: none can reach a real install, a real checkout's .orca,
// or port 3000.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ROOT, cleanChildEnv, freePort, startBridge } from './helpers/bridge-client.js';

const CLI = path.join(ROOT, 'src', 'orca-cli.js');
const IS_MAC = process.platform === 'darwin';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeFixture(label) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `orca-cli-${label}-`)));
  const dirs = {
    tmp,
    home: path.join(tmp, 'home'),
    state: path.join(tmp, 'state'),
    project: path.join(tmp, 'project'),
    other: path.join(tmp, 'other'),
    bin: path.join(tmp, 'bin'),
  };
  for (const key of ['home', 'project', 'other', 'bin']) await fs.mkdir(dirs[key]);
  return dirs;
}

// A child's environment: nothing that could point it at a real Orca, a real
// config dir or real state.
function childEnv(dirs, extra = {}) {
  const env = {
    ...cleanChildEnv(),
    HOME: dirs.home,
    ORCA_STATE_DIR: dirs.state,
    ORCA_AUTO_AUDIT: 'false',
    ORCA_RATE_LIMIT_DISABLED: 'true',
    ORCA_CREDENTIAL_BACKEND: 'memory',
    ...extra,
  };
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_STATE_HOME;
  return env;
}

function runCli(args, { env, cwd = ROOT }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr, all: `${stdout}\n${stderr}` }));
  });
}

function lockHolder(stateDir) {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(stateDir, 'daemon.lock'), 'utf8'));
  } catch {
    return null;
  }
}

async function healthStatus(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.status;
  } catch {
    return null;
  }
}

async function requestJson(base, route, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

async function waitFor(predicate, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Stop any daemon a test left running (through the CLI; failing that, by the
// pid in the test's own temp lock), then remove the fixture.
async function cleanup(dirs, env) {
  const holder = lockHolder(dirs.state);
  if (holder) {
    const stopped = await runCli(['stop', '--force', '--wait', '30'], { env });
    if (stopped.code !== 0 && lockHolder(dirs.state)) {
      try { process.kill(holder.pid, 'SIGTERM'); } catch { /* already gone */ }
      await waitFor(() => !lockHolder(dirs.state), 'the fixture daemon to stop').catch(() => {});
    }
  }
  await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

test('setup: one command records exact, validated roots in the user config (never in the repo), and doctor reports them', async () => {
  const dirs = await makeFixture('setup');
  const env = childEnv(dirs);
  const configFile = path.join(dirs.home, '.config', 'orca', 'config.json');
  const repoBefore = fsSync.readdirSync(ROOT).sort();
  try {
    let run = await runCli(['setup'], { env });
    assert.equal(run.code, 2, run.all);
    assert.match(run.stderr, /setup --roots/);

    for (const bad of ['relative/dir', path.join(dirs.tmp, 'missing')]) {
      run = await runCli(['setup', '--roots', bad, '--no-start'], { env });
      assert.equal(run.code, 2, run.all);
      assert.match(run.stderr, /Nothing was saved/);
      assert.equal(fsSync.existsSync(configFile), false, `${bad} saved nothing`);
    }

    // The whole home directory takes a deliberate, recorded choice.
    const accountHome = os.userInfo().homedir;
    run = await runCli(['setup', '--roots', accountHome, '--no-start'], { env });
    assert.equal(run.code, 2, run.all);
    assert.match(run.stderr, /whole home directory/);
    assert.match(run.stderr, /--allow-home-root/);
    assert.equal(fsSync.existsSync(configFile), false);

    run = await runCli(['setup', '--roots', dirs.project, '--roots', dirs.other, '--no-start'], { env });
    assert.equal(run.code, 0, run.all);
    const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
    assert.deepEqual(saved.roots, [dirs.project, dirs.other]);
    assert.equal(saved.homeRootAcknowledgedAt, undefined);
    assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600, 'the config is owner-only');
    assert.match(run.stdout, /ORCA_API_TOKEN/, 'setup recommends an API token');
    assert.match(run.stdout, /Orca's own checkout .* is not under these roots/, 'setup says how to let agents work on Orca itself');
    assert.match(run.stdout, /Not started \(--no-start\)/);
    assert.deepEqual(fsSync.readdirSync(ROOT).sort(), repoBefore, 'setup writes nothing in the repo');

    const doctor = JSON.parse((await runCli(['doctor', '--json'], { env })).stdout);
    const fence = doctor.checks.find((check) => check.id === 'fence');
    assert.equal(fence.status, 'pass', JSON.stringify(fence));
    assert.ok(fence.summary.includes(dirs.project) && fence.summary.includes(configFile), fence.summary);

    run = await runCli(['setup', '--roots', accountHome, '--allow-home-root', '--no-start'], { env });
    assert.equal(run.code, 0, run.all);
    assert.match(run.stdout, /WARNING: .*whole home directory/);
    assert.ok(JSON.parse(await fs.readFile(configFile, 'utf8')).homeRootAcknowledgedAt, 'the acknowledgement is recorded');
    const warned = JSON.parse((await runCli(['doctor', '--json'], { env })).stdout).checks.find((check) => check.id === 'fence');
    assert.equal(warned.status, 'warn', JSON.stringify(warned));
    assert.match(warned.summary, /whole home directory/);
  } finally {
    await cleanup(dirs, env);
  }
});

test('with no roots the daemon runs, and start, the dashboard, doctor and an MCP tool call name the setup command; setup and a restart fix it', { timeout: 120_000 }, async () => {
  const dirs = await makeFixture('setup-required');
  const port = await freePort();
  const env = childEnv(dirs, { PORT: String(port) });
  const base = `http://127.0.0.1:${port}`;
  try {
    let run = await runCli(['start', '--wait', '30'], { env });
    assert.equal(run.code, 0, run.all);
    assert.match(run.stdout, /SETUP REQUIRED/);
    assert.match(run.stdout, /setup --roots/);
    assert.equal(await healthStatus(base), 200, 'the daemon runs and answers');

    const overview = await requestJson(base, '/api/overview');
    assert.equal(overview.status, 200, overview.text);
    assert.equal(overview.body.fence.status, 'setup-required');
    assert.match(overview.body.fence.fix, /setup --roots/);

    const bridge = startBridge({ ORCA_AGENT_TOOLS_BASE_URL: base, ORCA_ROLE: 'orchestrator' });
    try {
      const refused = await bridge.callTool('orchestrator__register', { body: { cwd: dirs.project, title: 'Setup required' } });
      assert.equal(refused.isError, true, refused.text);
      assert.match(refused.text, /setup --roots/, refused.text);
    } finally {
      bridge.close();
    }

    const doctor = JSON.parse((await runCli(['doctor', '--json', '--url', base], { env })).stdout);
    const fence = doctor.checks.find((check) => check.id === 'fence');
    assert.equal(fence.status, 'fail', JSON.stringify(fence));
    assert.match(fence.fix, /setup --roots/);

    // The fix is one command, then a restart.
    run = await runCli(['setup', '--roots', dirs.project], { env });
    assert.equal(run.code, 0, run.all);
    assert.match(run.stdout, /already running \(pid \d+\) with the fence it started with/);
    run = await runCli(['stop'], { env });
    assert.equal(run.code, 0, run.all);
    run = await runCli(['start', '--wait', '30'], { env });
    assert.equal(run.code, 0, run.all);
    assert.ok(run.stdout.includes(`Agents may register and run executors under ${dirs.project}`), run.stdout);
    const registered = await requestJson(base, '/api/orchestrators', { method: 'POST', body: { cwd: dirs.project, title: 'Now set up' } });
    assert.equal(registered.status, 200, registered.text);
  } finally {
    await cleanup(dirs, env);
  }
});

test("start runs one daemon no session owns: it outlives its starter's process group, a second start changes nothing, and status and stop find it from any directory", { timeout: 120_000 }, async () => {
  const dirs = await makeFixture('lifecycle');
  const port = await freePort();
  const env = childEnv(dirs, {
    PORT: String(port),
    ORCA_REPO_ROOTS: dirs.project,
    ORCA_AUTO_COMPLETE_MS: '600000',
    ORCA_HEARTBEAT_MS: '100',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    // Started the way an agent session would, from a shell whose whole process
    // group is then killed.
    const starter = spawn('/bin/sh', ['-c', `"${process.execPath}" "${CLI}" start --wait 30; echo STARTER-DONE; sleep 60`], {
      env,
      cwd: dirs.other,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let starterOut = '';
    starter.stdout.on('data', (chunk) => { starterOut += chunk; });
    starter.stderr.on('data', (chunk) => { starterOut += chunk; });
    await waitFor(() => starterOut.includes('STARTER-DONE'), 'start to finish', 45_000);
    assert.match(starterOut, /Orca is running: pid \d+/, starterOut);
    const first = lockHolder(dirs.state);
    assert.ok(first?.pid, 'the daemon holds its lock');
    process.kill(-starter.pid, 'SIGKILL');
    await sleep(1000);
    assert.equal(await healthStatus(base), 200, 'the daemon outlives the process group that started it');
    assert.equal(lockHolder(dirs.state)?.pid, first.pid);
    const pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(first.pid)], { encoding: 'utf8' }).stdout.trim());
    assert.notEqual(pgid, starter.pid, 'the daemon runs in a process group of its own');

    let run = await runCli(['start'], { env, cwd: dirs.project });
    assert.equal(run.code, 0, run.all);
    assert.match(run.stdout, /already running: pid \d+.*Nothing was changed/s);
    assert.equal(lockHolder(dirs.state).pid, first.pid, 'a duplicate start changes nothing');

    for (const cwd of [dirs.project, dirs.other, dirs.home]) {
      run = await runCli(['status', '--json'], { env, cwd });
      assert.equal(run.code, 0, run.all);
      const report = JSON.parse(run.stdout);
      assert.equal(report.state, 'running');
      assert.equal(report.pid, first.pid);
      assert.equal(report.stateDir, dirs.state);
      assert.equal(report.url, base);
    }

    // Stopping Orca stops its executors, so stop refuses while one runs.
    const orchestrator = await requestJson(base, '/api/orchestrators', { method: 'POST', body: { cwd: dirs.project, title: 'Busy' } });
    assert.equal(orchestrator.status, 200, orchestrator.text);
    const lane = await requestJson(base, `/api/orchestrators/${orchestrator.body.id}/executors`, {
      method: 'POST',
      body: { title: 'Long mock', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201, lane.text);
    await waitFor(async () => (await requestJson(base, `/api/lanes/${lane.body.id}`)).body?.state === 'running', 'the mock lane to run');
    run = await runCli(['stop'], { env });
    assert.equal(run.code, 1, run.all);
    assert.match(run.stderr, /Not stopping: 1 executor/);
    assert.equal(await healthStatus(base), 200, 'a refused stop leaves Orca running');

    run = await runCli(['stop', '--force'], { env, cwd: dirs.home });
    assert.equal(run.code, 0, run.all);
    assert.match(run.stdout, /Orca stopped \(pid \d+\)/);
    assert.equal(lockHolder(dirs.state), null, 'the lock is released');
    assert.equal(await healthStatus(base), null, 'nothing listens any more');
    run = await runCli(['status'], { env });
    assert.equal(run.code, 3, run.all);
    assert.match(run.stdout, /Orca is not running/);
    run = await runCli(['stop'], { env });
    assert.equal(run.code, 0, run.all);
    assert.match(run.stdout, /not running/);
  } finally {
    await cleanup(dirs, env);
  }
});

test('start refuses a port held by something that is not Orca, and creates nothing', async () => {
  const dirs = await makeFixture('port');
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not orca');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = childEnv(dirs, { PORT: String(server.address().port), ORCA_REPO_ROOTS: dirs.project });
  try {
    const run = await runCli(['start', '--wait', '10'], { env });
    assert.equal(run.code, 1, run.all);
    assert.match(run.stderr, /not Orca/);
    assert.equal(fsSync.existsSync(dirs.state), false, 'no state directory was created');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanup(dirs, env);
  }
});

test('service install writes a secret-free per-user LaunchAgent and loads it; start and stop go through launchd; uninstall removes it', { skip: !IS_MAC && 'LaunchAgents are macOS only' }, async () => {
  const dirs = await makeFixture('service');
  const log = path.join(dirs.tmp, 'launchctl.log');
  const loadedFlag = path.join(dirs.tmp, 'launchctl.loaded');
  // Records every call; "loaded" is a flag file the fake flips. The real
  // launchctl is never on this PATH.
  await fs.writeFile(path.join(dirs.bin, 'launchctl'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$FAKE_LAUNCHCTL_LOG"',
    'case "$1" in',
    '  bootstrap) echo 1 > "$FAKE_LAUNCHCTL_LOADED" ;;',
    '  bootout) echo 0 > "$FAKE_LAUNCHCTL_LOADED" ;;',
    '  print) [ "$(cat "$FAKE_LAUNCHCTL_LOADED" 2>/dev/null)" = 1 ] || exit 113 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  const port = await freePort();
  const env = childEnv(dirs, {
    PORT: String(port),
    PATH: [dirs.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    FAKE_LAUNCHCTL_LOG: log,
    FAKE_LAUNCHCTL_LOADED: loadedFlag,
    ORCA_API_TOKEN: 'service-test-secret-token',
  });
  const plist = path.join(dirs.home, 'Library', 'LaunchAgents', 'com.orca.local.plist');
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const uid = process.getuid();
  try {
    let run = await runCli(['service', 'install', '--dry-run'], { env });
    assert.equal(run.code, 0, run.all);
    assert.match(run.stdout, /<key>Label<\/key>\s*<string>com\.orca\.local<\/string>/);
    assert.equal(fsSync.existsSync(plist), false, 'a dry run writes nothing');
    assert.deepEqual(await calls(), [], 'a dry run calls no launchctl');

    run = await runCli(['service', 'install', '--wait', '0'], { env });
    assert.equal(run.code, 0, run.all);
    assert.ok(plist.startsWith(dirs.home), 'the plist is under the (temp) HOME');
    const text = await fs.readFile(plist, 'utf8');
    assert.equal((await fs.stat(plist)).mode & 0o777, 0o644);
    assert.ok(text.includes(`<string>${process.execPath}</string>\n    <string>${path.join(ROOT, 'src', 'server.js')}</string>`), 'it runs Orca by absolute Node and server path, not npm');
    assert.ok(text.includes(`<key>WorkingDirectory</key>\n  <string>${ROOT}</string>`));
    assert.ok(text.includes(`<key>ORCA_STATE_DIR</key>\n    <string>${dirs.state}</string>`));
    assert.ok(text.includes(`<key>ORCA_CONFIG_DIR</key>\n    <string>${path.join(dirs.home, '.config', 'orca')}</string>`));
    assert.ok(text.includes(`<key>PORT</key>\n    <string>${port}</string>`));
    assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(text, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    assert.ok(text.includes(path.join(dirs.state, 'logs', 'daemon.log')), 'logs go to the state directory');
    assert.equal(text.includes('service-test-secret-token'), false, 'the API token is never written to the plist');
    assert.equal(text.includes('ORCA_API_TOKEN'), false);
    if (fsSync.existsSync('/usr/bin/plutil')) {
      const lint = spawnSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' });
      assert.equal(lint.status, 0, `launchd can parse it: ${lint.stdout}${lint.stderr}`);
    }
    assert.ok((await calls()).includes(`bootstrap gui/${uid} ${plist}`), (await calls()).join('\n'));

    const report = JSON.parse((await runCli(['status', '--json'], { env })).stdout);
    assert.equal(report.service.installed, true);
    assert.equal(report.service.loaded, true);

    run = await runCli(['service', 'install', '--wait', '0'], { env });
    assert.equal(run.code, 1, 'a loaded service is not reinstalled underneath itself');
    assert.match(run.stderr, /Stop it first/);

    run = await runCli(['stop'], { env });
    assert.equal(run.code, 0, run.all);
    assert.ok((await calls()).includes(`bootout gui/${uid}/com.orca.local`), 'stop unloads the job, so KeepAlive cannot bring it back');

    run = await runCli(['start', '--wait', '0'], { env });
    assert.equal(run.code, 0, run.all);
    assert.equal((await calls()).filter((line) => line.startsWith('bootstrap ')).length, 2, 'start loads the installed service instead of spawning a daemon beside it');
    assert.equal(lockHolder(dirs.state), null, 'no detached daemon was spawned');

    run = await runCli(['stop'], { env });
    assert.equal(run.code, 0, run.all);
    run = await runCli(['service', 'uninstall'], { env });
    assert.equal(run.code, 0, run.all);
    assert.equal(fsSync.existsSync(plist), false, 'uninstall removes the plist');

    // A LaunchAgent Orca did not generate (the runbook's manual one) is left alone.
    await fs.writeFile(plist, '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n');
    run = await runCli(['service', 'install', '--wait', '0'], { env });
    assert.equal(run.code, 1, run.all);
    assert.match(run.stderr, /not generated by orca-cli\.js/);
    run = await runCli(['service', 'uninstall'], { env });
    assert.equal(run.code, 1, run.all);
    assert.ok(fsSync.existsSync(plist));
  } finally {
    await cleanup(dirs, env);
  }
});

// Two Orca daemons, side by side, on one workstation. Everything that
// distinguishes them is per-instance: the state directory's lock says which pid
// owns it and on which port, and the port says who is answering. Nothing may
// match on the process NAME — every Orca process on the machine has the same
// argv (`node .../src/server.js`), so a name pattern cannot tell these two apart
// and would let `stop` kill the wrong one.
test('start, stop and status find the daemon by state-directory lock and port, never by a process-name pattern', { timeout: 180_000 }, async () => {
  const mine = await makeFixture('detect-mine');
  const theirs = await makeFixture('detect-theirs');
  const minePort = await freePort();
  const theirsPort = await freePort();
  const mineEnv = childEnv(mine, { PORT: String(minePort), ORCA_REPO_ROOTS: mine.project });
  const theirsEnv = childEnv(theirs, { PORT: String(theirsPort), ORCA_REPO_ROOTS: theirs.project });
  const mineBase = `http://127.0.0.1:${minePort}`;
  const theirsBase = `http://127.0.0.1:${theirsPort}`;
  try {
    // Two daemons whose processes are indistinguishable by name.
    for (const [env, base] of [[mineEnv, mineBase], [theirsEnv, theirsBase]]) {
      const run = await runCli(['start', '--wait', '60'], { env, cwd: ROOT });
      assert.equal(run.code, 0, run.all);
      assert.equal(await healthStatus(base), 200, run.all);
    }
    const minePid = lockHolder(mine.state).pid;
    const theirsPid = lockHolder(theirs.state).pid;
    assert.notEqual(minePid, theirsPid);

    // Both really do look the same to a name matcher.
    const argv = (pid) => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    assert.equal(argv(minePid), argv(theirsPid), 'the two daemons are indistinguishable by process name');

    // status answers about the state directory it was given, never the other one.
    for (const [env, pid, base] of [[mineEnv, minePid, mineBase], [theirsEnv, theirsPid, theirsBase]]) {
      const run = await runCli(['status', '--json'], { env, cwd: os.tmpdir() });
      assert.equal(run.code, 0, run.all);
      const report = JSON.parse(run.stdout);
      assert.equal(report.state, 'running');
      assert.equal(report.pid, pid);
      assert.equal(report.url, base);
    }

    // A duplicate start reports the daemon that owns THIS state directory and
    // changes nothing — neither instance.
    const duplicate = await runCli(['start'], { env: mineEnv, cwd: ROOT });
    assert.equal(duplicate.code, 0, duplicate.all);
    assert.match(duplicate.stdout, new RegExp(`already running: pid ${minePid}`), duplicate.all);
    assert.equal(lockHolder(mine.state).pid, minePid);
    assert.equal(lockHolder(theirs.state).pid, theirsPid);

    // A third state directory sharing the other daemon's PORT is told exactly
    // that: an Orca answers there, but it owns a different state directory, so
    // stop refuses rather than signalling a daemon it cannot prove it owns.
    const bystander = await makeFixture('detect-bystander');
    const bystanderEnv = childEnv(bystander, { PORT: String(theirsPort), ORCA_REPO_ROOTS: bystander.project });
    try {
      const seen = await runCli(['status', '--json'], { env: bystanderEnv, cwd: ROOT });
      assert.equal(JSON.parse(seen.stdout).state, 'other-state-dir', seen.all);
      assert.equal(JSON.parse(seen.stdout).pid, null, 'it claims no pid it cannot prove');
      const refused = await runCli(['stop'], { env: bystanderEnv, cwd: ROOT });
      assert.equal(refused.code, 1, refused.all);
      assert.match(refused.stderr, /another state directory. Not stopping it/, refused.all);
      assert.equal(await healthStatus(theirsBase), 200, 'the other daemon is untouched');
    } finally {
      await fs.rm(bystander.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }

    // stop kills exactly the one whose lock it holds.
    const stopped = await runCli(['stop', '--wait', '60'], { env: mineEnv, cwd: os.tmpdir() });
    assert.equal(stopped.code, 0, stopped.all);
    assert.equal(await healthStatus(mineBase), null, 'the targeted daemon is gone');
    assert.equal(await healthStatus(theirsBase), 200, 'the look-alike daemon is still running');
    assert.equal(lockHolder(theirs.state).pid, theirsPid, 'and still owns its own state directory');
  } finally {
    await cleanup(mine, mineEnv);
    await cleanup(theirs, theirsEnv);
  }
});

// The behaviour above must hold because of how the code is written, not by luck:
// nothing on the lifecycle path may enumerate or pattern-match processes.
test('no lifecycle code finds Orca by scanning process names', async () => {
  // A name search looks like one of these. A single-pid `ps -p <pid> -o lstart=`
  // is not one: it asks about a pid the lock already named, which is the point.
  const banned = [
    /\b(pgrep|pkill|killall)\b/,
    /['"`]ps['"`]\s*,\s*\[[^\]]*['"`]-[aAex]/,
    /\bcomm=|\bargs=|process_name/,
  ];
  for (const file of ['cli-lifecycle.js', 'instance-lock.js', 'orca-cli.js']) {
    const source = await fs.readFile(path.join(ROOT, 'src', file), 'utf8');
    const offending = source.split('\n')
      .map((line, index) => [index + 1, line])
      .filter(([, line]) => !line.trimStart().startsWith('//') && banned.some((pattern) => pattern.test(line)));
    assert.deepEqual(offending, [], `src/${file} must not identify Orca by process name`);
  }
  // What it uses instead: the lock's pid plus its recorded process start time.
  const lock = await fs.readFile(path.join(ROOT, 'src', 'cli-lifecycle.js'), 'utf8');
  assert.match(lock, /inspectInstanceLock/, 'detection reads the instance lock');
  assert.match(lock, /processStart/, 'and proves the pid by its start time before signalling it');
});
