// Compressed per-lane archives: where a lane goes when it leaves hot state.
//
//   archive/lanes/<lane>/lane-<yyyymmddhhmmss>.json.gz
//     { schema, laneId, archivedAt, reason, digest, lane, logs, agentEvents }
//
// `lane` is the full lane record (without its streams); `logs` and
// `agentEvents` are EVERY entry the lane's journal held, rotated and archived
// segments included — not the capped view lane.get shows.
//
// Retiring a lane is verify-then-remove: the gzip is written to a temp file,
// fsynced, renamed into place, then read back and compared byte for byte (by
// sha256) with what went in. Only then are the lane's journal files removed.
// A crash at any point leaves the journals, or the journals plus a complete
// archive — never neither.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { laneArchivedSegmentsDir, laneKey, statePaths } from './state-paths.js';
import { readJournalAll, removeJournalFiles } from './lane-journal.js';
import { laneDigest, laneRecordWithoutStreams } from './audit-evidence.js';

export const LANE_ARCHIVE_SCHEMA = 'orca.lane-archive.v1';
const ARCHIVE_FILE_PATTERN = /^lane-(\d{14})(?:-[0-9a-f]{8})?\.json\.gz$/;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const compactStamp = (iso) => String(iso).replace(/[^0-9]/g, '').slice(0, 14).padEnd(14, '0');

function reviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

// Write one lane archive and prove it reads back identically. Returns what was
// written; throws (leaving no half-written archive in place) if it does not.
export function writeLaneArchive(stateDir, {
  laneId,
  lane = null,
  logs = [],
  agentEvents = [],
  reason,
  archivedAt = new Date().toISOString(),
  extra = {},
}) {
  const payload = {
    schema: LANE_ARCHIVE_SCHEMA,
    laneId: String(laneId),
    archivedAt,
    reason: String(reason || 'unspecified'),
    digest: lane ? laneDigest(lane) : null,
    ...extra,
    lane: lane ? laneRecordWithoutStreams(lane) : null,
    logs: Array.isArray(logs) ? logs : [],
    agentEvents: Array.isArray(agentEvents) ? agentEvents : [],
  };
  const json = Buffer.from(JSON.stringify(payload));
  const gz = zlib.gzipSync(json, { level: 6 });
  const dir = laneArchivedSegmentsDir(stateDir, laneId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let file = path.join(dir, `lane-${compactStamp(archivedAt)}.json.gz`);
  if (fs.existsSync(file)) file = path.join(dir, `lane-${compactStamp(archivedAt)}-${randomUUID().slice(0, 8)}.json.gz`);
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeSync(fd, gz);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  const readBack = zlib.gunzipSync(fs.readFileSync(file));
  if (sha256(readBack) !== sha256(json)) {
    fs.renameSync(file, `${file}.unverified`);
    throw new Error(`Lane archive ${file} did not read back identically; kept as .unverified and nothing was removed.`);
  }
  return {
    file,
    relativeFile: path.relative(stateDir, file),
    bytes: gz.length,
    rawBytes: json.length,
    sha256: sha256(json),
    digest: payload.digest,
    logCount: payload.logs.length,
    agentEventCount: payload.agentEvents.length,
    archivedAt,
    reason: payload.reason,
  };
}

// The small entry state.json keeps for each archived lane, so lane.get can find
// it and scope it without opening the archive.
export function archivedLaneIndexEntry(lane, info) {
  const source = lane || {};
  return {
    id: String(source.id ?? ''),
    sessionId: source.sessionId ?? null,
    orchestratorId: source.orchestratorId ?? null,
    projectId: source.projectId ?? null,
    title: source.title ?? null,
    state: source.state ?? null,
    auditState: source.auditState ?? null,
    completedAt: source.completedAt ?? null,
    updatedAt: source.updatedAt ?? null,
    archivedAt: info.archivedAt,
    reason: info.reason,
    file: info.relativeFile,
    bytes: info.bytes,
    logCount: info.logCount,
    agentEventCount: info.agentEventCount,
    digest: info.digest,
  };
}

// Retire a lane from hot state: archive its record and every journal entry,
// verify, then remove its journal files. The caller must have flushed the
// lane's journal (the daemon) or be reading a state file whose lane has no
// inline streams (gc).
export function archiveLane(stateDir, lane, { reason, archivedAt = new Date().toISOString() } = {}) {
  const info = writeLaneArchive(stateDir, {
    laneId: lane.id,
    lane,
    logs: readJournalAll(stateDir, lane.id, 'logs'),
    agentEvents: readJournalAll(stateDir, lane.id, 'agentEvents'),
    reason,
    archivedAt,
  });
  removeJournalFiles(stateDir, lane.id);
  return { info, entry: archivedLaneIndexEntry(lane, info) };
}

// Archive a journal directory that no lane in state.json points at any more
// (a lane dropped by an older daemon). The record itself is gone; its streams
// are kept.
export function archiveOrphanJournal(stateDir, key, { archivedAt = new Date().toISOString() } = {}) {
  const info = writeLaneArchive(stateDir, {
    laneId: key,
    lane: null,
    logs: readJournalAll(stateDir, key, 'logs'),
    agentEvents: readJournalAll(stateDir, key, 'agentEvents'),
    reason: 'orphan-journal',
    archivedAt,
  });
  removeJournalFiles(stateDir, key);
  return info;
}

export function laneArchiveFiles(stateDir, laneId) {
  const dir = laneArchivedSegmentsDir(stateDir, laneId);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => ARCHIVE_FILE_PATTERN.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

// A lane's newest archive that carries its record (an orphan-journal archive
// has none), else its newest archive; parsed, or null.
export function readLaneArchive(stateDir, laneId) {
  let fallback = null;
  for (const file of laneArchiveFiles(stateDir, laneId).reverse()) {
    const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'), reviver);
    if (!payload || payload.schema !== LANE_ARCHIVE_SCHEMA) continue;
    if (payload.lane) return { ...payload, file };
    fallback = fallback || { ...payload, file };
  }
  return fallback;
}

// Every lane archive under the state dir: { key, file, bytes, mtimeMs, archivedAt }.
export function listLaneArchives(stateDir) {
  const root = statePaths(stateDir).archivedLanesDir;
  let keys;
  try { keys = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const key of keys) {
    let names;
    try { names = fs.readdirSync(path.join(root, key)); } catch { continue; }
    for (const name of names) {
      const match = ARCHIVE_FILE_PATTERN.exec(name);
      if (!match) continue;
      const file = path.join(root, key, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const digits = match[1];
      out.push({
        key,
        file,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        archivedAt: `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}Z`,
      });
    }
  }
  return out;
}

export { laneKey };
