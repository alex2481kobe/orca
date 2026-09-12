// Per-lane journals: a lane's log lines and agent events, kept OUT of state.json.
//
// Before v4 both streams lived inline in every lane record, so every persist
// rewrote them and every restart re-read them (~199 MB of a 525 MB state file).
// Now each stream is an append-only JSONL file under the state directory:
//
//   lanes/<lane>/logs.jsonl                  current segment, one entry per line
//   lanes/<lane>/logs.000001.jsonl           rotated segments, lowest = oldest
//   lanes/<lane>/events.jsonl (+ rotated)    agent events, same scheme
//   archive/lanes/<lane>/logs.000001.jsonl   segments rotated OUT of hot state
//
// A segment rotates once it passes the size cap; at most `maxHotSegments`
// segments per stream stay under lanes/, and older ones are MOVED to
// archive/lanes/<lane>/ — nothing is dropped. Readers take a bounded tail and
// read only as far back as they need.
//
// All I/O here is synchronous and small: an append writes only new entries.

import fs from 'node:fs';
import path from 'node:path';
import { laneArchivedSegmentsDir, laneJournalDir } from './state-paths.js';

export const JOURNAL_STREAMS = Object.freeze({ logs: 'logs', agentEvents: 'events' });

const SEGMENT_PATTERN = /^(logs|events)\.(\d{6})\.jsonl$/;
const TAIL_CHUNK_BYTES = 64 * 1024;

export function journalLimits() {
  const segmentMaxBytes = Number.parseInt(process.env.ORCA_LANE_JOURNAL_SEGMENT_BYTES || '', 10);
  const maxHotSegments = Number.parseInt(process.env.ORCA_LANE_JOURNAL_HOT_SEGMENTS || '', 10);
  return {
    segmentMaxBytes: segmentMaxBytes > 0 ? segmentMaxBytes : 8 * 1024 * 1024,
    // current + rotated segments kept hot per stream
    maxHotSegments: maxHotSegments > 0 ? maxHotSegments : 4,
  };
}

function baseName(stream) {
  const base = JOURNAL_STREAMS[stream];
  if (!base) throw new Error(`Unknown lane journal stream: ${stream}`);
  return base;
}

function reviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

// A torn final line (a crash mid-append) or a hand-edited line is skipped, never fatal.
function parseLines(lines) {
  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const value = JSON.parse(line, reviver);
      if (value && typeof value === 'object') entries.push(value);
    } catch { /* skip unreadable line */ }
  }
  return entries;
}

function rotatedSegments(dir, base) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map((name) => SEGMENT_PATTERN.exec(name))
    .filter((match) => match && match[1] === base)
    .map((match) => ({ number: Number(match[2]), file: path.join(dir, match[0]) }))
    .sort((a, b) => a.number - b.number);
}

const segmentName = (base, number) => `${base}.${String(number).padStart(6, '0')}.jsonl`;

// Every file holding this stream, OLDEST first: archived segments, hot rotated
// segments, then the current segment.
export function journalFiles(stateDir, laneId, stream) {
  const base = baseName(stream);
  const hotDir = laneJournalDir(stateDir, laneId);
  const files = [
    ...rotatedSegments(laneArchivedSegmentsDir(stateDir, laneId), base).map((segment) => segment.file),
    ...rotatedSegments(hotDir, base).map((segment) => segment.file),
  ];
  const current = path.join(hotDir, `${base}.jsonl`);
  if (fs.existsSync(current)) files.push(current);
  return files;
}

function rotate(stateDir, laneId, base) {
  const hotDir = laneJournalDir(stateDir, laneId);
  const archivedDir = laneArchivedSegmentsDir(stateDir, laneId);
  const numbers = [
    ...rotatedSegments(archivedDir, base),
    ...rotatedSegments(hotDir, base),
  ].map((segment) => segment.number);
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  fs.renameSync(path.join(hotDir, `${base}.jsonl`), path.join(hotDir, segmentName(base, next)));
  const hot = rotatedSegments(hotDir, base);
  const { maxHotSegments } = journalLimits();
  const excess = hot.length - Math.max(0, maxHotSegments - 1);
  if (excess > 0) {
    fs.mkdirSync(archivedDir, { recursive: true, mode: 0o700 });
    for (const segment of hot.slice(0, excess)) {
      fs.renameSync(segment.file, path.join(archivedDir, path.basename(segment.file)));
    }
  }
}

