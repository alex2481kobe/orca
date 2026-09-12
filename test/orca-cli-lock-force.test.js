// `stop --force`, and what `status` says, when the instance lock is in a state
// this machine cannot verify.
//
// Before this file, all three of `stop`, `stop --force` and `start` printed the
// SAME refusal at such a lock, so a live daemon could be neither stopped nor
// replaced through its own CLI, and `status` reported it as "unknown" with a
// null pid — which reads as "nothing runs" (docs/audits/2026-09-12-hostname-strands-the-daemon.md).
//
// Every case pins ORCA_STATE_DIR to a temp directory, HOME to a temp directory
// and never uses the default port, so none can reach a real install, a real
// checkout's .orca, or a daemon on :3000. The only processes signaled are the
// stand-ins these tests spawn themselves.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ROOT, cleanChildEnv, freePort } from './helpers/bridge-client.js';
import { INSTANCE_LOCK_FILE, INSTANCE_LOCK_SCHEMA, probeProcess } from '../src/instance-lock.js';

const CLI = path.join(ROOT, 'src', 'orca-cli.js');
const OTHER_MACHINE = 'machine-bbbb-2222';
// A hostname this machine cannot be answering to, so "the host renamed itself"
// is real in every environment this suite runs in.
const FORMER_HOSTNAME = 'orca-test-former-hostname';

async function fixture(label) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `orca-lockforce-${label}-`)));
  const dirs = {
    tmp,
    home: path.join(tmp, 'home'),
    state: path.join(tmp, 'state'),
    config: path.join(tmp, 'config'),
    // Never the default port: a `status` that finds no lock probes it, and on a
    // developer's machine :3000 is the real daemon.
    port: await freePort(),
  };
  for (const key of ['home', 'state', 'config']) await fs.mkdir(dirs[key]);
  return dirs;
}

function childEnv(dirs, extra = {}) {
  const env = {
    ...cleanChildEnv(),
    HOME: dirs.home,
    ORCA_STATE_DIR: dirs.state,
    ORCA_CONFIG_DIR: dirs.config,
    ORCA_AUTO_AUDIT: 'false',
    // Pin the identity: these tests are about the comparison, not about what
    // this particular machine's ioreg says.
    ORCA_MACHINE_ID: 'machine-aaaa-1111',
    PORT: String(dirs.port),
    ...extra,
  };
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_STATE_HOME;
  return env;
}

function runCli(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), all: `${r.stdout}\n${r.stderr}` };
}

function lockPathOf(dirs) {
  return path.join(dirs.state, INSTANCE_LOCK_FILE);
}

function writeLock(dirs, fields) {
  const record = {
    schema: INSTANCE_LOCK_SCHEMA,
    hostname: FORMER_HOSTNAME,
    nonce: 'stand-in-owner',
    stateDir: dirs.state,
    cwd: dirs.state,
    acquiredAt: new Date().toISOString(),
    listen: null,
    ...fields,
  };
  if (record.machine === undefined) delete record.machine;
  fsSync.writeFileSync(lockPathOf(dirs), `${JSON.stringify(record)}\n`);
  return record;
}

function clearedLocks(dirs) {
  return fsSync.readdirSync(dirs.state).filter((name) => name.startsWith(`${INSTANCE_LOCK_FILE}.cleared-`));
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

// A stand-in for the daemon: it holds the lock and, like the daemon, removes it
// on SIGTERM. Without that a `stop` could not observe a release and would only
// ever time out.
async function withStandInDaemon(lockPath, callback) {
  const script = [
    'const fs = require("node:fs");',
    'const lockPath = process.argv[1];',
    'const bye = () => { try { fs.unlinkSync(lockPath); } catch {} process.exit(0); };',
    'process.on("SIGTERM", bye);',
    'process.stdout.write("up\\n");',
    'setInterval(() => {}, 1 << 30);',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script, lockPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', () => reject(new Error('the stand-in daemon exited before it was ready')));
  });
  try {
    return await callback({ pid: child.pid, start: probeProcess(child.pid).start, exit: () => exit });
  } finally {
    if (exit === null) child.kill('SIGKILL');
  }
}

async function withSleeper(callback) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  for (let i = 0; i < 100 && probeProcess(child.pid).state !== 'alive'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    return await callback({ pid: child.pid, start: probeProcess(child.pid).start, exit: () => exit });
  } finally {
    if (exit === null) child.kill('SIGKILL');
  }
}

