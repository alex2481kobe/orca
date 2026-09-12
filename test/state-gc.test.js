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
import { applyGc, ARCHIVED_ARTIFACTS_MARKER, formatGcPlan, planGc, renderRetentionMarkdown, RETENTION } from '../src/state-gc.js';
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

// ---------------------------------------------------------------------------
// Artifacts. gc used to report artifacts/ size and manage nothing in it: 808 MB
// against a 1.2 GB state directory on the owner's machine, holding per-lane
// stdout.log / terminal.log / transcript.json of 1-2 MB each that no retention
// rule touched. A lane's artifacts now follow the same rule its journals do —
// moved into archive/ when the lane is archived, deleted only by the explicit
// two-flag purge — with one extra guarantee: result.txt, the only complete copy
// of a long agent report, is the LAST thing to go.
// ---------------------------------------------------------------------------

// The artifacts tree sits beside the state dir: <daemon cwd>/artifacts/<orc>/<lane>/.
function seedArtifacts(stateDir, laneIds = ['old-done', 'old-integrated', 'recent-failed']) {
  const artifactsDir = path.join(path.dirname(stateDir), 'artifacts');
  for (const id of laneIds) {
    const dir = path.join(artifactsDir, 'orc_1', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stdout.log'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(dir, 'terminal.log'), 'y'.repeat(2048));
    fs.writeFileSync(path.join(dir, 'transcript.json'), '{"lane":"' + id + '"}');
    fs.writeFileSync(path.join(dir, 'result.txt'), `the whole report for ${id}\n`);
  }
  return artifactsDir;
}

test('gc plan: a lane being archived takes its artifacts with it, and says how big they are', async () => {
  await withStateDir(async (stateDir) => {
    seed(stateDir);
    const artifactsDir = seedArtifacts(stateDir);
    const before = snapshotTree(path.dirname(stateDir));
    const plan = planGc({ stateDir, now: NOW, olderThanDays: 14, artifactsDir });
    assert.deepEqual(snapshotTree(path.dirname(stateDir)), before, 'a dry run still changes nothing');

    const moves = byKind(plan, 'archive-artifacts');
    assert.deepEqual(moves.map((action) => action.laneId).sort(), ['old-done', 'old-integrated'],
      'exactly the lanes being archived — a lane that stays hot keeps its artifacts');
    // Carried on the plan, so a re-plan after a v3->v4 migration still decides
    // artifacts instead of quietly leaving them behind.
    assert.equal(plan.artifactsDir, artifactsDir);
    const one = moves.find((action) => action.laneId === 'old-done');
    assert.ok(one.bytes > 4000, 'the plan says how much it would move');
    assert.equal(one.hasResult, true, 'and flags the lane whose complete report is in there');
    assert.match(one.reason, /archived/);
    // recent-failed stays hot, so its artifacts are untouched and unplanned.
    assert.equal(moves.some((action) => action.laneId === 'recent-failed'), false);
  });
});

test('gc apply: artifacts are MOVED into the archive beside the lane, never deleted', async () => {
  await withStateDir(async (stateDir) => {
    seed(stateDir);
    const artifactsDir = seedArtifacts(stateDir);
    const plan = planGc({ stateDir, now: NOW, olderThanDays: 14, artifactsDir });
    applyGc(plan, { now: NOW });

    const archived = path.join(statePaths(stateDir).archivedArtifactsDir, 'orc_1', 'old-done');
    assert.equal(fs.existsSync(path.join(artifactsDir, 'orc_1', 'old-done')), false, 'gone from the hot artifacts tree');
    assert.equal(fs.readFileSync(path.join(archived, 'result.txt'), 'utf8'), 'the whole report for old-done\n',
      'and whole in the archive — the report is moved, never destroyed');
    for (const name of ['stdout.log', 'terminal.log', 'transcript.json']) {
      assert.ok(fs.existsSync(path.join(archived, name)), `${name} moved with it`);
    }
    // A marker records when and why, so the purge has an age to work from and the
    // lane it belongs to can be checked before anything is deleted.
    const marker = JSON.parse(fs.readFileSync(path.join(archived, ARCHIVED_ARTIFACTS_MARKER), 'utf8'));
    assert.equal(marker.laneId, 'old-done');
    assert.equal(marker.sessionId, 'orc_1');
    assert.ok(marker.archivedAt);
    assert.equal(marker.hasResult, true);
    // The lane that stayed hot kept everything.
    assert.ok(fs.existsSync(path.join(artifactsDir, 'orc_1', 'recent-failed', 'result.txt')));
  });
});

test('gc purge: archived artifacts need the same two flags, and go only with their lane', async () => {
  await withStateDir(async (stateDir) => {
    seed(stateDir);
    const artifactsDir = seedArtifacts(stateDir);
    applyGc(planGc({ stateDir, now: NOW, olderThanDays: 14, artifactsDir }), { now: NOW });
    const archived = path.join(statePaths(stateDir).archivedArtifactsDir, 'orc_1', 'old-done');
    assert.ok(fs.existsSync(archived));

    // Neither flag alone deletes anything.
    const later = NOW + 40 * DAY;
    assert.equal(byKind(planGc({ stateDir, now: later, artifactsDir }), 'purge-artifacts').length, 0);
    const blocked = planGc({ stateDir, now: later, purgeArchive: true, artifactsDir });
    assert.match(blocked.blocked, /--purge-older-than-days/);

    // Too young for the threshold: nothing planned.
    assert.equal(byKind(planGc({ stateDir, now: NOW + 5 * DAY, purgeArchive: true, purgeOlderThanDays: 30, artifactsDir }), 'purge-artifacts').length, 0);

    const plan = planGc({ stateDir, now: later, purgeArchive: true, purgeOlderThanDays: 30, artifactsDir });
    const artifactPurges = byKind(plan, 'purge-artifacts');
    assert.deepEqual(artifactPurges.map((action) => action.laneId).sort(), ['old-done', 'old-integrated']);
    assert.equal(artifactPurges[0].hasResult, true, 'the plan says out loud that a complete report is about to go');
    // A dry run of a purge still deletes nothing.
    assert.ok(fs.existsSync(path.join(archived, 'result.txt')));

    applyGc(plan, { now: later });
    assert.equal(fs.existsSync(archived), false, 'purged with its lane');
    // By now `recent-failed` is 42 days old too, so the same run ARCHIVES its
    // artifacts — and leaves them there. A folder archived this instant is
    // nowhere near the 30-day purge threshold, which is the point: the purge
    // takes only what is past its own threshold, never everything in archive/.
    const freshlyArchived = path.join(statePaths(stateDir).archivedArtifactsDir, 'orc_1', 'recent-failed');
    assert.equal(fs.readFileSync(path.join(freshlyArchived, 'result.txt'), 'utf8'), 'the whole report for recent-failed\n');
  });
});

test('gc purge: a lane whose archive survives keeps its artifacts, result.txt last of all', async () => {
  await withStateDir(async (stateDir) => {
    seed(stateDir);
    const artifactsDir = seedArtifacts(stateDir);
    applyGc(planGc({ stateDir, now: NOW, olderThanDays: 14, artifactsDir }), { now: NOW });
    const archived = path.join(statePaths(stateDir).archivedArtifactsDir, 'orc_1', 'old-done');

    // Hand-build a purge that would take the artifacts while the lane's own
    // archive stays: the artifacts must refuse to go first. result.txt is the
    // only complete copy of a long report, and a lane record that still exists
    // points at it — orphaning it is exactly what must not happen.
    const later = NOW + 40 * DAY;
    const plan = planGc({ stateDir, now: later, purgeArchive: true, purgeOlderThanDays: 30, artifactsDir });
    plan.actions = plan.actions.filter((action) => action.kind !== 'purge');
    const results = applyGc(plan, { now: later });

    assert.ok(fs.existsSync(path.join(archived, 'result.txt')), 'the complete report outlives a purge its lane did not join');
    const kept = results.find((item) => item.kind === 'keep-artifacts' && item.laneId === 'old-done');
    assert.ok(kept, 'and the refusal is reported, not silent');
    assert.match(kept.reason, /lane archive/);
  });
});

test('the retention doc covers artifacts as gc actually treats them', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'state-retention.md'), 'utf8');
  // The generated table must still match the code exactly (the test above), and
  // it must no longer claim artifacts are merely size-reported.
  assert.match(doc, /archive\/artifacts\/<orchestrator>\/<lane>\//);
  assert.equal(/Size reported only\./.test(renderRetentionMarkdown()), false,
    'artifacts are managed now; the table must not still say gc only reports their size');
  assert.match(renderRetentionMarkdown(), /result\.txt/);
});