// Append entries to a lane stream; rotate when the current segment passes the cap.
export function appendJournalEntries(stateDir, laneId, stream, entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  const base = baseName(stream);
  const dir = laneJournalDir(stateDir, laneId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${base}.jsonl`);
  const text = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  const fd = fs.openSync(file, 'a+', 0o600);
  let size;
  try {
    // A crash mid-append can leave the last line unterminated; start on a fresh
    // line so the torn bytes cannot swallow the first new entry.
    const before = fs.fstatSync(fd).size;
    let prefix = '';
    if (before > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, before - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    fs.writeSync(fd, prefix + text);
    size = fs.fstatSync(fd).size;
  } finally {
    fs.closeSync(fd);
  }
  if (size >= journalLimits().segmentMaxBytes) rotate(stateDir, laneId, base);
  return entries.length;
}

// Replace a stream's current segment with exactly these entries (the v3 -> v4
// migration). Atomic: a crash leaves the old file or the new one, never half.
export function writeJournalEntries(stateDir, laneId, stream, entries) {
  const base = baseName(stream);
  const dir = laneJournalDir(stateDir, laneId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${base}.jsonl`);
  const temp = `${file}.${process.pid}.tmp`;
  const list = Array.isArray(entries) ? entries : [];
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    // One line at a time: a lane's stream can be tens of MB.
    for (const entry of list) fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  return list.length;
}

// The last `maxLines` complete lines of a file, reading backwards in chunks.
function tailLines(file, maxLines) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const { size } = fs.fstatSync(fd);
    let position = size;
    let carry = Buffer.alloc(0);
    const lines = [];
    while (position > 0 && lines.length <= maxLines) {
      const length = Math.min(TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, position);
      let buffer = Buffer.concat([chunk, carry]);
      let end = buffer.length;
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 0x0a) continue;
        if (end > index + 1) lines.push(buffer.subarray(index + 1, end).toString('utf8'));
        end = index;
        if (lines.length > maxLines) break;
      }
      carry = buffer.subarray(0, end);
      buffer = null;
    }
    if (position === 0 && carry.length && lines.length <= maxLines) lines.push(carry.toString('utf8'));
    return lines.slice(0, maxLines).reverse();
  } finally {
    fs.closeSync(fd);
  }
}

// The newest `maxEntries` entries of a stream, oldest first — reading back
// through rotated and archived segments only as far as it has to.
export function readJournalTail(stateDir, laneId, stream, maxEntries) {
  const limit = Math.max(0, Number.parseInt(maxEntries, 10) || 0);
  if (!limit) return [];
  const files = journalFiles(stateDir, laneId, stream).reverse();
  let collected = [];
  for (const file of files) {
    const entries = parseLines(tailLines(file, limit - collected.length));
    collected = [...entries, ...collected];
    if (collected.length >= limit) break;
  }
  return collected.slice(-limit);
}

// Every entry of a stream, oldest first (used when archiving a lane).
export function readJournalAll(stateDir, laneId, stream) {
  const entries = [];
  for (const file of journalFiles(stateDir, laneId, stream)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const entry of parseLines(text.split('\n'))) entries.push(entry);
  }
  return entries;
}

export function journalBytes(stateDir, laneId) {
  let total = 0;
  for (const stream of Object.keys(JOURNAL_STREAMS)) {
    for (const file of journalFiles(stateDir, laneId, stream)) {
      try { total += fs.statSync(file).size; } catch { /* gone */ }
    }
  }
  return total;
}

// Remove every journal file of a lane, hot and archived. Only lane-archive.js
// calls this, and only AFTER it has written and verified a compressed archive
// that holds every one of these entries.
export function removeJournalFiles(stateDir, laneId) {
  const removed = [];
  for (const stream of Object.keys(JOURNAL_STREAMS)) {
    for (const file of journalFiles(stateDir, laneId, stream)) {
      try { fs.unlinkSync(file); removed.push(file); } catch { /* already gone */ }
    }
  }
  for (const dir of [laneJournalDir(stateDir, laneId), laneArchivedSegmentsDir(stateDir, laneId)]) {
    try { fs.rmdirSync(dir); } catch { /* not empty or absent: leave it */ }
  }
  return removed;
}
