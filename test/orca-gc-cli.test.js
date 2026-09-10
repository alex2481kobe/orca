// `node src/orca-cli.js gc`, driven as a real subprocess: dry run by default,
// --apply only moves, it refuses while another process owns the state directory,
// and purging needs its own flag and an age threshold.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendJournalEntries } from '../src/lane-journal.js';
import { acquireInstanceLock } from '../src/instance-lock.js';
import { readLaneArchive } from '../src/lane-archive.js';
import { cleanChildEnv } from './helpers/bridge-client.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'orca-cli.js');
const DAY = 24 * 60 * 60 * 1000;

function gc(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [CLI, 'gc', ...args], { cwd: cwd || ROOT, env: cleanChildEnv(), encoding: 'utf8', timeout: 30000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.statSync(full).size;
    }
  };
  walk(dir);
  return out;
}

async function withSeededStateDir(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-gc-cli-'));
  const stateDir = path.join(root, '.orca');
  const old = new Date(Date.now() - 30 * DAY).toISOString();
  const fresh = new Date(Date.now() - 1 * DAY).toISOString();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
    version: 4, projects: [], orchestrators: [], auditEvents: [], toolLeases: [], agentQueue: [], policies: {}, archivedLanes: [],
    lanes: [
      { id: 'old-lane', sessionId: 'orc_1', title: 'Old work', state: 'failed', completedAt: old, updatedAt: old },
      { id: 'fresh-lane', sessionId: 'orc_1', title: 'Fresh work', state: 'done', completedAt: fresh, updatedAt: fresh },
    ],
  }));
  appendJournalEntries(stateDir, 'old-lane', 'logs', [{ at: old, message: 'old line' }]);
  appendJournalEntries(stateDir, 'fresh-lane', 'logs', [{ at: fresh, message: 'fresh line' }]);
  try { return await fn(stateDir, root); } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('gc is a dry run by default: it says what would move and why, and changes nothing', async () => {
  await withSeededStateDir(async (stateDir) => {
    const before = tree(stateDir);
    const run = gc(['--state-dir', stateDir]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /dry run/);
    assert.match(run.stdout, /would archive lane old-lane "Old work": terminal \(failed\) and unchanged for 30(\.\d)? days \(threshold 14\)/);
    assert.doesNotMatch(run.stdout, /fresh-lane/);
    assert.deepEqual(tree(stateDir), before);

    const asJson = gc(['--state-dir', stateDir, '--json', '--older-than-days', '0']);
    assert.equal(asJson.code, 0, asJson.stderr);
    const parsed = JSON.parse(asJson.stdout);
    assert.equal(parsed.apply, false);
    assert.deepEqual(parsed.plan.actions.filter((action) => action.kind === 'archive-lane').map((action) => action.laneId).sort(), ['fresh-lane', 'old-lane']);
    assert.deepEqual(tree(stateDir), before);
  });
});

test('gc --apply refuses while another process owns the state directory, then moves (never deletes) once it is free', async () => {
  await withSeededStateDir(async (stateDir) => {
    const lock = acquireInstanceLock(stateDir);
    assert.equal(lock.acquired, true);
    const before = tree(stateDir);
    let refused;
    try {
      refused = gc(['--state-dir', stateDir, '--apply']);
    } finally {
      lock.release();
    }
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Refusing to apply: another process owns/);
    assert.match(refused.stderr, new RegExp(`pid ${process.pid}`));
    assert.match(refused.stderr, /Nothing was changed/);
    const afterRefusal = tree(stateDir);
    delete before['daemon.lock'];
    assert.deepEqual(afterRefusal, before, 'a refused apply changes nothing');

    const applied = gc(['--state-dir', stateDir, '--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /\(APPLY\)/);
    assert.match(applied.stdout, /archive lane old-lane/);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    assert.deepEqual(state.lanes.map((lane) => lane.id), ['fresh-lane']);
    assert.deepEqual(readLaneArchive(stateDir, 'old-lane').logs.map((entry) => entry.message), ['old line']);
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false, 'gc releases the lock it took');
  });
});

test('gc purge needs --purge-archive AND --purge-older-than-days; bad numbers are usage errors', async () => {
  await withSeededStateDir(async (stateDir) => {
    const before = tree(stateDir);
    const noThreshold = gc(['--state-dir', stateDir, '--purge-archive', '--apply']);
    assert.equal(noThreshold.code, 1);
    assert.match(noThreshold.stdout, /--purge-older-than-days/);
    const noFlag = gc(['--state-dir', stateDir, '--purge-older-than-days', '5']);
    assert.equal(noFlag.code, 2);
    assert.match(noFlag.stderr, /only applies with --purge-archive/);
    const badNumber = gc(['--state-dir', stateDir, '--older-than-days', 'soon']);
    assert.equal(badNumber.code, 2);
    const purgeDry = gc(['--state-dir', stateDir, '--purge-archive', '--purge-older-than-days', '1']);
    assert.equal(purgeDry.code, 0, purgeDry.stderr);
    assert.deepEqual(tree(stateDir), before, 'a dry purge changes nothing');
  });
});

test('gc on a missing state directory has nothing to do', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-gc-empty-'));
  try {
    const run = gc(['--state-dir', path.join(root, '.orca'), '--apply']);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /nothing to do/);
    assert.equal(fs.existsSync(path.join(root, '.orca')), false, 'gc does not create a state directory');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
