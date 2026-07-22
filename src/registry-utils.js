// Pure, dependency-light helpers shared across the OrcaRegistry. Extracted from
// registry.js so the core file stays focused on stateful behavior. Everything
// here is side-effect-free (except ensureDirectorySync, which only touches the
// filesystem) and safe to unit-test in isolation.

import fsSync from 'node:fs';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();

export const parsePositiveInteger = (value, fallback = null) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

export const parsePositiveFloat = (value, fallback = null) => {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

export function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

export function isPathWithinBoundary(candidatePath, boundaryPath) {
  const boundary = path.resolve(String(boundaryPath || '').trim() || process.cwd());
  const candidate = path.resolve(String(candidatePath || '').trim() || boundary);
  const boundaryWithSep = boundary.endsWith(path.sep) ? boundary : `${boundary}${path.sep}`;
  return candidate === boundary || candidate.startsWith(boundaryWithSep);
}

export function realpathSyncSafe(candidatePath) {
  try {
    return fsSync.realpathSync.native(path.resolve(String(candidatePath || '').trim()));
  } catch {
    return null;
  }
}

export function isRealPathWithinBoundarySync(candidatePath, boundaryPath) {
  const candidate = realpathSyncSafe(candidatePath);
  const boundary = realpathSyncSafe(boundaryPath);
  if (!candidate || !boundary) return false;
  return isPathWithinBoundary(candidate, boundary);
}

export function ensureDirectorySync(directoryPath) {
  const target = String(directoryPath || '').trim();
  if (!target) return;
  try {
    fsSync.mkdirSync(target, { recursive: true });
  } catch {
    // Directory creation will be validated by runtime execution when needed.
  }
}

export function normalizeExecutorType(raw) {
  return String(raw || '').toLowerCase().trim();
}

export function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function firstLine(value, max = 160) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, max) || null;
}

export function publicBinaryName(binary) {
  return path.basename(String(binary || '').trim()) || '';
}

export function clonePayload(value) {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON clone for non-cloneable shapes */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function safeArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

export function buildLaneRoute(projectSlug, sessionId, laneId) {
  return `/projects/${projectSlug}/sessions/${sessionId}/lanes/${laneId}`;
}
