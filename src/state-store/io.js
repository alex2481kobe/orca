// Low-level atomic JSON file I/O + parse helpers for the state store.
// The recovery orchestration lives in recovery.js.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATE_STORE_CONTRACT_VERSION = 'orca.state-store.v1';

function nowStamp() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

export function backupPathFor(filePath) {
  return `${filePath}.bak`;
}

// Include a random suffix so two corruptions in the same second from the same
// pid don't collide and overwrite each other's quarantine copy.
function corruptPathFor(filePath) {
  return `${filePath}.corrupt.${nowStamp()}.${process.pid}.${randomUUID().slice(0, 8)}`;
}

function serializeJson(payload) {
  // COMPACT by default: no indentation keeps per-persist serialize CPU + write
  // size from growing with retained state on a busy daemon. Recovery/parse
  // (readJson -> JSON.parse) is format-agnostic, so nothing depends on the
  // pretty layout. Escape hatch: ORCA_PRETTY_STATE=1 restores 2-space output
  // for humans eyeballing state files.
  if (process.env.ORCA_PRETTY_STATE === '1') {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }
  return `${JSON.stringify(payload)}\n`;
}

// Throttle the best-effort `.bak` copy so it happens at most once per window
// instead of on every debounced persist — copying the full file each time was
// the other half of the per-persist I/O cost that grew with total state.
// The atomic write-temp-then-fsync-then-rename of the PRIMARY is unchanged, so
// crash/power-loss durability of the canonical file is untouched. Only the
// backup freshness relaxes: after a skipped backup the `.bak` may lag the
// primary by up to the window; a fresh backup is forced on shutdown flush.
const BACKUP_THROTTLE_MS = 60_000;
const lastBackupAt = new Map();

// forceBackup wins outright (shutdown flush). Otherwise back up only if we have
// never backed this target up (undefined -> first backup is NEVER skipped) or
// the throttle window has elapsed.
function shouldWriteBackup(target, forceBackup) {
  if (forceBackup) return true;
  const last = lastBackupAt.get(target);
  return last === undefined || (Date.now() - last) >= BACKUP_THROTTLE_MS;
}

function markBackupWritten(target) {
  lastBackupAt.set(target, Date.now());
}

// Drop prototype-pollution keys from anything parsed off disk. State files are a
// trust boundary (they're writable by import flows); since this is the single
// parse point for every store, stripping here hardens all consumers at once.
// JSON.parse itself doesn't pollute the prototype, but downstream deep-merges of
// parsed data could — so we remove the keys defensively.
function pollutionFreeReviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

function parseJsonSafe(text) {
  return JSON.parse(text, pollutionFreeReviver);
}

export function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value), pollutionFreeReviver);
}

export function resolveFallback(fallback) {
  if (typeof fallback === 'function') return cloneJson(fallback());
  return cloneJson(fallback);
}

export async function writeJsonFileAtomic(filePath, payload, { backup = true, forceBackup = false } = {}) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    // Write + fsync the temp file before rename so the data is durable on disk
    // before it becomes the canonical file (rename is atomic; fsync gives
    // crash/power-loss durability the bare writeFile+rename did not guarantee).
    const handle = await fs.open(tempPath, 'w', 0o600);
    try {
      await handle.writeFile(serializeJson(payload));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, target);
    if (backup && shouldWriteBackup(target, forceBackup)) {
      markBackupWritten(target);
      await fs.copyFile(target, backupPathFor(target)).catch(() => {});
    }
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
  return {
    contractVersion: STATE_STORE_CONTRACT_VERSION,
    filePath: target,
    backupPath: backup ? backupPathFor(target) : null,
    atomic: true,
  };
}

export function writeJsonFileAtomicSync(filePath, payload, { backup = true, forceBackup = false } = {}) {
  const target = path.resolve(filePath);
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    const fd = fsSync.openSync(tempPath, 'w', 0o600);
    try {
      fsSync.writeFileSync(fd, serializeJson(payload));
      fsSync.fsyncSync(fd);
    } finally {
      fsSync.closeSync(fd);
    }
    fsSync.renameSync(tempPath, target);
    if (backup && shouldWriteBackup(target, forceBackup)) {
      markBackupWritten(target);
      try {
        fsSync.copyFileSync(target, backupPathFor(target));
      } catch {
        // Backups are best-effort; the main atomic write already succeeded.
      }
    }
  } catch (error) {
    try {
      fsSync.unlinkSync(tempPath);
    } catch {
      // Ignore missing temp files.
    }
    throw error;
  }
  return {
    contractVersion: STATE_STORE_CONTRACT_VERSION,
    filePath: target,
    backupPath: backup ? backupPathFor(target) : null,
    atomic: true,
  };
}

export async function readJson(pathname) {
  return parseJsonSafe(await fs.readFile(pathname, 'utf8'));
}

export function readJsonSync(pathname) {
  return parseJsonSafe(fsSync.readFileSync(pathname, 'utf8'));
}

export async function quarantineCorrupt(filePath) {
  const corruptPath = corruptPathFor(filePath);
  try {
    await fs.rename(filePath, corruptPath);
    return corruptPath;
  } catch {
    return null;
  }
}

export function quarantineCorruptSync(filePath) {
  const corruptPath = corruptPathFor(filePath);
  try {
    fsSync.renameSync(filePath, corruptPath);
    return corruptPath;
  } catch {
    return null;
  }
}

export async function finalizeReadResult(data, status, migrate) {
  let nextData = data;
  let nextStatus = { migrated: false, ...status };
  if (typeof migrate === 'function') {
    const input = cloneJson(data);
    const migrated = await migrate(input, cloneJson(nextStatus));
    nextData = migrated === undefined ? input : migrated;
    nextStatus = { ...nextStatus, migrated: true };
  }
  return {
    data: nextData,
    status: nextStatus,
  };
}

export function finalizeReadResultSync(data, status, migrate) {
  let nextData = data;
  let nextStatus = { migrated: false, ...status };
  if (typeof migrate === 'function') {
    const input = cloneJson(data);
    const migrated = migrate(input, cloneJson(nextStatus));
    nextData = migrated === undefined ? input : migrated;
    nextStatus = { ...nextStatus, migrated: true };
  }
  return {
    data: nextData,
    status: nextStatus,
  };
}
