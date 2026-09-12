// Retention: what leaves hot state, when, and that nothing is lost on the way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendJournalEntries, readJournalAll } from '../src/lane-journal.js';
import { archiveLane, readLaneArchive } from '../src/lane-archive.js';
import { applyGc, planGc, renderRetentionMarkdown, RETENTION } from '../src/state-gc.js';
import { laneJournalDir, statePaths } from '../src/state-paths.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const daysAgo = (days, from = NOW) => new Date(from - days * DAY).toISOString();

async function withStateDir(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-gc-'));
  try { return await fn(path.join(root, '.orca'), root); } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) { previous[key] = process.env[key]; process.env[key] = value; }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

function snapshotTree(dir) {
  const out = {};
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else { const stat = fs.statSync(full); out[path.relative(dir, full)] = `${stat.size}:${stat.mtimeMs}`; }
    }
  };
  walk(dir);
  return out;
}

const lane = (id, fields) => ({ id, sessionId: 'orc_1', orchestratorId: 'orc_1', projectId: 'prj_1', title: id, executorType: 'mock', createdAt: daysAgo(60), ...fields });

function seed(stateDir) {
  const worktrees = path.join(statePaths(stateDir).workspacesDir, 'orc_1', 'worktrees');
  fs.mkdirSync(path.join(worktrees, 'old-isolated'), { recursive: true });
  fs.mkdirSync(path.join(worktrees, 'old-integrated'), { recursive: true });
  fs.mkdirSync(path.join(worktrees, 'nobody'), { recursive: true });
  const repoRoot = path.join(path.dirname(stateDir), 'repo');
  const lanes = [
    lane('old-done', { state: 'done', auditState: 'accepted', completedAt: daysAgo(30), updatedAt: daysAgo(30), logCount: 3, agentEventCount: 2 }),
    lane('recent-failed', { state: 'failed', completedAt: daysAgo(2), updatedAt: daysAgo(2) }),
    lane('old-awaiting', { state: 'done', auditState: 'queued', completedAt: daysAgo(40), updatedAt: daysAgo(40) }),
    lane('old-isolated', { state: 'stopped', completedAt: daysAgo(40), updatedAt: daysAgo(40), repoRoot, worktreePath: path.join(worktrees, 'old-isolated') }),
    lane('old-integrated', { state: 'accepted', completedAt: daysAgo(40), updatedAt: daysAgo(40), repoRoot, worktreePath: path.join(worktrees, 'old-integrated'), integratedAt: daysAgo(39) }),
    lane('running', { state: 'running', updatedAt: daysAgo(40) }),
  ];
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ version: 4, projects: [], orchestrators: [], lanes, auditEvents: [], toolLeases: [], agentQueue: [], policies: {}, archivedLanes: [] }));
  for (const id of ['old-done', 'recent-failed', 'old-integrated']) {
    appendJournalEntries(stateDir, id, 'logs', [{ at: 'a', message: `${id} 1` }, { at: 'b', message: `${id} 2` }, { at: 'c', message: `${id} 3` }]);
    appendJournalEntries(stateDir, id, 'agentEvents', [{ id: `${id}-e1`, type: 'agent.started' }, { id: `${id}-e2`, type: 'agent.done' }]);
  }
  appendJournalEntries(stateDir, 'lane-gone', 'logs', [{ at: 'x', message: 'orphaned line' }]);
  fs.writeFileSync(path.join(stateDir, 'state.json.v2.bak'), '{"version":2}');
  fs.writeFileSync(path.join(stateDir, 'state.json.corrupt.20260101010101.123.abcd1234'), '{ broken');
  const oldTemp = path.join(stateDir, 'state.json.123.1700000000000.1b4e28ba-2fa1-11d2-883f-0016d3cca427.tmp');
  const youngTemp = path.join(stateDir, 'state.json.124.1700000000001.1b4e28ba-2fa1-11d2-883f-0016d3cca428.tmp');
  fs.writeFileSync(oldTemp, 'partial');
  fs.writeFileSync(youngTemp, 'in flight');
  fs.utimesSync(oldTemp, new Date(NOW - 2 * 60 * 60 * 1000), new Date(NOW - 2 * 60 * 60 * 1000));
  fs.utimesSync(youngTemp, new Date(NOW - 60 * 1000), new Date(NOW - 60 * 1000));
}

const byKind = (plan, kind) => plan.actions.filter((action) => action.kind === kind);
const countEntries = (stateDir, ids) => ids.reduce((sum, id) => sum + readJournalAll(stateDir, id, 'logs').length + readJournalAll(stateDir, id, 'agentEvents').length, 0);

