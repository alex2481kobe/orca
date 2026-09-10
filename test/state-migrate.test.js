// The first v4 boot on a v3 state converts it and keeps the original verbatim.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import { readJournalAll } from '../src/lane-journal.js';
import { readLaneArchive } from '../src/lane-archive.js';
import { statePaths } from '../src/state-paths.js';
import { migrateStateDir } from '../src/state-migrate.js';
import { runGcCommand } from '../src/orca-gc-cli.js';

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const at = '2026-08-01T00:00:00.000Z';

function v3State() {
  const lane = (id, logs, events) => ({
    id, sessionId: 'orc_1', orchestratorId: 'orc_1', projectId: 'prj_1', title: id, state: 'done', executorType: 'mock', workdir: os.tmpdir(), createdAt: at, updatedAt: at, completedAt: at,
    logs: Array.from({ length: logs }, (_, n) => ({ at, message: `${id} log ${n} ${'w'.repeat(200)}` })),
    agentEvents: Array.from({ length: events }, (_, n) => ({ id: `${id}-e${n}`, at, type: 'command.output', content: `${id} event ${n} ${'v'.repeat(200)}` })),
  });
  const hot = lane('lane-hot', 300, 200);
  const dropped = lane('lane-dropped', 150, 50);
  return {
    version: 3, savedAt: at, policies: {}, projects: [], orchestrators: [], toolLeases: [], agentQueue: [],
    lanes: [hot],
    auditEvents: [
      { id: 'e1', type: 'lane_completed', laneId: 'lane-hot', createdAt: at, status: 'passed', evidence: { lane: hot } },
      { id: 'e2', type: 'lane_stopped', laneId: 'lane-dropped', createdAt: at, status: 'passed', evidence: { lane: dropped } },
      { id: 'e3', type: 'tool_lease_revoked', createdAt: at, status: 'passed', evidence: { leaseId: 'l1', reason: 'lane_completed' } },
    ],
  };
}

