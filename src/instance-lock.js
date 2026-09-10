// Exclusive ownership of an Orca state directory.
//
// Two daemons over one state directory destroy each other: startup restores,
// migrates and recovers interrupted lanes, and recovery SIGKILLs the process
// group a persisted lane still points at. So a start must prove the state is
// free BEFORE it reads any of it, and a duplicate must report the owner and
// change nothing.
//
// The lock is a file created with O_EXCL, which is atomic on a local filesystem.
// It records the owner's pid AND that pid's kernel start time, because a pid on
// its own does not identify a process: after a crash the pid can be handed to
// something unrelated. A lock is treated as stale only when its owner is provably
// gone — the pid no longer exists, or it now belongs to a process that started at
// a different time. Anything that cannot be verified counts as HELD: a refused
// start is recoverable, a second daemon on live state is not.
//
// Nothing in this module sends a signal to any process.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const INSTANCE_LOCK_SCHEMA = 'orca.instance-lock.v1';
export const INSTANCE_LOCK_FILE = 'daemon.lock';
const TAKEOVER_SUFFIX = '.takeover';

// `ps -o lstart=` is formatted in the CALLER's timezone and locale. The owner
// records it and a later start compares it, possibly under a different TZ/LANG
// (a LaunchAgent vs a shell), and a formatting difference would read as "pid
// reused" and hand a live owner's lock away. Pin both.
function psEnv() {
  return { PATH: process.env.PATH || '/bin:/usr/bin', TZ: 'UTC', LC_ALL: 'C', LANG: 'C' };
}

// -> { state: 'alive', start } | { state: 'gone' } | { state: 'unknown' }
export function probeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown', start: null };
  let out;
  try {
    out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: psEnv(),
    });
  } catch (error) {
    // `ps -p` exits 1 with nothing on stdout when no such process exists. Any
    // other failure (no ps, a timeout) proves nothing. A platform whose ps also
    // exits 1 for an unsupported flag is caught by the self-probe in
    // acquireInstanceLock: it cannot identify ITSELF, so it never takes over.
    if (error?.status === 1 && !String(error.stdout || '').trim()) return { state: 'gone', start: null };
    return { state: 'unknown', start: null };
  }
  const start = String(out || '').trim().replace(/\s+/g, ' ');
  return start ? { state: 'alive', start } : { state: 'unknown', start: null };
}

function readRaw(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function parseLock(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  if (value.schema !== INSTANCE_LOCK_SCHEMA) return null;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.nonce !== 'string' || !value.nonce) return null;
  if (typeof value.hostname !== 'string') return null;
  return value;
}

// O_EXCL create. false when the file already exists. A reader can observe the
// file empty for the instant between create and write; an empty lock parses as
// unreadable, which counts as HELD — correct, because its creator is starting.
function createLockFile(lockPath, record) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already failing */ }
    fd = null;
    try { fs.unlinkSync(lockPath); } catch { /* leave it; it reads as held */ }
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return true;
}

function assessHolder(holder, { self, probe, hostname }) {
  if (!holder) return { stale: false, reason: 'unreadable' };
  // A pid is only meaningful on the host that issued it.
  if (holder.hostname !== hostname) return { stale: false, reason: 'other-host' };
  // If this process cannot read its OWN start time, it cannot tell a live owner
  // from a reused pid either — so it may never declare a lock stale.
  if (self.state !== 'alive') return { stale: false, reason: 'unverifiable' };
  const owner = probe(holder.pid);
  if (owner.state === 'gone') return { stale: true, reason: 'owner-exited' };
  if (owner.state !== 'alive') return { stale: false, reason: 'unverifiable' };
  if (typeof holder.processStart !== 'string' || !holder.processStart) return { stale: false, reason: 'unverifiable' };
  if (owner.start !== holder.processStart) return { stale: true, reason: 'pid-reused' };
  return { stale: false, reason: 'running' };
}

