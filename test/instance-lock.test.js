import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireInstanceLock,
  probeProcess,
  INSTANCE_LOCK_FILE,
  INSTANCE_LOCK_SCHEMA,
} from '../src/instance-lock.js';

// Every case runs in a fresh temp state directory. Nothing here signals any
// process other than the sleepers this file spawns itself.

async function withStateDir(callback) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-lock-'));
  const stateDir = path.join(root, '.orca');
  try {
    return await callback({ stateDir, lockPath: path.join(stateDir, INSTANCE_LOCK_FILE) });
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function writeForeignLock(stateDir, fields) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, INSTANCE_LOCK_FILE);
  fs.writeFileSync(lockPath, `${JSON.stringify({
    schema: INSTANCE_LOCK_SCHEMA,
    hostname: os.hostname(),
    nonce: 'foreign-owner',
    acquiredAt: new Date().toISOString(),
    ...fields,
  })}\n`);
  return fs.readFileSync(lockPath, 'utf8');
}

// A pid that existed and has exited.
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

// A live process that is NOT an Orca daemon — what a reused pid points at.
async function withSleeper(callback) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  for (let i = 0; i < 100 && probeProcess(child.pid).state !== 'alive'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    return await callback({ pid: child.pid, exit: () => exit });
  } finally {
    if (exit === null) child.kill('SIGKILL');
  }
}

const EPOCH_START = 'Thu Jan 1 00:00:00 1970';

test('instance lock: the first start owns the state dir; a second is refused as running; release frees it', async () => {
  await withStateDir(async ({ stateDir, lockPath }) => {
    const first = acquireInstanceLock(stateDir);
    assert.equal(first.acquired, true);
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.processStart, probeProcess(process.pid).start, 'the lock records identity beyond the pid');
    assert.ok(onDisk.processStart, 'this platform can read a process start time');

    const second = acquireInstanceLock(stateDir);
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'running');
    assert.equal(second.holder.nonce, onDisk.nonce);
    assert.match(second.message, new RegExp(`pid ${process.pid}`));
    assert.match(second.message, /no process was signaled/);

    assert.equal(first.release(), true);
    assert.equal(fs.existsSync(lockPath), false);
    const third = acquireInstanceLock(stateDir);
    assert.equal(third.acquired, true);
    third.release();
  });
});

test('instance lock: release never removes a lock it no longer owns', async () => {
  await withStateDir(async ({ stateDir, lockPath }) => {
    const owned = acquireInstanceLock(stateDir);
    const foreign = writeForeignLock(stateDir, { pid: process.pid, processStart: probeProcess(process.pid).start });
    assert.equal(owned.release(), false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), foreign);
  });
});

test('instance lock: a lock left by an exited process is taken over', async () => {
  await withStateDir(async ({ stateDir, lockPath }) => {
    writeForeignLock(stateDir, { pid: await exitedPid(), processStart: EPOCH_START });
    const lock = acquireInstanceLock(stateDir);
    assert.equal(lock.acquired, true, lock.message);
    assert.equal(lock.tookOver?.reason, 'owner-exited');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
    assert.equal(fs.existsSync(`${lockPath}.takeover`), false, 'the takeover guard is cleaned up');
    lock.release();
  });
});

test('instance lock: PID REUSE — a live pid with a different start time is not the owner; taken over without signaling it', async () => {
  await withSleeper(async (sleeper) => {
    await withStateDir(async ({ stateDir }) => {
      writeForeignLock(stateDir, { pid: sleeper.pid, processStart: EPOCH_START });
      const lock = acquireInstanceLock(stateDir);
      assert.equal(lock.acquired, true, lock.message);
      assert.equal(lock.tookOver?.reason, 'pid-reused');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sleeper.exit(), null, 'the process now holding the reused pid was not signaled');
      assert.equal(probeProcess(sleeper.pid).state, 'alive');
      lock.release();
    });
  });
});

test('instance lock: a live pid whose start time matches IS the owner — refused, never treated as stale', async () => {
  await withSleeper(async (sleeper) => {
    await withStateDir(async ({ stateDir, lockPath }) => {
      const before = writeForeignLock(stateDir, { pid: sleeper.pid, processStart: probeProcess(sleeper.pid).start });
      const lock = acquireInstanceLock(stateDir);
      assert.equal(lock.acquired, false);
      assert.equal(lock.reason, 'running');
      assert.equal(fs.readFileSync(lockPath, 'utf8'), before, 'the live owner\'s lock is untouched');
      assert.equal(sleeper.exit(), null);
    });
  });
});