// ---------------------------------------------------------------------------
// What gc did NOT do, and why. The PLAN already names what gc is leaving alone
// (keep-lane, list-worktree, list-orphan-worktree). The APPLY phase can also
// decline after the plan was made — a folder that vanished, an unwritable
// archive, a purge whose lane archive is still on disk — and until now the only
// thing a run printed was "done: N change(s) made", where N being smaller than
// the plan said nothing at all.
// ---------------------------------------------------------------------------

test('gc apply reports what it declined to do, not just how many changes it made', () => {
  const plan = {
    stateDir: '/tmp/example/.orca',
    generatedAt: new Date(NOW).toISOString(),
    olderThanDays: 14,
    actions: [
      { kind: 'archive-lane', laneId: 'a', title: 'A', reason: 'terminal and old.' },
      { kind: 'archive-artifacts', laneId: 'b', bytes: 2048, hasResult: true, reason: 'its lane is being archived.' },
    ],
    sizes: { stateJson: 1, stateJsonBak: 1, lanes: 1, archive: 1 },
  };
  const results = [
    { kind: 'archive-lane', laneId: 'a', file: 'archive/lanes/a/lane-1.json.gz' },
    { kind: 'keep-artifacts', laneId: 'b', bytes: 2048, reason: 'the lane artifacts folder could not be read' },
  ];
  const text = formatGcPlan(plan, { apply: true, results });
  assert.match(text, /done: 1 change\(s\) made\./, 'a declined action is not counted as a change');
  assert.match(text, /NOT done: artifacts of lane b left in place: the lane artifacts folder could not be read/);
  // With nothing declined the line does not appear at all.
  assert.doesNotMatch(formatGcPlan(plan, { apply: true, results: [results[0]] }), /NOT done/);
});