test('lane archive: every entry, including rotated and archived segments, round-trips; then the journals go', async () => {
  await withStateDir(async (stateDir) => {
    await withEnv({ ORCA_LANE_JOURNAL_SEGMENT_BYTES: '600', ORCA_LANE_JOURNAL_HOT_SEGMENTS: '2' }, async () => {
      for (let index = 0; index < 120; index += 1) appendJournalEntries(stateDir, 'lane-r', 'logs', [{ at: 't', message: `r${index} ${'q'.repeat(30)}` }]);
      appendJournalEntries(stateDir, 'lane-r', 'agentEvents', [{ id: 'e', type: 'agent.done' }]);
      assert.ok(fs.readdirSync(path.join(statePaths(stateDir).archivedLanesDir, 'lane-r')).length > 0, 'fixture must have archived segments');
      const record = { id: 'lane-r', title: 'rotated', state: 'done', sessionId: 'orc_1' };
      const { info, entry } = archiveLane(stateDir, record, { reason: 'test', archivedAt: daysAgo(0) });
      assert.equal(info.logCount, 120);
      assert.equal(entry.id, 'lane-r');
      assert.equal(entry.logCount, 120);
      const archived = readLaneArchive(stateDir, 'lane-r');
      assert.deepEqual(archived.logs.map((item) => item.message.split(' ')[0]), Array.from({ length: 120 }, (_, index) => `r${index}`));
      assert.deepEqual(archived.agentEvents, [{ id: 'e', type: 'agent.done' }]);
      assert.equal(archived.lane.title, 'rotated');
      assert.equal(fs.existsSync(laneJournalDir(stateDir, 'lane-r')), false, 'hot journal removed after a verified archive');
      assert.deepEqual(fs.readdirSync(path.join(statePaths(stateDir).archivedLanesDir, 'lane-r')).filter((name) => name.endsWith('.jsonl')), [], 'raw archived segments folded into the archive');
    });
  });
});

test('gc plan: says what would move and why, keeps what still needs someone, lists worktrees, and writes nothing', async () => {
  await withStateDir(async (stateDir) => {
    seed(stateDir);
    const before = snapshotTree(path.dirname(stateDir));
    const plan = planGc({ stateDir, now: NOW, olderThanDays: 14 });
    assert.deepEqual(snapshotTree(path.dirname(stateDir)), before, 'a dry run changes nothing');
    assert.equal(plan.blocked, null);

    assert.deepEqual(byKind(plan, 'archive-lane').map((action) => action.laneId).sort(), ['old-done', 'old-integrated']);
    assert.match(byKind(plan, 'archive-lane').find((action) => action.laneId === 'old-done').reason, /terminal \(done\) and unchanged for 30 days \(threshold 14\)/);
    const kept = Object.fromEntries(byKind(plan, 'keep-lane').map((action) => [action.laneId, action.reason]));
    assert.match(kept['old-awaiting'], /audit is still queued/);
    assert.match(kept['old-isolated'], /un-integrated worktree/);
    assert.equal(plan.actions.some((action) => action.laneId === 'recent-failed' || action.laneId === 'running'), false);

    const worktrees = Object.fromEntries(byKind(plan, 'list-worktree').map((action) => [action.laneId, action]));
    assert.match(worktrees['old-integrated'].hint, /lane__worktree__discard/);
    assert.match(worktrees['old-isolated'].hint, /lane__integrate/);
    assert.deepEqual(byKind(plan, 'list-orphan-worktree').map((action) => path.basename(action.worktreePath)), ['nobody']);
    assert.deepEqual(byKind(plan, 'archive-orphan-journal').map((action) => action.key), ['lane-gone']);
    assert.deepEqual(byKind(plan, 'move-legacy').map((action) => action.file).sort(), [
      'state.json.123.1700000000000.1b4e28ba-2fa1-11d2-883f-0016d3cca427.tmp',
      'state.json.corrupt.20260101010101.123.abcd1234',
      'state.json.v2.bak',
    ]);
  });
});