test("instance lock: anything that cannot be verified fails safe — refused, lock untouched, and never told to delete a live daemon's lock", async () => {
  const deadPid = await exitedPid();
  await withSleeper(async (sleeper) => {
    const cases = [
      ['unreadable', (stateDir) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, INSTANCE_LOCK_FILE), '{"schema":'); }, {}, /move it aside/],
      ['unreadable', (stateDir) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, INSTANCE_LOCK_FILE), ''); }, {}, /move it aside/],
      // A hostname is a label, not an identity. A lock carrying only a hostname
      // was written before machine identity existed, so a mismatch is not proof
      // of another machine. It is still refused — but with the remedy the pid
      // actually supports, not "delete this file".
      ['legacy-other-host', (stateDir) => writeForeignLock(stateDir, { pid: deadPid, processStart: EPOCH_START, hostname: 'some-other-host' }), {}, /is not running on this machine/],
      ['unverifiable', (stateDir) => writeForeignLock(stateDir, { pid: sleeper.pid, processStart: null }), {}, /must not be signaled/],
      // A platform where this process cannot read even its own start time must
      // never declare anyone's lock stale — not even a dead pid's.
      ['unverifiable', (stateDir) => writeForeignLock(stateDir, { pid: deadPid, processStart: EPOCH_START }), { probe: () => ({ state: 'unknown', start: null }) }, /cannot be checked from here/],
    ];
    for (const [expected, arrange, options, remedy] of cases) {
      await withStateDir(async ({ stateDir, lockPath }) => {
        arrange(stateDir);
        const before = fs.readFileSync(lockPath, 'utf8');
        const lock = acquireInstanceLock(stateDir, options);
        assert.equal(lock.acquired, false, `${expected}: must refuse`);
        assert.equal(lock.reason, expected);
        assert.equal(fs.readFileSync(lockPath, 'utf8'), before, `${expected}: lock untouched`);
        assert.match(lock.message, remedy, `${expected}: says what this machine can see about the pid`);
        assert.doesNotMatch(
          lock.message,
          /delete .*daemon\.lock and start again/,
          `${expected}: must not advise deleting a lock a live daemon may hold`,
        );
      });
    }
    assert.equal(sleeper.exit(), null);
  });
});

test('instance lock: a takeover already in progress is never raced', async () => {
  await withStateDir(async ({ stateDir, lockPath }) => {
    const before = writeForeignLock(stateDir, { pid: await exitedPid(), processStart: EPOCH_START });
    fs.writeFileSync(`${lockPath}.takeover`, '{}\n');
    const lock = acquireInstanceLock(stateDir);
    assert.equal(lock.acquired, false);
    assert.equal(lock.reason, 'takeover-in-progress');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
  });
});

test('instance lock: update records the listener so a refused duplicate can say where the owner is', async () => {
  await withStateDir(async ({ stateDir }) => {
    const owned = acquireInstanceLock(stateDir);
    assert.equal(owned.update({ listen: { host: '127.0.0.1', port: 45123 } }), true);
    const refused = acquireInstanceLock(stateDir);
    assert.equal(refused.reason, 'running');
    assert.match(refused.message, /http:\/\/127\.0\.0\.1:45123/);
    owned.release();
    assert.equal(owned.update({ listen: null }), false, 'a released lock cannot be rewritten');
  });
});

// The LaunchAgent-vs-shell hazard: the owner records its start time under one
// TZ/locale and a later start checks it under another. If `ps` formatted the
// two differently, a LIVE owner would look like a reused pid and lose its lock.
test('instance lock: an owner in a DIFFERENT timezone and locale is still recognized — no false "pid reused"', async () => {
  await withStateDir(async ({ stateDir, lockPath }) => {
    const moduleUrl = new URL('../src/instance-lock.js', import.meta.url).href;
    const script = [
      `const { acquireInstanceLock } = await import(${JSON.stringify(moduleUrl)});`,
      'const lock = acquireInstanceLock(process.argv[1]);',
      "process.stdout.write(JSON.stringify({ acquired: lock.acquired }) + '\\n');",
      'setInterval(() => {}, 1 << 30);',
    ].join('\n');
    const owner = spawn(process.execPath, ['--input-type=module', '-e', script, stateDir], {
      env: { ...process.env, TZ: 'Pacific/Kiritimati', LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const line = await new Promise((resolve, reject) => {
        owner.stdout.once('data', (chunk) => resolve(String(chunk)));
        owner.once('exit', (code) => reject(new Error(`lock owner exited early (${code})`)));
      });
      assert.deepEqual(JSON.parse(line), { acquired: true });
      const before = fs.readFileSync(lockPath, 'utf8');
      const contender = acquireInstanceLock(stateDir);
      assert.equal(contender.acquired, false, 'a live owner in another timezone must not read as a reused pid');
      assert.equal(contender.reason, 'running');
      assert.equal(fs.readFileSync(lockPath, 'utf8'), before, 'the live owner keeps its lock');
    } finally {
      owner.kill('SIGKILL');
    }
  });
});

test('instance lock: inspect is read-only — reports a live owner as held, a stale or missing lock as free, and creates nothing', async () => {
  const { inspectInstanceLock } = await import('../src/instance-lock.js');
  await withStateDir(async ({ stateDir, lockPath }) => {
    assert.equal(inspectInstanceLock(stateDir).held, false, 'no state dir: not held');
    assert.equal(fs.existsSync(stateDir), false, 'inspect did not create the state dir');
    const owned = acquireInstanceLock(stateDir);
    const live = inspectInstanceLock(stateDir);
    assert.equal(live.held, true);
    assert.equal(live.reason, 'running');
    assert.match(live.message, /Refusing to open this state directory/);
    owned.release();
    writeForeignLock(stateDir, { pid: await exitedPid(), processStart: EPOCH_START });
    const before = fs.readFileSync(lockPath, 'utf8');
    assert.equal(inspectInstanceLock(stateDir).held, false, 'an exited owner does not hold the state');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before, 'inspect never takes over or rewrites a lock');
  });
});
