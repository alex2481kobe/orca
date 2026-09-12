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
// A pid is only checkable in the kernel that issued it, and a state directory can
// sit on shared or network storage, so the lock ALSO records which machine took
// it (src/machine-identity.js) and probes the pid only when that machine is this
// one. It records the hostname too, but only as a human-readable label: a
// hostname is not an identity. macOS changes it with the network, and a lock
// keyed on it stranded a live daemon that could then neither be stopped nor
// replaced through the CLI — docs/audits/2026-09-12-hostname-strands-the-daemon.md.
//
// Nothing in this module sends a signal to any process.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { describeMachine, resolveMachineIdentity, shortMachineId } from './machine-identity.js';
import { fixCommands } from './mcp-connection.js';

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

// What a pid is running, so a refusal can say WHAT now holds a reused pid, and
// so `--force` can tell an Orca daemon from a stranger before it signals
// anything. Read-only; null when it cannot be read. Never used to FIND Orca —
// the lock does that — only to describe a pid the lock already named.
export function probeProcessCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: psEnv(),
    });
    return String(out || '').split('\n')[0].trim() || null;
  } catch {
    return null;
  }
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
  // `machine` arrived after `hostname`. A lock without it is not malformed, it
  // is older than the field (see assessLocality); a lock with a non-string one
  // is not a lock this Orca wrote.
  if (value.machine !== undefined && value.machine !== null && typeof value.machine !== 'string') return null;
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

// May this process check the holder's pid at all?
// -> { local: true, basis } | { local: false, reason }
//
// A false "yes" is the dangerous direction: it lets a local pid probe answer a
// question about a remote daemon, and a "the owner is gone" verdict there puts a
// second daemon on live state. A false "no" only refuses a command, which is
// recoverable — but it is not free either: refusing forever is what stranded a
// live daemon, so the legacy case stays checkable by other evidence (see
// assessHolder).
function assessLocality(holder, { hostname, machine }) {
  const recorded = typeof holder.machine === 'string' && holder.machine ? holder.machine : null;
  if (recorded && machine) {
    return recorded === machine ? { local: true, basis: 'machine' } : { local: false, reason: 'other-machine' };
  }
  if (recorded && !machine) {
    // The lock says which machine took it and we cannot say which machine we
    // are. The hostname is the only thing left, and it is weak evidence: good
    // enough to keep working when it matches, never good enough to overrule.
    return holder.hostname === hostname
      ? { local: true, basis: 'hostname' }
      : { local: false, reason: 'identity-unavailable' };
  }
  // A lock written before Orca recorded a machine identity — including one held
  // by a daemon that is STILL RUNNING across the upgrade that added the field.
  // Its hostname is all it carries.
  if (holder.hostname === hostname) return { local: true, basis: 'hostname' };
  return { local: false, reason: 'legacy-other-host' };
}

function startMatches(holder, owner) {
  return Boolean(owner)
    && owner.state === 'alive'
    && typeof holder?.processStart === 'string'
    && Boolean(holder.processStart)
    && owner.start === holder.processStart;
}