test('THE INCIDENT, through the CLI: a hostname change no longer strands a live daemon', { timeout: 60_000 }, async () => {
  const dirs = await fixture('incident');
  try {
    await withStandInDaemon(lockPathOf(dirs), async (daemon) => {
      // The lock exactly as the old code wrote it at 05:36: a hostname, no
      // machine identity. Since then the network changed and this host answers
      // to a different name — which is all that ever happened.
      assert.notEqual(os.hostname(), FORMER_HOSTNAME, 'the fixture must really be a renamed host');
      writeLock(dirs, { pid: daemon.pid, processStart: daemon.start, hostname: FORMER_HOSTNAME, machine: undefined });
      const env = childEnv(dirs);

      const status = runCli(['status', '--json'], env);
      const report = JSON.parse(status.stdout);
      // 'starting', not 'running', only because this stand-in serves no HTTP.
      // What matters is that status found the daemon at all: before the fix it
      // reported a bare "unknown" with a null pid.
      assert.equal(report.state, 'starting', status.all);
      assert.equal(report.pid, daemon.pid, 'the daemon the lock names is alive on this machine, and status finds it');

      const stopped = runCli(['stop', '--wait', '20'], env);
      assert.equal(stopped.code, 0, stopped.all);
      assert.match(stopped.stdout, new RegExp(`Orca stopped \\(pid ${daemon.pid}\\)`));
      assert.equal(fsSync.existsSync(lockPathOf(dirs)), false, 'the daemon released its lock');
    });
  } finally {
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('stop refuses a lock it cannot verify, and the refusal names --force instead of an rm', async () => {
  const dirs = await fixture('refuse');
  try {
    const dead = await exitedPid();
    writeLock(dirs, { pid: dead, processStart: 'Thu Jan 1 00:00:00 1970', machine: OTHER_MACHINE, hostname: 'build-box' });
    const before = fsSync.readFileSync(lockPathOf(dirs), 'utf8');
    const env = childEnv(dirs);

    const refused = runCli(['stop'], env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /taken on another machine/);
    assert.match(refused.stderr, /stop --force/, 'the way out is a command, not a file deletion');
    assert.doesNotMatch(refused.stderr, /delete .*daemon\.lock and start again/);
    assert.equal(fsSync.readFileSync(lockPathOf(dirs), 'utf8'), before, 'the refusal changed nothing');
  } finally {
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('stop --force, pid ABSENT here: clears the lock, moves it aside rather than deleting it, and says so', async () => {
  const dirs = await fixture('absent');
  try {
    const dead = await exitedPid();
    writeLock(dirs, { pid: dead, processStart: 'Thu Jan 1 00:00:00 1970', machine: OTHER_MACHINE, hostname: 'build-box' });
    const env = childEnv(dirs);

    const forced = runCli(['stop', '--force'], env);
    assert.equal(forced.code, 0, forced.all);
    assert.match(forced.stdout, new RegExp(`pid ${dead} is not running on this machine`));
    assert.match(forced.stdout, /moved to .*daemon\.lock\.cleared-/);
    assert.equal(fsSync.existsSync(lockPathOf(dirs)), false, 'the state directory is free again');
    assert.equal(clearedLocks(dirs).length, 1, 'and the evidence was kept, not deleted');

    const after = runCli(['status'], env);
    assert.equal(after.code, 3, 'status now reports a stopped Orca');
    assert.match(after.stdout, /Orca is not running/);
  } finally {
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('stop --force, pid ALIVE here but NOT the owner: never signals the stranger, clears the lock, and names what holds the pid', async () => {
  const dirs = await fixture('reused');
  try {
    await withSleeper(async (sleeper) => {
      writeLock(dirs, { pid: sleeper.pid, processStart: 'Thu Jan 1 00:00:00 1970', machine: OTHER_MACHINE, hostname: 'build-box' });
      const env = childEnv(dirs);

      const forced = runCli(['stop', '--force'], env);
      assert.equal(forced.code, 0, forced.all);
      assert.match(forced.stdout, new RegExp(`pid ${sleeper.pid} is running on this machine but is NOT the lock's owner`));
      assert.match(forced.stdout, /No signal was sent/);
      assert.match(forced.stdout, /moved to .*daemon\.lock\.cleared-/);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(sleeper.exit(), null, 'the process that now holds the pid is still running');
      assert.equal(probeProcess(sleeper.pid).state, 'alive');
    });
  } finally {
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('stop --force, pid ALIVE here and IS the owner: stops it and says which branch it took', { timeout: 60_000 }, async () => {
  const dirs = await fixture('owner');
  try {
    await withStandInDaemon(lockPathOf(dirs), async (daemon) => {
      // A lock from another machine's identity, but the pid and start time both
      // match a live local process — the operator has overruled, so act.
      writeLock(dirs, { pid: daemon.pid, processStart: daemon.start, machine: OTHER_MACHINE, hostname: 'build-box' });
      const env = childEnv(dirs);

      const forced = runCli(['stop', '--force', '--wait', '20'], env);
      assert.equal(forced.code, 0, forced.all);
      assert.match(forced.stdout, /--force on a lock this machine cannot verify/);
      assert.match(forced.stdout, new RegExp(`pid ${daemon.pid} is running on this machine and started exactly when the lock records`));
      assert.match(forced.stdout, new RegExp(`Orca stopped \\(pid ${daemon.pid}\\)`));
      assert.equal(fsSync.existsSync(lockPathOf(dirs)), false);
      assert.equal(clearedLocks(dirs).length, 0, 'a daemon that released its own lock leaves nothing to clear');
    });
  } finally {
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('status does not imply nothing runs: an unverifiable lock reports unreachable-by-lock, with the owner pid and what it looks like here', async () => {
  const dirs = await fixture('status');
  try {
    await withSleeper(async (sleeper) => {
      writeLock(dirs, {
        pid: sleeper.pid,
        processStart: 'Thu Jan 1 00:00:00 1970',
        machine: OTHER_MACHINE,
        hostname: 'build-box',
        listen: { host: '127.0.0.1', port: 45123 },
      });
      const env = childEnv(dirs);

      const json = runCli(['status', '--json'], env);
      assert.equal(json.code, 1);
      const report = JSON.parse(json.stdout);
      assert.equal(report.state, 'unreachable-by-lock');
      assert.equal(report.lock.held, true);
      assert.equal(report.lock.reason, 'other-machine');
      assert.equal(report.lock.ownerPid, sleeper.pid, 'the pid that owns the state directory is reported, not null');
      assert.equal(report.lock.ownerHostname, 'build-box');
      assert.equal(report.lock.ownerMachine, OTHER_MACHINE);
      assert.equal(report.lock.ownerPidOnThisMachine, 'alive');
      assert.ok(report.lock.remedy.length, 'and the remedy travels with the report');
      assert.match(report.machine, /machine-.*1111.*ORCA_MACHINE_ID/, 'status says which machine it is speaking as, and where that came from');

      const human = runCli(['status'], env);
      assert.equal(human.code, 1);
      assert.match(human.stdout, /Orca is unreachable-by-lock/);
      assert.match(human.stdout, /It is NOT known to be stopped/);
      assert.doesNotMatch(human.stdout, /delete .*daemon\.lock and start again/);
      assert.equal(sleeper.exit(), null);
    });
  } finally {
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('stop --force still refuses when the pid cannot be checked at all, and names the machine that can answer', async () => {
  const dirs = await fixture('uncheckable');
  try {
    // A `ps` that answers nothing and fails with a status that proves nothing:
    // the platform where a pid simply cannot be checked.
    const bin = path.join(dirs.tmp, 'stub-bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    writeLock(dirs, { pid: 999_999, processStart: 'Thu Jan 1 00:00:00 1970', machine: OTHER_MACHINE, hostname: 'build-box' });
    const before = fsSync.readFileSync(lockPathOf(dirs), 'utf8');
    const env = childEnv(dirs, { PATH: `${bin}:${process.env.PATH}` });

    const forced = runCli(['stop', '--force'], env);
    assert.equal(forced.code, 1, forced.all);
    assert.match(forced.stderr, /cannot be checked from this machine, so --force will not act/);
    assert.match(forced.stderr, /shared with "build-box"/);
    assert.equal(fsSync.readFileSync(lockPathOf(dirs), 'utf8'), before, 'and it changed nothing');
    assert.equal(clearedLocks(dirs).length, 0);
  } finally {
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5 });
  }
});
