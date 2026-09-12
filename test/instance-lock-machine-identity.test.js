// The lock's identity: which MACHINE took it, not what the host called itself.
//
// The incident this file exists for (docs/audits/2026-09-12-hostname-strands-the-daemon.md):
// a Mac started the daemon while `os.hostname()` said `Alexs-Mac-mini.local`,
// then reported `Mac.lan` an hour later because the network changed. Nothing
// moved, nothing rebooted, the daemon was alive and listening — and the lock,
// keyed on the hostname, made it unstoppable and unreplaceable through its own
// CLI.
//
// The guarantee Stage 1 was built for still has to hold: a lock a DIFFERENT
// machine took is never taken over, even when its pid happens to be absent here.
// Both properties are asserted below, because a fix that only unstrands would
// re-open the two-daemons-on-one-state hole.
//
// Every case runs in a fresh temp state directory and passes `identity`
// explicitly, so no test depends on what this machine's real identity is.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireInstanceLock,
  inspectInstanceLock,
  probeProcess,
  INSTANCE_LOCK_FILE,
  INSTANCE_LOCK_SCHEMA,
} from '../src/instance-lock.js';

const THIS_MACHINE = { id: 'machine-aaaa-1111', source: 'platform-uuid', error: null };
const OTHER_MACHINE = { id: 'machine-bbbb-2222', source: 'platform-uuid', error: null };
const NO_IDENTITY = { id: null, source: 'unavailable', error: 'ioreg is not on PATH' };
const EPOCH_START = 'Thu Jan 1 00:00:00 1970';

