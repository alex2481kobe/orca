// State format v3 -> v4, run by the first v4 boot on an old state directory
// (restoreFromDisk) or by `orca gc --apply`.
//
// What changes:
//   - lane logs and agent events move out of state.json into per-lane journals;
//   - audit evidence that embeds a lane becomes a reference (audit-evidence.js);
//   - a lane that survives ONLY inside audit evidence — its record was deleted
//     or pruned by an older daemon — is written to its own lane archive, so it
//     stays readable by id instead of disappearing with the evidence.
// What does not: nothing is deleted. The original state.json is kept byte for
// byte (and state.json.bak moved beside it) under
// archive/migrations/<time>-v3-to-v4-<sha256 prefix>/, with manifest.json.
//
// Order, so a crash at any step is safe to re-run:
//   1. copy state.json into the migration folder and verify its sha256; move
//      state.json.bak there;
//   2. write each lane's journals (atomic replace, so a re-run rewrites them);
//   3. archive the evidence-only lanes;
//   4. write manifest.json;
//   5. replace state.json, atomically, with the v4 state.
// Until step 5 state.json is the untouched original, and a re-run finds the same
// folder by the original's sha256.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_FORMAT_VERSION, statePaths } from './state-paths.js';
import { writeJournalEntries } from './lane-journal.js';
import { compactAuditEvidence } from './audit-evidence.js';
import { archivedLaneIndexEntry, writeLaneArchive } from './lane-archive.js';
import { readJsonSync, writeJsonFileAtomicSync } from './state-store/io.js';

export const MIGRATION_MANIFEST_SCHEMA = 'orca.state-migration.v1';
const CHUNK = 8 * 1024 * 1024;

export function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, CHUNK, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// Does this parsed state still need converting?
export function needsV4Migration(state) {
  return Boolean(state) && typeof state === 'object' && state.version !== STATE_FORMAT_VERSION;
}

function migrationFolder(paths, from, sha, now) {
  const suffix = `-v${from}-to-v${STATE_FORMAT_VERSION}-${sha.slice(0, 12)}`;
  let existing = [];
  try { existing = fs.readdirSync(paths.migrationsDir); } catch { /* first migration */ }
  const reuse = existing.find((name) => name.endsWith(suffix));
  const stamp = new Date(now).toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return path.join(paths.migrationsDir, reuse || `${stamp}${suffix}`);
}

function keepVerbatim(source, target, sha) {
  if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(source).size && sha256File(target) === sha) return;
  // A clone on APFS/btrfs: instant, and no extra space until either copy changes.
  fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
  if (sha256File(target) !== sha) throw new Error(`The migration copy of ${source} does not match the original; state.json was left untouched.`);
}

