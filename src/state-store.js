import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const STATE_STORE_CONTRACT_VERSION = 'command-deck.state-store.v1';

function nowStamp() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

function backupPathFor(filePath) {
  return `${filePath}.bak`;
}

function corruptPathFor(filePath) {
  return `${filePath}.corrupt.${nowStamp()}.${process.pid}`;
}

function serializeJson(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function resolveFallback(fallback) {
  if (typeof fallback === 'function') return cloneJson(fallback());
  return cloneJson(fallback);
}

async function writeJsonFileAtomic(filePath, payload, { backup = true } = {}) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, serializeJson(payload), { mode: 0o600 });
    await fs.rename(tempPath, target);
    if (backup) {
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

function writeJsonFileAtomicSync(filePath, payload, { backup = true } = {}) {
  const target = path.resolve(filePath);
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    fsSync.writeFileSync(tempPath, serializeJson(payload), { mode: 0o600 });
    fsSync.renameSync(tempPath, target);
    if (backup) {
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

async function readJson(pathname) {
  return JSON.parse(await fs.readFile(pathname, 'utf8'));
}

function readJsonSync(pathname) {
  return JSON.parse(fsSync.readFileSync(pathname, 'utf8'));
}

async function quarantineCorrupt(filePath) {
  const corruptPath = corruptPathFor(filePath);
  try {
    await fs.rename(filePath, corruptPath);
    return corruptPath;
  } catch {
    return null;
  }
}

function quarantineCorruptSync(filePath) {
  const corruptPath = corruptPathFor(filePath);
  try {
    fsSync.renameSync(filePath, corruptPath);
    return corruptPath;
  } catch {
    return null;
  }
}

async function finalizeReadResult(data, status, migrate) {
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

function finalizeReadResultSync(data, status, migrate) {
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

async function readJsonFileWithRecovery(filePath, {
  fallback,
  restoreBackup = true,
  migrate = null,
} = {}) {
  const target = path.resolve(filePath);
  const backupPath = backupPathFor(target);
  try {
    return finalizeReadResult(await readJson(target), {
        contractVersion: STATE_STORE_CONTRACT_VERSION,
        ok: true,
        recovered: false,
        source: 'primary',
        filePath: target,
        backupPath,
        corruptPath: null,
    }, migrate);
  } catch (primaryError) {
    if (primaryError?.code === 'ENOENT') {
      try {
        const backupData = await readJson(backupPath);
        if (restoreBackup) await fs.copyFile(backupPath, target).catch(() => {});
        return finalizeReadResult(backupData, {
          contractVersion: STATE_STORE_CONTRACT_VERSION,
          ok: true,
          recovered: true,
          source: 'backup',
          filePath: target,
          backupPath,
          corruptPath: null,
          reason: 'primary missing',
          missing: true,
        }, migrate);
      } catch (backupError) {
        return finalizeReadResult(resolveFallback(fallback), {
          contractVersion: STATE_STORE_CONTRACT_VERSION,
          ok: backupError?.code === 'ENOENT',
          recovered: false,
          source: 'fallback',
          filePath: target,
          backupPath,
          corruptPath: null,
          reason: 'missing',
          missing: true,
          backupReason: backupError?.code === 'ENOENT' ? 'missing' : backupError.message || 'backup unavailable',
        }, migrate);
      }
    }
    const corruptPath = await quarantineCorrupt(target);
    try {
      const backupData = await readJson(backupPath);
      if (restoreBackup) await fs.copyFile(backupPath, target).catch(() => {});
      return finalizeReadResult(backupData, {
          contractVersion: STATE_STORE_CONTRACT_VERSION,
          ok: true,
          recovered: true,
          source: 'backup',
          filePath: target,
          backupPath,
          corruptPath,
          reason: primaryError.message || 'primary parse failed',
      }, migrate);
    } catch (backupError) {
      return finalizeReadResult(resolveFallback(fallback), {
          contractVersion: STATE_STORE_CONTRACT_VERSION,
          ok: false,
          recovered: false,
          source: 'fallback',
          filePath: target,
          backupPath,
          corruptPath,
          reason: primaryError.message || 'primary parse failed',
          backupReason: backupError.message || 'backup unavailable',
      }, migrate);
    }
  }
}

function readJsonFileWithRecoverySync(filePath, {
  fallback,
  restoreBackup = true,
  migrate = null,
} = {}) {
  const target = path.resolve(filePath);
  const backupPath = backupPathFor(target);
  try {
    return finalizeReadResultSync(readJsonSync(target), {
        contractVersion: STATE_STORE_CONTRACT_VERSION,
        ok: true,
        recovered: false,
        source: 'primary',
        filePath: target,
        backupPath,
        corruptPath: null,
    }, migrate);
  } catch (primaryError) {
    if (primaryError?.code === 'ENOENT') {
      try {
        const backupData = readJsonSync(backupPath);
        if (restoreBackup) {
          try {
            fsSync.copyFileSync(backupPath, target);
          } catch {
            // Restore is best-effort; the caller still receives backup data.
          }
        }
        return finalizeReadResultSync(backupData, {
          contractVersion: STATE_STORE_CONTRACT_VERSION,
          ok: true,
          recovered: true,
          source: 'backup',
          filePath: target,
          backupPath,
          corruptPath: null,
          reason: 'primary missing',
          missing: true,
        }, migrate);
      } catch (backupError) {
        return finalizeReadResultSync(resolveFallback(fallback), {
          contractVersion: STATE_STORE_CONTRACT_VERSION,
          ok: backupError?.code === 'ENOENT',
          recovered: false,
          source: 'fallback',
          filePath: target,
          backupPath,
          corruptPath: null,
          reason: 'missing',
          missing: true,
          backupReason: backupError?.code === 'ENOENT' ? 'missing' : backupError.message || 'backup unavailable',
        }, migrate);
      }
    }
    const corruptPath = quarantineCorruptSync(target);
    try {
      const backupData = readJsonSync(backupPath);
      if (restoreBackup) {
        try {
          fsSync.copyFileSync(backupPath, target);
        } catch {
          // Restore is best-effort; the caller still receives backup data.
        }
      }
      return finalizeReadResultSync(backupData, {
          contractVersion: STATE_STORE_CONTRACT_VERSION,
          ok: true,
          recovered: true,
          source: 'backup',
          filePath: target,
          backupPath,
          corruptPath,
          reason: primaryError.message || 'primary parse failed',
      }, migrate);
    } catch (backupError) {
      return finalizeReadResultSync(resolveFallback(fallback), {
          contractVersion: STATE_STORE_CONTRACT_VERSION,
          ok: false,
          recovered: false,
          source: 'fallback',
          filePath: target,
          backupPath,
          corruptPath,
          reason: primaryError.message || 'primary parse failed',
          backupReason: backupError.message || 'backup unavailable',
      }, migrate);
    }
  }
}

export {
  STATE_STORE_CONTRACT_VERSION,
  backupPathFor,
  cloneJson,
  readJsonFileWithRecovery,
  readJsonFileWithRecoverySync,
  writeJsonFileAtomic,
  writeJsonFileAtomicSync,
};