function assessHolder(holder, { self, probe, hostname, machine }) {
  if (!holder) return { stale: false, reason: 'unreadable', owner: null, locality: null };
  const locality = assessLocality(holder, { hostname, machine });
  // Reading a pid's start time is read-only and signals nothing, so it is safe
  // to look even at a lock that may belong to another machine: it is the only
  // thing that lets a refusal tell the operator what to do next. It decides
  // STALENESS only when the lock is this machine's.
  // If this process cannot read its OWN start time, it cannot tell a live owner
  // from a reused pid either — so it may never declare a lock stale.
  const owner = self.state === 'alive' ? probe(holder.pid) : { state: 'unknown', start: null };
  if (!locality.local) {
    // The upgrade migration, and the only place a lock is judged local on
    // evidence other than its recorded identity. A legacy lock whose hostname no
    // longer matches is exactly the stranded daemon: the pid AND that pid's
    // start time, to the second, both matching what the lock recorded is
    // decisive enough to call it the owner — and calling it the owner only ever
    // REFUSES, never takes over, so a coincidence costs an operator one --force,
    // not a second daemon.
    if (locality.reason === 'legacy-other-host' && startMatches(holder, owner)) {
      return { stale: false, reason: 'running', owner, locality };
    }
    return { stale: false, reason: locality.reason, owner, locality };
  }
  if (self.state !== 'alive') return { stale: false, reason: 'unverifiable', owner, locality };
  if (owner.state === 'gone') return { stale: true, reason: 'owner-exited', owner, locality };
  if (owner.state !== 'alive') return { stale: false, reason: 'unverifiable', owner, locality };
  if (typeof holder.processStart !== 'string' || !holder.processStart) return { stale: false, reason: 'unverifiable', owner, locality };
  if (!startMatches(holder, owner)) return { stale: true, reason: 'pid-reused', owner, locality };
  return { stale: false, reason: 'running', owner, locality };
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

function holderLabel(holder) {
  if (!holder) return 'owner unknown';
  const listen = holder.listen?.port ? `, listening on http://${holder.listen.host}:${holder.listen.port}` : '';
  return `pid ${holder.pid}, started ${holder.processStart || 'at an unknown time'} UTC${listen}`;
}

function machineLabel(holder) {
  if (!holder) return 'an unknown machine';
  const host = holder.hostname ? `"${holder.hostname}"` : 'an unnamed host';
  return holder.machine ? `${host} (${shortMachineId(holder.machine)})` : host;
}

// "Delete the lock and start again" is the advice that hurt: it is wrong exactly
// when a daemon really is alive holding it. What an operator needs instead is
// what THIS machine can see about the recorded pid, and each finding has one
// remedy. Three variants, and the pid decides which:
//
//   alive here    it is, or is not, the recorded owner — say which, then stop it
//                 or clear the lock through the CLI, never by hand;
//   absent here   nothing to signal; the lock is clearable, and here is how;
//   uncheckable   say WHY it cannot be checked, and name the machine that can
//                 answer instead.
//
// Lines carry no "[orca] " prefix: describeRefusal adds it, and `status` renders
// them under its own indent.
function remedyLines(reason, holder, owner, lockPath, stateDir) {
  const stopForce = fixCommands.stopForce();
  if (!holder) {
    return [
      'Its owner cannot be identified, so nothing about it can be checked from here.',
      `Look at ${lockPath}: if it is not a lock Orca wrote, move it aside and start again. If a daemon is starting right now, it finishes writing it in a moment.`,
    ];
  }
  if (reason === 'other-machine') {
    return [
      `The lock names another machine, so pid ${holder.pid} means nothing here: if that daemon runs, it runs on ${machineLabel(holder)}.`,
      `Stop it there: ${fixCommands.stop()}`,
      `Only if ${stateDir} is NOT shared with that machine, clear the lock here: ${stopForce}`,
    ];
  }
  if (owner?.state === 'alive') {
    if (startMatches(holder, owner)) {
      return [
        `pid ${holder.pid} IS running on this machine and started exactly when the lock records (${owner.start} UTC): it is this state directory's daemon, still alive. Do not delete the lock.`,
        `Stop it with: ${stopForce}`,
      ];
    }
    return [
      `pid ${holder.pid} is running on this machine but did NOT start when the lock records (${owner.start} UTC, not ${holder.processStart || 'recorded'}): the pid was reused, so it is not the owner and must not be signaled.`,
      `Clear the stale lock, without signaling anything, with: ${stopForce}`,
    ];
  }
  if (owner?.state === 'gone') {
    return [
      `pid ${holder.pid} is not running on this machine, so there is nothing here to signal.`,
      `If ${stateDir} is on this machine's own disk, the lock is stale and safe to clear: ${stopForce}`,
    ];
  }
  return [
    `pid ${holder.pid} cannot be checked from here, so whether it still runs is unknown.`,
    `If ${stateDir} is shared with ${machineLabel(holder)}, stop the daemon there: ${fixCommands.stop()}`,
    `If nothing runs there, clear the lock here: ${stopForce}`,
  ];
}

// -> { detail, remedy: string[] }
function refusalParts(reason, holder, lockPath, stateDir, context = {}) {
  const { owner = null, hostname = os.hostname(), identity = null } = context;
  const detail = {
    running: `another Orca daemon already owns this state directory (${holderLabel(holder)}). Use that daemon, or stop it before starting another.`,
    unreadable: 'the state directory holds a lock file that cannot be read as an Orca lock.',
    'other-machine': `the lock was taken on another machine, ${machineLabel(holder)}; this machine is ${describeMachine(identity, hostname)}, and a pid from there cannot be checked here.`,
    'legacy-other-host': `the lock predates machine identity — it records only the hostname it was taken under (${holder?.hostname || 'unknown'}), and this host now calls itself ${hostname}. A hostname changes with the network, so that is not proof of another machine, but it is not proof of this one either.`,
    'identity-unavailable': `the lock was taken on ${machineLabel(holder)} and this machine's identity could not be determined${identity?.error ? ` (${identity.error})` : ''}, so the two cannot be compared.`,
    unverifiable: `the lock owner (${holderLabel(holder)}) cannot be proven to have exited.`,
    'takeover-in-progress': 'another Orca start is replacing a stale lock right now.',
    contended: 'another Orca start took the lock at the same moment.',
  }[reason] || `the state directory is locked (${reason}).`;

  if (reason === 'running') return { detail, remedy: [`Stop it with: ${fixCommands.stop()}`] };
  if (reason === 'takeover-in-progress') {
    return { detail, remedy: [`If no other Orca start is running, delete ${lockPath}${TAKEOVER_SUFFIX} and start again.`] };
  }
  if (reason === 'contended') return { detail, remedy: [] };
  return { detail, remedy: remedyLines(reason, holder, owner, lockPath, stateDir) };
}

function describeRefusal(reason, holder, lockPath, stateDir, action = 'start', context = {}) {
  const { detail, remedy } = refusalParts(reason, holder, lockPath, stateDir, context);
  return [
    `[orca] Refusing to ${action}: ${detail}`,
    `[orca] State directory: ${stateDir}`,
    '[orca] No state was restored, migrated or recovered, and no process was signaled.',
    ...remedy.map((line) => `[orca] ${line}`),
  ].join('\n');
}

// Take exclusive ownership of `stateDir` (created if absent, then canonicalized
// so two spellings of one directory collide). Returns an owned lock
// ({ acquired: true, release, update, tookOver }) or a refusal
// ({ acquired: false, reason, holder, message }). Never signals anything.
export function acquireInstanceLock(stateDir, {
  probe = probeProcess,
  hostname = os.hostname(),
  identity = undefined,
} = {}) {
  const machine = identity === undefined ? resolveMachineIdentity() : identity;
  fs.mkdirSync(stateDir, { recursive: true });
  const canonicalDir = fs.realpathSync(stateDir);
  const lockPath = path.join(canonicalDir, INSTANCE_LOCK_FILE);
  const self = probe(process.pid);
  const record = {
    schema: INSTANCE_LOCK_SCHEMA,
    pid: process.pid,
    processStart: self.state === 'alive' ? self.start : null,
    // The identity the next start compares. `hostname` stays beside it as the
    // human-readable label messages use, and is never compared to it.
    machine: machine?.id || null,
    machineSource: machine?.source || 'unavailable',
    hostname,
    nonce: randomUUID(),
    stateDir: canonicalDir,
    cwd: process.cwd(),
    acquiredAt: new Date().toISOString(),
    listen: null,
  };
  const refuse = (reason, holder, owner = null) => {
    const context = { owner, hostname, identity: machine };
    const parts = refusalParts(reason, holder, lockPath, canonicalDir, context);
    return {
      acquired: false,
      reason,
      holder,
      owner,
      lockPath,
      stateDir: canonicalDir,
      identity: machine,
      detail: parts.detail,
      remedy: parts.remedy,
      message: describeRefusal(reason, holder, lockPath, canonicalDir, 'start', context),
    };
  };

  let lastHolder = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createLockFile(lockPath, record)) return ownedLock(lockPath, record, null);
    const raw = readRaw(lockPath);
    if (raw === null) continue; // released between our create and our read
    const holder = parseLock(raw);
    lastHolder = holder;
    const verdict = assessHolder(holder, { self, probe, hostname, machine: machine?.id || null });
    if (!verdict.stale) return refuse(verdict.reason, holder, verdict.owner);
    const blocked = takeOverStaleLock(lockPath, raw, record);
    if (!blocked) return ownedLock(lockPath, record, { reason: verdict.reason, previous: holder });
    if (blocked === 'takeover-in-progress') return refuse(blocked, holder, verdict.owner);
    // 'contended': the lock changed under us. Assess it again from the top.
  }
  return refuse('contended', lastHolder);
}