// Convert `parsed` (the state read from `stateDir`/state.json, already in the
// v3 shape) to v4 and write it. Returns { state, report }.
export function migrateStateToV4({ stateDir, parsed, from = parsed?.version ?? 3, now = Date.now() }) {
  const paths = statePaths(stateDir);
  const movedAt = new Date(now).toISOString();
  fs.mkdirSync(paths.migrationsDir, { recursive: true, mode: 0o700 });

  // 1. the original, byte for byte
  const hasOriginal = fs.existsSync(paths.stateFile);
  const originalSha = hasOriginal ? sha256File(paths.stateFile) : createHash('sha256').update('').digest('hex');
  const folder = migrationFolder(paths, from, originalSha, now);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const original = hasOriginal ? { file: 'state.json', bytes: fs.statSync(paths.stateFile).size, sha256: originalSha } : null;
  if (hasOriginal) keepVerbatim(paths.stateFile, path.join(folder, 'state.json'), originalSha);
  let backup = null;
  const backupFile = `${paths.stateFile}.bak`;
  if (fs.existsSync(backupFile)) {
    const target = path.join(folder, 'state.json.bak');
    backup = { file: 'state.json.bak', bytes: fs.statSync(backupFile).size, sha256: sha256File(backupFile) };
    if (fs.existsSync(target)) fs.renameSync(backupFile, `${target}.${Date.now()}`);
    else fs.renameSync(backupFile, target);
  } else if (fs.existsSync(path.join(folder, 'state.json.bak'))) {
    backup = { file: 'state.json.bak', note: 'moved by an earlier, interrupted run of this migration' };
  }

  // 2. lane streams -> journals
  const counts = { lanes: 0, logEntries: 0, agentEventEntries: 0, evidenceRefs: 0, evidenceOnlyLanesArchived: 0 };
  const lanes = (Array.isArray(parsed.lanes) ? parsed.lanes : []).map((lane) => {
    if (!lane || typeof lane !== 'object' || !lane.id) return lane;
    const { logs, agentEvents, ...record } = lane;
    const logList = Array.isArray(logs) ? logs : [];
    const eventList = Array.isArray(agentEvents) ? agentEvents : [];
    writeJournalEntries(stateDir, lane.id, 'logs', logList);
    writeJournalEntries(stateDir, lane.id, 'agentEvents', eventList);
    counts.lanes += 1;
    counts.logEntries += logList.length;
    counts.agentEventEntries += eventList.length;
    return { ...record, logCount: logList.length, agentEventCount: eventList.length };
  });

  // 3. evidence -> references; evidence-only lanes -> their own archives
  const hotIds = new Set(lanes.filter((lane) => lane?.id).map((lane) => lane.id));
  const evidenceOnly = new Map();
  const auditEvents = (Array.isArray(parsed.auditEvents) ? parsed.auditEvents : []).map((event) => {
    const embedded = event?.evidence?.lane;
    if (!embedded || typeof embedded !== 'object' || Array.isArray(embedded)) return event;
    counts.evidenceRefs += 1;
    if (embedded.id && !hotIds.has(embedded.id)) {
      const seen = evidenceOnly.get(embedded.id);
      const newer = !seen || Date.parse(embedded.updatedAt || 0) >= Date.parse(seen.updatedAt || 0);
      if (newer) evidenceOnly.set(embedded.id, embedded);
    }
    return { ...event, evidence: compactAuditEvidence(event.evidence) };
  });
  const archivedLanes = Array.isArray(parsed.archivedLanes) ? [...parsed.archivedLanes] : [];
  const alreadyArchived = new Set(archivedLanes.map((entry) => entry?.id));
  for (const [id, snapshot] of evidenceOnly) {
    if (alreadyArchived.has(id)) continue;
    const info = writeLaneArchive(stateDir, {
      laneId: id,
      lane: snapshot,
      logs: Array.isArray(snapshot.logs) ? snapshot.logs : [],
      agentEvents: Array.isArray(snapshot.agentEvents) ? snapshot.agentEvents : [],
      reason: `recovered from audit evidence by the v${from} -> v${STATE_FORMAT_VERSION} migration: its lane record had already been dropped`,
      archivedAt: movedAt,
    });
    archivedLanes.push(archivedLaneIndexEntry(snapshot, info));
    counts.evidenceOnlyLanesArchived += 1;
  }

  const next = {
    ...parsed,
    version: STATE_FORMAT_VERSION,
    savedAt: movedAt,
    lanes,
    auditEvents,
    archivedLanes,
  };

  // 4. manifest
  const manifest = {
    schema: MIGRATION_MANIFEST_SCHEMA,
    from,
    to: STATE_FORMAT_VERSION,
    movedAt,
    original,
    backup,
    converted: counts,
  };
  fs.writeFileSync(path.join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  // 5. the v4 state, atomically (and a fresh, small .bak)
  writeJsonFileAtomicSync(paths.stateFile, next, { forceBackup: true });
  return {
    state: next,
    report: {
      from,
      to: STATE_FORMAT_VERSION,
      archivePath: path.relative(stateDir, folder),
      originalBytes: original?.bytes ?? 0,
      stateBytes: fs.statSync(paths.stateFile).size,
      ...counts,
    },
  };
}

// For `orca gc --apply`: read the state directory's state.json and migrate it.
export function migrateStateDir({ stateDir, now = Date.now() }) {
  const parsed = readJsonSync(statePaths(stateDir).stateFile);
  if (!needsV4Migration(parsed)) return { from: parsed.version, to: parsed.version, skipped: 'already current' };
  return migrateStateToV4({ stateDir, parsed, now }).report;
}
