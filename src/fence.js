// The fence: the directories agents may register in and executors may run in.
//
// Exact roots. A root list means exactly that list: the daemon's working
// directory is never added. Every root must be an absolute path to an existing
// directory, and is kept as its real path.
//
// Missing configuration is a state, not a default. With no roots, Orca runs and
// answers, but registers no agent and launches no executor, and every surface
// that reports the fence names the one command that sets it up.
//
// A root that covers your whole home directory (home itself, or any directory
// above it) must be chosen deliberately: `setup --allow-home-root` records the
// acknowledgement, and even then the fence warns wherever it is reported.
//
// Sources, first match wins: ORCA_REPO_ROOTS (comma- or newline-separated), then
// "roots" in the Orca config file written by `orca-cli.js setup`. A set but
// empty or malformed ORCA_REPO_ROOTS is invalid, never ignored.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixCommands } from './mcp-connection.js';

export const FENCE_STATUS = Object.freeze({
  CONFIGURED: 'configured',
  SETUP_REQUIRED: 'setup-required',
  INVALID: 'invalid',
});

export const SETUP_REQUIRED_CODE = 'ORCA_SETUP_REQUIRED';
export const OUTSIDE_FENCE_CODE = 'ORCA_OUTSIDE_FENCE';

export function parseRootList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => parseRootList(item));
  return String(value ?? '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function covers(boundary, candidate) {
  const withSep = boundary.endsWith(path.sep) ? boundary : `${boundary}${path.sep}`;
  return candidate === boundary || candidate.startsWith(withSep);
}

function realOrResolved(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

// The account's home directory, from the user database rather than $HOME, so an
// overridden HOME cannot make a whole-home root look narrow (or a fixture look
// whole-home).
export function accountHome() {
  try {
    const home = os.userInfo().homedir;
    if (home) return realOrResolved(home);
  } catch { /* no user database entry */ }
  return realOrResolved(os.homedir());
}

// One root as written -> { root } (its real path) or { error }.
export function checkRoot(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: 'an empty entry' };
  if (text.includes('\0')) return { error: `"${text}" contains a NUL byte` };
  if (!path.isAbsolute(text)) return { error: `"${text}" is not an absolute path` };
  let real;
  try {
    real = fs.realpathSync(text);
  } catch {
    return { error: `"${text}" does not exist` };
  }
  try {
    if (!fs.statSync(real).isDirectory()) return { error: `"${text}" is not a directory` };
  } catch {
    return { error: `"${text}" cannot be read` };
  }
  return { root: real };
}

export function isHomeWide(root, home = accountHome()) {
  return Boolean(home) && covers(root, home);
}

// -> { roots, errors, homeWideRoots }
export function validateRoots(rawList, { home = accountHome() } = {}) {
  const roots = [];
  const errors = [];
  for (const raw of rawList) {
    const result = checkRoot(raw);
    if (result.error) errors.push(result.error);
    else if (!roots.includes(result.root)) roots.push(result.root);
  }
  return { roots, errors, homeWideRoots: roots.filter((root) => isHomeWide(root, home)) };
}

const SOURCE_LABELS = { ORCA_REPO_ROOTS: 'ORCA_REPO_ROOTS', config: 'the Orca config file' };

// -> the effective fence. Pure apart from reading the filesystem to validate
// roots. `config` is the parsed config file (null for none); `configError` says
// the file exists but could not be read.
export function resolveFence({
  env = process.env,
  config = null,
  configPath = null,
  configError = null,
  home = accountHome(),
} = {}) {
  const fence = {
    status: FENCE_STATUS.SETUP_REQUIRED,
    source: null,
    roots: [],
    homeWide: false,
    homeRootAcknowledgedAt: (config && typeof config.homeRootAcknowledgedAt === 'string') ? config.homeRootAcknowledgedAt : null,
    warnings: [],
    errors: [],
    configPath,
    summary: '',
    fix: fixCommands.setup(),
  };

  let rawList = null;
  if (env.ORCA_REPO_ROOTS !== undefined) {
    fence.source = 'ORCA_REPO_ROOTS';
    rawList = parseRootList(env.ORCA_REPO_ROOTS);
    if (!rawList.length) fence.errors.push('ORCA_REPO_ROOTS is set but names no directory');
  } else if (configError) {
    fence.source = 'config';
    fence.errors.push(configError);
  } else if (config && config.roots !== undefined) {
    fence.source = 'config';
    if (Array.isArray(config.roots)) rawList = config.roots.map((item) => String(item));
    else fence.errors.push(`"roots" in ${configPath || 'the Orca config file'} is not a list`);
    if (rawList && !rawList.length) fence.errors.push(`"roots" in ${configPath || 'the Orca config file'} is empty`);
  }

  if (!fence.source) {
    fence.summary = 'Orca is not set up: it has no approved roots, so it registers no agent and launches no executor.';
    return fence;
  }

  const label = SOURCE_LABELS[fence.source];
  if (rawList && rawList.length) {
    const checked = validateRoots(rawList, { home });
    fence.errors.push(...checked.errors);
    fence.roots = checked.roots;
    fence.homeWide = checked.homeWideRoots.length > 0;
    if (!fence.errors.length && fence.homeWide && !fence.homeRootAcknowledgedAt) {
      fence.errors.push(`${checked.homeWideRoots.join(', ')} covers your whole home directory, which needs a recorded acknowledgement`);
    }
  }

  if (fence.errors.length) {
    fence.status = FENCE_STATUS.INVALID;
    const roots = fence.roots;
    fence.roots = [];
    const narrowing = fence.homeWide && roots.length
      ? ` To keep it, run: ${fixCommands.setup(roots)} --allow-home-root`
      : '';
    fence.summary = `The approved roots from ${label} are invalid (${fence.errors.join('; ')}), so Orca registers no agent and launches no executor.${narrowing}`;
    fence.fix = fence.source === 'ORCA_REPO_ROOTS'
      ? `correct ORCA_REPO_ROOTS in the environment Orca starts with, or remove it and run: ${fixCommands.setup()}`
      : fixCommands.setup();
    return fence;
  }

  fence.status = FENCE_STATUS.CONFIGURED;
  fence.summary = `Agents may register and run executors under ${fence.roots.join(', ')} (from ${label}).`;
  fence.fix = null;
  if (fence.homeWide) {
    fence.warnings.push(`The fence covers your whole home directory (acknowledged ${fence.homeRootAcknowledgedAt}): agents may work in any folder under it. Narrow it with: ${fixCommands.setup()}`);
  }
  return fence;
}

// What an API response or a doctor report may carry about the fence.
export function describeFence(fence) {
  return {
    status: fence.status,
    configured: fence.status === FENCE_STATUS.CONFIGURED,
    source: fence.source,
    roots: [...fence.roots],
    homeWide: fence.homeWide,
    homeRootAcknowledgedAt: fence.homeRootAcknowledgedAt,
    warnings: [...fence.warnings],
    errors: [...fence.errors],
    summary: fence.summary,
    fix: fence.fix,
    configPath: fence.configPath,
  };
}

// The refusal every agent-facing path throws while the fence is not configured.
export function setupRequiredError(fence) {
  return {
    status: 409,
    code: SETUP_REQUIRED_CODE,
    setupRequired: true,
    fix: fence.fix,
    message: `${fence.summary} An operator fixes it on the Orca workstation with: ${fence.fix} — agents cannot change the fence.`,
  };
}