// Read-only: does a LIVE daemon own this state directory right now? Creates
// nothing and signals nothing. For a process that would open state without a
// listener (an importer, a test): it must never open state a running daemon
// owns. A missing lock, or one whose owner is provably gone, reads as not held.
//
// `owner` is what the recorded pid looks like FROM HERE ('alive' | 'gone' |
// 'unknown'). It never decides staleness for a lock another machine took; it
// only tells a command what it can honestly do about it.
export function inspectInstanceLock(stateDir, {
  probe = probeProcess,
  hostname = os.hostname(),
  identity = undefined,
} = {}) {
  const machine = identity === undefined ? resolveMachineIdentity() : identity;
  let canonicalDir;
  try {
    canonicalDir = fs.realpathSync(stateDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { held: false, reason: 'no-lock', identity: machine };
    throw error;
  }
  const lockPath = path.join(canonicalDir, INSTANCE_LOCK_FILE);
  const raw = readRaw(lockPath);
  if (raw === null) return { held: false, reason: 'no-lock', lockPath, stateDir: canonicalDir, identity: machine };
  const holder = parseLock(raw);
  const verdict = assessHolder(holder, { self: probe(process.pid), probe, hostname, machine: machine?.id || null });
  if (verdict.stale) {
    return { held: false, reason: verdict.reason, holder, owner: verdict.owner, lockPath, stateDir: canonicalDir, identity: machine };
  }
  const context = { owner: verdict.owner, hostname, identity: machine };
  const parts = refusalParts(verdict.reason, holder, lockPath, canonicalDir, context);
  return {
    held: true,
    reason: verdict.reason,
    holder,
    owner: verdict.owner,
    lockPath,
    stateDir: canonicalDir,
    identity: machine,
    detail: parts.detail,
    remedy: parts.remedy,
    message: describeRefusal(verdict.reason, holder, lockPath, canonicalDir, 'open this state directory', context),
  };
}