async function withStateDir(callback) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-lock-id-'));
  const stateDir = path.join(root, '.orca');
  try {
    return await callback({ stateDir, lockPath: path.join(stateDir, INSTANCE_LOCK_FILE) });
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

// A lock as some other process would have left it. `machine: undefined` writes
// no machine field at all — a lock from before this field existed.
function writeLock(stateDir, fields) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, INSTANCE_LOCK_FILE);
  const record = {
    schema: INSTANCE_LOCK_SCHEMA,
    hostname: os.hostname(),
    nonce: 'foreign-owner',
    acquiredAt: new Date().toISOString(),
    ...fields,
  };
  if (record.machine === undefined) delete record.machine;
  fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`);
  return fs.readFileSync(lockPath, 'utf8');
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  // Reap it, or `ps` still reports the zombie as alive with its original start.
  return child.pid;
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

test('the lock records a machine identity, and the hostname beside it is only a label', async () => {
  await withStateDir(async ({ stateDir, lockPath }) => {
    const lock = acquireInstanceLock(stateDir, { hostname: 'Alexs-Mac-mini.local', identity: THIS_MACHINE });
    assert.equal(lock.acquired, true);
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(onDisk.machine, THIS_MACHINE.id, 'the identity that will be compared');
    assert.equal(onDisk.machineSource, 'platform-uuid', 'and where it came from, for diagnosis');
    assert.equal(onDisk.hostname, 'Alexs-Mac-mini.local', 'the hostname is still recorded');
    assert.notEqual(onDisk.machine, onDisk.hostname, 'they are different things');
    lock.release();
  });
});

// THE INCIDENT. One machine, one live daemon, two hostnames an hour apart.
test('THE HOSTNAME CHANGE: a live daemon whose host renamed itself is still recognized as the owner, and can still be stopped', async () => {
  await withStateDir(async ({ stateDir, lockPath }) => {
    // 05:36 — the daemon starts. os.hostname() says Alexs-Mac-mini.local.
    const owner = acquireInstanceLock(stateDir, { hostname: 'Alexs-Mac-mini.local', identity: THIS_MACHINE });
    assert.equal(owner.acquired, true);
    owner.update({ listen: { host: '127.0.0.1', port: 3000 } });
    const before = fs.readFileSync(lockPath, 'utf8');

    // An hour later — same machine, same daemon, the network moved and macOS
    // now answers Mac.lan.
    const renamed = { hostname: 'Mac.lan', identity: THIS_MACHINE };

    const second = acquireInstanceLock(stateDir, renamed);
    assert.equal(second.acquired, false, 'a second daemon is still refused');
    assert.equal(second.reason, 'running', 'and refused as RUNNING, not as another host');
    assert.match(second.message, /http:\/\/127\.0\.0\.1:3000/, 'the refusal says where the owner is');

    const seen = inspectInstanceLock(stateDir, renamed);
    assert.equal(seen.held, true);
    assert.equal(seen.reason, 'running', 'status can see the daemon it must stop');
    assert.equal(seen.holder.pid, process.pid);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before, 'nothing was rewritten');

    // And the owner still owns it: release works from the renamed host.
    assert.equal(owner.release(), true);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test('a lock from another machine is refused and NEVER taken over, even when its pid is absent here', async () => {
  const deadPid = await exitedPid();
  await withStateDir(async ({ stateDir, lockPath }) => {
    const before = writeLock(stateDir, { pid: deadPid, processStart: EPOCH_START, machine: OTHER_MACHINE.id, hostname: 'build-box' });
    const lock = acquireInstanceLock(stateDir, { identity: THIS_MACHINE });
    assert.equal(lock.acquired, false, 'the Stage 1 guarantee: shared state is never seized');
    assert.equal(lock.reason, 'other-machine');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before, 'the other machine keeps its lock');
    assert.match(lock.message, /Stop it there/, 'points at the machine that can answer');
    assert.doesNotMatch(lock.message, /delete .*daemon\.lock and start again/);
  });
});

test('a lock from another machine is refused even when a LIVE local pid matches its number', async () => {
  await withSleeper(async (sleeper) => {
    await withStateDir(async ({ stateDir, lockPath }) => {
      const before = writeLock(stateDir, { pid: sleeper.pid, processStart: sleeper.start, machine: OTHER_MACHINE.id, hostname: 'build-box' });
      const lock = acquireInstanceLock(stateDir, { identity: THIS_MACHINE });
      assert.equal(lock.acquired, false);
      assert.equal(lock.reason, 'other-machine', 'a local pid says nothing about a remote lock');
      assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
      assert.equal(sleeper.exit(), null, 'and nothing was signaled');
    });
  });
});

// The upgrade migration. A lock written by the OLD code carries only a hostname.
test('MIGRATION: an old lock, no machine field, whose host renamed itself — the live owner is found by pid and start time', async () => {
  await withSleeper(async (sleeper) => {
    await withStateDir(async ({ stateDir, lockPath }) => {
      const before = writeLock(stateDir, {
        pid: sleeper.pid,
        processStart: sleeper.start,
        hostname: 'Alexs-Mac-mini.local',
        machine: undefined,
        listen: { host: '127.0.0.1', port: 3000 },
      });
      assert.equal(JSON.parse(before).machine, undefined, 'the fixture really is an old-format lock');

      const now = { hostname: 'Mac.lan', identity: THIS_MACHINE };
      const seen = inspectInstanceLock(stateDir, now);
      assert.equal(seen.held, true);
      assert.equal(seen.reason, 'running', 'an upgrade must not strand a daemon that is still running');
      assert.equal(seen.holder.pid, sleeper.pid);

      const second = acquireInstanceLock(stateDir, now);
      assert.equal(second.acquired, false);
      assert.equal(second.reason, 'running');
      assert.equal(fs.readFileSync(lockPath, 'utf8'), before, 'and the running owner keeps its lock');
      assert.equal(sleeper.exit(), null);
    });
  });
});

test('MIGRATION: an old lock whose host renamed itself and whose pid is gone is refused, never seized', async () => {
  const deadPid = await exitedPid();
  await withStateDir(async ({ stateDir, lockPath }) => {
    const before = writeLock(stateDir, { pid: deadPid, processStart: EPOCH_START, hostname: 'Alexs-Mac-mini.local', machine: undefined });
    const lock = acquireInstanceLock(stateDir, { hostname: 'Mac.lan', identity: THIS_MACHINE });
    assert.equal(lock.acquired, false, 'a pid absent HERE is not proof it is absent THERE');
    assert.equal(lock.reason, 'legacy-other-host');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
    assert.match(lock.message, /is not running on this machine/);
    assert.match(lock.message, /stop --force/, 'and the CLI, not an rm, is the way out');
  });
});

test('MIGRATION: an old lock whose hostname still matches behaves exactly as it did before', async () => {
  const deadPid = await exitedPid();
  await withStateDir(async ({ stateDir }) => {
    writeLock(stateDir, { pid: deadPid, processStart: EPOCH_START, hostname: 'Mac.lan', machine: undefined });
    const lock = acquireInstanceLock(stateDir, { hostname: 'Mac.lan', identity: THIS_MACHINE });
    assert.equal(lock.acquired, true, 'an exited owner on this host is still taken over');
    assert.equal(lock.tookOver?.reason, 'owner-exited');
    lock.release();
  });
});

test('when this machine cannot say who it is, the hostname decides — and says so', async () => {
  const deadPid = await exitedPid();
  await withStateDir(async ({ stateDir }) => {
    // Same hostname: fall back to exactly the old behaviour rather than strand.
    writeLock(stateDir, { pid: deadPid, processStart: EPOCH_START, hostname: 'Mac.lan', machine: OTHER_MACHINE.id });
    const permitted = acquireInstanceLock(stateDir, { hostname: 'Mac.lan', identity: NO_IDENTITY });
    assert.equal(permitted.acquired, true, 'a dead owner on the same hostname is still taken over');
    permitted.release();
  });
  await withStateDir(async ({ stateDir, lockPath }) => {
    const before = writeLock(stateDir, { pid: deadPid, processStart: EPOCH_START, hostname: 'build-box', machine: OTHER_MACHINE.id });
    const refused = acquireInstanceLock(stateDir, { hostname: 'Mac.lan', identity: NO_IDENTITY });
    assert.equal(refused.acquired, false);
    assert.equal(refused.reason, 'identity-unavailable');
    assert.match(refused.message, /ioreg is not on PATH/, 'the refusal says WHY it could not check');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
  });
});

// Requirement 4: the advice must fit the evidence. Three findings about the
// recorded pid, three different things to say.
test('the refusal has three variants, and the pid decides which: alive here, absent here, uncheckable', async () => {
  const deadPid = await exitedPid();
  await withSleeper(async (sleeper) => {
    // 1. Alive here, and it IS the owner: never "delete the lock".
    await withStateDir(async ({ stateDir }) => {
      writeLock(stateDir, { pid: sleeper.pid, processStart: sleeper.start, hostname: 'Alexs-Mac-mini.local', machine: undefined });
      const seen = inspectInstanceLock(stateDir, { hostname: 'Mac.lan', identity: THIS_MACHINE });
      assert.equal(seen.reason, 'running');
      assert.match(seen.message, /already owns this state directory/);
      assert.doesNotMatch(seen.message, /delete/);
    });
    // 1b. Alive here, and it is NOT the owner: say so, and do not signal it.
    await withStateDir(async ({ stateDir }) => {
      writeLock(stateDir, { pid: sleeper.pid, processStart: null, hostname: os.hostname(), machine: THIS_MACHINE.id });
      const seen = inspectInstanceLock(stateDir, { identity: THIS_MACHINE });
      assert.equal(seen.reason, 'unverifiable');
      assert.match(seen.message, /is running on this machine but did NOT start when the lock records/);
      assert.match(seen.message, /must not be signaled/);
      assert.equal(seen.owner.state, 'alive');
    });
    // 2. Absent here: safe to clear, and here is the command.
    await withStateDir(async ({ stateDir }) => {
      writeLock(stateDir, { pid: deadPid, processStart: EPOCH_START, hostname: 'Alexs-Mac-mini.local', machine: undefined });
      const seen = inspectInstanceLock(stateDir, { hostname: 'Mac.lan', identity: THIS_MACHINE });
      assert.equal(seen.owner.state, 'gone');
      assert.match(seen.message, /is not running on this machine, so there is nothing here to signal/);
      assert.match(seen.message, /safe to clear: .*stop --force/);
    });
    // 3. Uncheckable: explain why, and name the machine that can answer.
    await withStateDir(async ({ stateDir }) => {
      writeLock(stateDir, { pid: deadPid, processStart: EPOCH_START, hostname: 'build-box', machine: OTHER_MACHINE.id });
      const seen = inspectInstanceLock(stateDir, { hostname: 'Mac.lan', identity: THIS_MACHINE });
      assert.equal(seen.reason, 'other-machine');
      assert.match(seen.message, /if that daemon runs, it runs on "build-box"/);
      assert.match(seen.message, /Stop it there/);
      assert.match(seen.message, /Only if .* is NOT shared with that machine/);
    });
    assert.equal(sleeper.exit(), null);
  });
});

test('inspect reports what the owner pid looks like from here, so a caller can say more than "unknown"', async () => {
  await withSleeper(async (sleeper) => {
    await withStateDir(async ({ stateDir }) => {
      writeLock(stateDir, { pid: sleeper.pid, processStart: EPOCH_START, hostname: 'build-box', machine: OTHER_MACHINE.id });
      const seen = inspectInstanceLock(stateDir, { hostname: 'Mac.lan', identity: THIS_MACHINE });
      assert.equal(seen.held, true);
      assert.equal(seen.reason, 'other-machine');
      assert.equal(seen.owner.state, 'alive', 'the pid IS alive here, and the report says so');
      assert.equal(seen.holder.machine, OTHER_MACHINE.id);
      assert.equal(seen.identity.id, THIS_MACHINE.id);
      assert.ok(Array.isArray(seen.remedy) && seen.remedy.length, 'and hands the caller the remedy lines');
      assert.equal(sleeper.exit(), null, 'inspect signals nothing');
    });
  });
});

test('a lock whose machine field is not a string is not a lock this Orca wrote', async () => {
  await withStateDir(async ({ stateDir, lockPath }) => {
    const before = writeLock(stateDir, { pid: process.pid, processStart: EPOCH_START, machine: { id: 'nope' } });
    const lock = acquireInstanceLock(stateDir, { identity: THIS_MACHINE });
    assert.equal(lock.acquired, false);
    assert.equal(lock.reason, 'unreadable');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
  });
});