// Replace a lock already proven stale. The takeover guard (itself O_EXCL)
// serializes contenders: without it, two starters that both judged the same lock
// stale could each unlink and recreate it, the second deleting the first's
// FRESH lock. Holding the guard, re-read and remove only the exact bytes that
// were assessed. Returns null on success, or the reason it did not happen.
function takeOverStaleLock(lockPath, staleRaw, record) {
  const guardPath = `${lockPath}${TAKEOVER_SUFFIX}`;
  let guard;
  try {
    guard = fs.openSync(guardPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return 'takeover-in-progress';
    throw error;
  }
  try {
    try { fs.writeSync(guard, `${JSON.stringify({ pid: record.pid, nonce: record.nonce })}\n`); } catch { /* existence is the guard */ }
    const current = readRaw(lockPath);
    if (current !== null && current !== staleRaw) return 'contended';
    if (current !== null) fs.unlinkSync(lockPath);
    return createLockFile(lockPath, record) ? null : 'contended';
  } finally {
    try { fs.closeSync(guard); } catch { /* ignore */ }
    try { fs.unlinkSync(guardPath); } catch { /* ignore */ }
  }
}

function ownedLock(lockPath, record, tookOver) {
  let current = record;
  let released = false;
  const owns = () => {
    try { return parseLock(readRaw(lockPath))?.nonce === record.nonce; } catch { return false; }
  };
  return {
    acquired: true,
    lockPath,
    stateDir: record.stateDir,
    tookOver,
    get record() { return { ...current }; },
    // Record details learned after acquisition (the bound listener), so a
    // refused duplicate can say where the running instance is. Atomic replace.
    update(fields) {
      if (released || !owns()) return false;
      current = { ...current, ...fields };
      const tempPath = `${lockPath}.${record.nonce}.tmp`;
      fs.writeFileSync(tempPath, `${JSON.stringify(current)}\n`, { mode: 0o600 });
      fs.renameSync(tempPath, lockPath);
      return true;
    },
    // Idempotent and synchronous (safe from a process 'exit' handler). Removes
    // the file only while it still carries THIS owner's nonce.
    release() {
      if (released) return false;
      released = true;
      if (!owns()) return false;
      try { fs.unlinkSync(lockPath); return true; } catch { return false; }
    },
  };
}

function describeRefusal(reason, holder, lockPath, stateDir, action = 'start') {
  const listen = holder?.listen?.port ? `, listening on http://${holder.listen.host}:${holder.listen.port}` : '';
  const who = holder ? `pid ${holder.pid}, started ${holder.processStart || 'at an unknown time'} UTC${listen}` : 'owner unknown';
  const detail = {
    running: `another Orca daemon already owns this state directory (${who}). Use that daemon, or stop it before starting another.`,
    unreadable: 'the state directory holds a lock file that cannot be read as an Orca lock.',
    'other-host': `the lock was taken on another host (${holder?.hostname}); its pid cannot be checked from here.`,
    unverifiable: `the lock owner (${who}) cannot be proven to have exited.`,
    'takeover-in-progress': 'another Orca start is replacing a stale lock right now.',
    contended: 'another Orca start took the lock at the same moment.',
  }[reason] || `the state directory is locked (${reason}).`;
  const lines = [
    `[orca] Refusing to ${action}: ${detail}`,
    `[orca] State directory: ${stateDir}`,
    '[orca] No state was restored, migrated or recovered, and no process was signaled.',
  ];
  if (reason === 'takeover-in-progress') {
    lines.push(`[orca] If no other Orca start is running, delete ${lockPath}${TAKEOVER_SUFFIX} and start again.`);
  } else if (reason !== 'running' && reason !== 'contended') {
    lines.push(`[orca] If you are certain no Orca daemon uses this state directory, delete ${lockPath} and start again.`);
  }
  return lines.join('\n');
}

// Take exclusive ownership of `stateDir` (created if absent, then canonicalized
// so two spellings of one directory collide). Returns an owned lock
// ({ acquired: true, release, update, tookOver }) or a refusal
// ({ acquired: false, reason, holder, message }). Never signals anything.
export function acquireInstanceLock(stateDir, { probe = probeProcess, hostname = os.hostname() } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const canonicalDir = fs.realpathSync(stateDir);
  const lockPath = path.join(canonicalDir, INSTANCE_LOCK_FILE);
  const self = probe(process.pid);
  const record = {
    schema: INSTANCE_LOCK_SCHEMA,
    pid: process.pid,
    processStart: self.state === 'alive' ? self.start : null,
    hostname,
    nonce: randomUUID(),
    stateDir: canonicalDir,
    cwd: process.cwd(),
    acquiredAt: new Date().toISOString(),
    listen: null,
  };
  const refuse = (reason, holder) => ({
    acquired: false,
    reason,
    holder,
    lockPath,
    stateDir: canonicalDir,
    message: describeRefusal(reason, holder, lockPath, canonicalDir),
  });

  let lastHolder = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createLockFile(lockPath, record)) return ownedLock(lockPath, record, null);
    const raw = readRaw(lockPath);
    if (raw === null) continue; // released between our create and our read
    const holder = parseLock(raw);
    lastHolder = holder;
    const verdict = assessHolder(holder, { self, probe, hostname });
    if (!verdict.stale) return refuse(verdict.reason, holder);
    const blocked = takeOverStaleLock(lockPath, raw, record);
    if (!blocked) return ownedLock(lockPath, record, { reason: verdict.reason, previous: holder });
    if (blocked === 'takeover-in-progress') return refuse(blocked, holder);
    // 'contended': the lock changed under us. Assess it again from the top.
  }
  return refuse('contended', lastHolder);
}

// Read-only: does a LIVE daemon own this state directory right now? Creates
// nothing and signals nothing. For a process that would open state without a
// listener (an importer, a test): it must never open state a running daemon
// owns. A missing lock, or one whose owner is provably gone, reads as not held.
export function inspectInstanceLock(stateDir, { probe = probeProcess, hostname = os.hostname() } = {}) {
  let canonicalDir;
  try {
    canonicalDir = fs.realpathSync(stateDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { held: false, reason: 'no-lock' };
    throw error;
  }
  const lockPath = path.join(canonicalDir, INSTANCE_LOCK_FILE);
  const raw = readRaw(lockPath);
  if (raw === null) return { held: false, reason: 'no-lock' };
  const holder = parseLock(raw);
  const verdict = assessHolder(holder, { self: probe(process.pid), probe, hostname });
  if (verdict.stale) return { held: false, reason: verdict.reason, holder };
  return {
    held: true,
    reason: verdict.reason,
    holder,
    lockPath,
    stateDir: canonicalDir,
    message: describeRefusal(verdict.reason, holder, lockPath, canonicalDir, 'open this state directory'),
  };
}