async function inStateDir(fn) {
  const previousCwd = process.cwd();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-migrate-'));
  process.chdir(root);
  try { return await fn(path.join(root, '.orca'), root); } finally {
    process.chdir(previousCwd);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function writeV3(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const text = JSON.stringify(v3State());
  fs.writeFileSync(path.join(stateDir, 'state.json'), text);
  fs.writeFileSync(path.join(stateDir, 'state.json.bak'), text);
  return { bytes: Buffer.byteLength(text), sha: sha(path.join(stateDir, 'state.json')) };
}

test('first v4 boot converts a v3 state, keeps the original byte for byte, and loses no entry', async () => {
  await inStateDir(async (stateDir) => {
    const original = writeV3(stateDir);
    const registry = new OrcaRegistry({ autoAudit: false });
    registry.stopScheduler();
    try {
      await registry.drainPendingWrites();
      const paths = statePaths(stateDir);
      const [folder] = fs.readdirSync(paths.migrationsDir);
      assert.match(folder, new RegExp(`^\\d{14}-v3-to-v4-${original.sha.slice(0, 12)}$`));
      const kept = path.join(paths.migrationsDir, folder);
      assert.equal(sha(path.join(kept, 'state.json')), original.sha, 'the original is kept verbatim');
      assert.equal(sha(path.join(kept, 'state.json.bak')), original.sha, 'the old .bak is moved beside it');
      const manifest = JSON.parse(fs.readFileSync(path.join(kept, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.original, { file: 'state.json', bytes: original.bytes, sha256: original.sha });
      assert.deepEqual(manifest.converted, { lanes: 1, logEntries: 300, agentEventEntries: 200, evidenceRefs: 2, evidenceOnlyLanesArchived: 1 });

      const saved = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
      assert.equal(saved.version, 4);
      assert.equal('logs' in saved.lanes[0], false);
      assert.equal(saved.lanes[0].logCount, 300);
      assert.ok(fs.statSync(paths.stateFile).size < original.bytes / 20, 'the hot state is a small fraction of the original');
      assert.equal(JSON.stringify(saved.auditEvents).includes('w'.repeat(200)), false, 'no lane text left in audit events');
      assert.equal(saved.auditEvents.find((event) => event.id === 'e1').evidence.laneRef.id, 'lane-hot');
      assert.deepEqual(saved.auditEvents.find((event) => event.id === 'e3').evidence, { leaseId: 'l1', reason: 'lane_completed' });

      assert.equal(readJournalAll(stateDir, 'lane-hot', 'logs').length, 300);
      assert.equal(readJournalAll(stateDir, 'lane-hot', 'agentEvents').length, 200);
      const recovered = readLaneArchive(stateDir, 'lane-dropped');
      assert.equal(recovered.logs.length, 150);
      assert.equal(recovered.agentEvents.length, 50);
      assert.match(recovered.reason, /recovered from audit evidence/);
      assert.equal(registry.readArchivedLane('lane-dropped').status, 200, 'a lane that only lived in evidence is readable by id');

      assert.equal(registry.laneForRead(registry.getLane('lane-hot')).logs.length, 300);
      const migrated = registry.auditEvents.find((event) => event.type === 'registry_state_migrated');
      assert.equal(migrated.evidence.from, 3);
      assert.equal(migrated.evidence.to, 4);
      assert.equal(migrated.evidence.archivePath, path.join('archive', 'migrations', folder));
    } finally {
      registry.stopScheduler();
      await registry.drainPendingWrites();
    }

    const again = new OrcaRegistry({ autoAudit: false });
    again.stopScheduler();
    try {
      await again.drainPendingWrites();
      assert.equal(fs.readdirSync(statePaths(stateDir).migrationsDir).length, 1, 'a v4 state is not migrated again');
      assert.equal(again.auditEvents.filter((event) => event.type === 'registry_state_migrated').length, 1);
    } finally {
      again.stopScheduler();
      await again.drainPendingWrites();
    }
  });
});

test('a migration interrupted before it rewrote state.json re-runs into the same folder', async () => {
  await inStateDir(async (stateDir) => {
    const original = writeV3(stateDir);
    const paths = statePaths(stateDir);
    // Simulate a crash after step 1: the copy exists, the .bak has moved, state.json is the original.
    const folder = path.join(paths.migrationsDir, `20260910000000-v3-to-v4-${original.sha.slice(0, 12)}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(paths.stateFile, path.join(folder, 'state.json'));
    fs.renameSync(`${paths.stateFile}.bak`, path.join(folder, 'state.json.bak'));

    const report = migrateStateDir({ stateDir });
    assert.equal(report.archivePath, path.join('archive', 'migrations', path.basename(folder)));
    assert.deepEqual(fs.readdirSync(paths.migrationsDir), [path.basename(folder)]);
    assert.equal(sha(path.join(folder, 'state.json')), original.sha);
    assert.equal(sha(path.join(folder, 'state.json.bak')), original.sha);
    assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')).version, 4);
    assert.deepEqual(migrateStateDir({ stateDir }).skipped, 'already current');
  });
});

test('a migration that fails leaves state.json and its backup untouched and refuses to open state', async () => {
  await inStateDir(async (stateDir) => {
    const original = writeV3(stateDir);
    // A regular file where archive/ must go: the migration cannot make its folder.
    fs.writeFileSync(path.join(stateDir, 'archive'), 'blocker');
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.throws(() => new OrcaRegistry({ autoAudit: false }), /State migration to v4 failed/);
    } finally {
      console.error = originalError;
    }
    assert.equal(sha(path.join(stateDir, 'state.json')), original.sha, 'state.json untouched');
    assert.equal(sha(path.join(stateDir, 'state.json.bak')), original.sha, 'state.json.bak untouched');
    assert.equal(fs.existsSync(path.join(stateDir, 'lanes')), false, 'no journals written');
  });
});

test('gc on a v3 state: the dry run says it would migrate; --apply migrates, then archives what is old', async () => {
  await inStateDir(async (stateDir, root) => {
    const original = writeV3(stateDir);
    const out = [];
    const sink = { write: (chunk) => { out.push(String(chunk)); return true; } };
    const now = Date.parse('2026-09-10T00:00:00.000Z');

    assert.equal(await runGcCommand({ 'state-dir': stateDir }, { stdout: sink, stderr: sink, now, cwd: root }), 0);
    const dry = out.join('');
    assert.match(dry, /would migrate state\.json v3 -> v4/);
    assert.match(dry, /Lane retention is decided after the migration/);
    assert.equal(sha(path.join(stateDir, 'state.json')), original.sha, 'the dry run changes nothing');

    out.length = 0;
    assert.equal(await runGcCommand({ 'state-dir': stateDir, apply: true, 'older-than-days': '7' }, { stdout: sink, stderr: sink, now, cwd: root }), 0, out.join(''));
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    assert.equal(saved.version, 4);
    assert.deepEqual(saved.lanes, [], 'the 40-day-old lane was archived after migrating');
    assert.deepEqual(saved.archivedLanes.map((entry) => entry.id).sort(), ['lane-dropped', 'lane-hot']);
    assert.equal(readLaneArchive(stateDir, 'lane-hot').logs.length, 300);
    assert.equal(readLaneArchive(stateDir, 'lane-hot').agentEvents.length, 200);
    const [folder] = fs.readdirSync(statePaths(stateDir).migrationsDir);
    assert.equal(sha(path.join(statePaths(stateDir).migrationsDir, folder, 'state.json')), original.sha);
  });
});
