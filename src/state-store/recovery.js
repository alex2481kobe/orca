// State-file read with backup recovery + corrupt-file quarantine.
// Extracted from state-store.js; low-level I/O lives in io.js.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  STATE_STORE_CONTRACT_VERSION,
  backupPathFor,
  readJson,
  readJsonSync,
  quarantineCorrupt,
  quarantineCorruptSync,
  resolveFallback,
  finalizeReadResult,
  finalizeReadResultSync,
} from './io.js';

export async function readJsonFileWithRecovery(filePath, {
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

export function readJsonFileWithRecoverySync(filePath, {
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