test('gc apply: moves exactly the plan, loses no entry, deletes nothing, and never touches worktrees', async () => {
  await withStateDir(async (stateDir) => {
    seed(stateDir);
    const entriesBefore = countEntries(stateDir, ['old-done', 'recent-failed', 'old-integrated', 'lane-gone']);
    const plan = planGc({ stateDir, now: NOW, olderThanDays: 14 });
    const results = applyGc(plan, { now: NOW });
    assert.ok(results.length >= 6);

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    assert.deepEqual(state.lanes.map((item) => item.id).sort(), ['old-awaiting', 'old-isolated', 'recent-failed', 'running']);
    assert.deepEqual(state.archivedLanes.map((item) => item.id).sort(), ['old-done', 'old-integrated']);
    const doneEntry = state.archivedLanes.find((item) => item.id === 'old-done');
    assert.equal(doneEntry.sessionId, 'orc_1');
    assert.match(doneEntry.reason, /^gc: terminal \(done\)/);

    const archivedDone = readLaneArchive(stateDir, 'old-done');
    assert.deepEqual(archivedDone.logs.map((item) => item.message), ['old-done 1', 'old-done 2', 'old-done 3']);
    assert.equal(archivedDone.lane.title, 'old-done');
    assert.equal(fs.existsSync(laneJournalDir(stateDir, 'old-done')), false);
    assert.deepEqual(readLaneArchive(stateDir, 'lane-gone').logs.map((item) => item.message), ['orphaned line']);

    const archivedEntries = ['old-done', 'old-integrated', 'lane-gone'].reduce((sum, id) => {
      const archive = readLaneArchive(stateDir, id);
      return sum + archive.logs.length + archive.agentEvents.length;
    }, 0);
    assert.equal(archivedEntries + countEntries(stateDir, ['recent-failed']), entriesBefore, 'every journal entry is in an archive or still hot');

    const legacyDirs = fs.readdirSync(statePaths(stateDir).legacyDir);
    assert.equal(legacyDirs.length, 1);
    const legacy = fs.readdirSync(path.join(statePaths(stateDir).legacyDir, legacyDirs[0])).sort();
    assert.deepEqual(legacy, ['manifest.json', 'state.json.123.1700000000000.1b4e28ba-2fa1-11d2-883f-0016d3cca427.tmp', 'state.json.corrupt.20260101010101.123.abcd1234', 'state.json.v2.bak'].sort());
    assert.equal(fs.existsSync(path.join(stateDir, 'state.json.124.1700000000001.1b4e28ba-2fa1-11d2-883f-0016d3cca428.tmp')), true, 'a young temp file is left alone');
    for (const name of ['old-isolated', 'old-integrated', 'nobody']) {
      assert.equal(fs.existsSync(path.join(statePaths(stateDir).workspacesDir, 'orc_1', 'worktrees', name)), true, `worktree ${name} untouched`);
    }
  });
});

test('gc purge: needs its own flag and an age threshold, and deletes only archive entries older than it', async () => {
  await withStateDir(async (stateDir) => {
    seed(stateDir);
    applyGc(planGc({ stateDir, now: NOW, olderThanDays: 14 }), { now: NOW });

    const unthresholded = planGc({ stateDir, now: NOW + 20 * DAY, purgeArchive: true });
    assert.match(unthresholded.blocked, /--purge-older-than-days/);
    assert.throws(() => applyGc(unthresholded, { now: NOW + 20 * DAY }), /--purge-older-than-days/);
    assert.equal(planGc({ stateDir, now: NOW + 20 * DAY }).actions.some((action) => action.kind === 'purge'), false, 'no purge without --purge-archive');

    const tooYoung = planGc({ stateDir, now: NOW + 20 * DAY, purgeArchive: true, purgeOlderThanDays: 30 });
    assert.equal(byKind(tooYoung, 'purge').length, 0);

    const plan = planGc({ stateDir, now: NOW + 20 * DAY, purgeArchive: true, purgeOlderThanDays: 10 });
    const targets = byKind(plan, 'purge').map((action) => action.target);
    assert.equal(targets.filter((target) => target.startsWith(path.join('archive', 'lanes'))).length, 3);
    assert.equal(targets.filter((target) => target.startsWith(path.join('archive', 'legacy'))).length, 1);
    // The same run also archives what has aged past the lane threshold since
    // (recent-failed is now 22 days old); a purge never touches hot lanes.
    assert.deepEqual(byKind(plan, 'archive-lane').map((action) => action.laneId), ['recent-failed']);
    applyGc(plan, { now: NOW + 20 * DAY });
    for (const target of targets) assert.equal(fs.existsSync(path.join(stateDir, target)), false, `${target} purged`);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    assert.deepEqual(state.archivedLanes.map((entry) => entry.id), ['recent-failed'], 'index entries of purged archives are dropped; the fresh one stays');
    assert.equal(readLaneArchive(stateDir, 'recent-failed').logs.length, 3);
    assert.deepEqual(state.lanes.map((item) => item.id).sort(), ['old-awaiting', 'old-isolated', 'running'], 'hot lanes are never purged');
  });
});

test('the retention doc renders exactly the retention table the code enforces', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'state-retention.md'), 'utf8');
  const match = /<!-- retention-table:start -->\n([\s\S]*?)<!-- retention-table:end -->/.exec(doc);
  assert.ok(match, 'docs/state-retention.md carries the generated retention table');
  assert.equal(match[1], renderRetentionMarkdown(), 'regenerate the table: node -e "import(\'./src/state-gc.js\').then((m) => process.stdout.write(m.renderRetentionMarkdown()))"');
  for (const entry of RETENTION) assert.ok(doc.includes(entry.path), `doc names ${entry.path}`);
});
