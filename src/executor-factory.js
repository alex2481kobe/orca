// Executor factory. Helpers/adapters split under executor/; this barrel holds
// the factory + re-exports the public surface.

import { MockWorkerAdapter } from './worker-contract.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES, CLI_EXECUTOR_TYPES, CLI_EXECUTOR_DEFAULTS } from './executor/constants.js';
import { buildExecutorCommandArgs } from './executor/command-builder.js';
import { CliExecutorAdapter, PendingExecutorAdapter } from './executor/cli-adapter.js';

function parseEnvList(rawValue, fallback = []) {
  if (!rawValue) return fallback;
  if (Array.isArray(rawValue)) return rawValue;
  if (typeof rawValue !== 'string') return fallback;

  return rawValue
    .split(/[\s,]+/)
    .map((value) => String(value).trim())
    .filter(Boolean);
}

export function getExecutorProfile(type, callbacks = {}) {
  const executorType = String(type || '').toLowerCase();
  if (!CLI_EXECUTOR_TYPES.includes(executorType)) {
    return null;
  }
  if (executorType === 'cli' && process.env.ORCA_ENABLE_CUSTOM_CLI !== 'true' && !process.env.ORCA_CLI_BINARY) {
    return null;
  }
  const defaults = CLI_EXECUTOR_DEFAULTS[executorType] || CLI_EXECUTOR_DEFAULTS.cli;
  const upper = defaults.envPrefix;
  const binary = process.env[`ORCA_${upper}_BINARY`] || defaults.binary || executorType;
  const allowedBinaries = parseEnvList(process.env[`ORCA_${upper}_ALLOWED_BINARIES`], [
    binary,
    ...(defaults.allowedBinaries || []),
  ]);
  const defaultArgs = parseEnvList(process.env[`ORCA_${upper}_DEFAULT_ARGS`], []);
  // Allowed EXECUTION roots = the env override (or cwd) PLUS any extra roots the
  // registry supplies (the approved repo roots + the per-lane worktree base).
  // Without this, a lane running in a session's vetted repoRoot (an approved
  // ORCA_REPO_ROOTS path, but not necessarily under cwd) is rejected with
  // "workdir is outside allowed execution roots" — the remote-chat failure.
  const workdirRoots = [
    ...parseEnvList(process.env[`ORCA_${upper}_WORKDIR_ROOTS`], [process.cwd()]),
    ...(Array.isArray(callbacks.extraWorkdirRoots) ? callbacks.extraWorkdirRoots : []),
  ].filter(Boolean);
  const defaultWorkingDir = callbacks.defaultWorkingDir || process.cwd();

  return {
    type: executorType,
    defaultBinary: binary,
    allowedBinaries,
    defaultArgs,
    defaultWorkingDir,
    workdirRoots,
    envWhitelist: parseEnvList(process.env[`ORCA_${upper}_ENV_WHITELIST`], undefined),
  };
}

export function getExecutorProfiles() {
  return CLI_EXECUTOR_TYPES.reduce((accum, executorType) => {
    const profile = getExecutorProfile(executorType);
    if (profile) accum[executorType] = profile;
    return accum;
  }, {});
}

export function createExecutorAdapter(type, callbacks = {}) {
  const executorType = String(type || 'mock').toLowerCase();
  if (executorType === 'mock') {
    return new MockWorkerAdapter(callbacks);
  }

  if (FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(executorType)) {
    const profile = getExecutorProfile(executorType, callbacks);
    if (!profile) {
      return new PendingExecutorAdapter(executorType, callbacks);
    }

    const options = {
      ...callbacks,
      defaultBinary: profile.defaultBinary,
      // Real subprocess agents complete via child exit, not a periodic tool
      // heartbeat — a model turn easily runs >15s silently. Use a generous cap
      // (output resets it in the adapter) so live agents aren't reaped mid-run.
      // Configurable via ORCA_CLI_HEARTBEAT_TIMEOUT_MS; default 30 min.
      heartbeatTimeoutMs: callbacks.heartbeatTimeoutMs
        || Number.parseInt(process.env.ORCA_CLI_HEARTBEAT_TIMEOUT_MS, 10) || 30 * 60 * 1000,
      allowedBinaries: profile.allowedBinaries,
      envWhitelist: profile.envWhitelist || callbacks.envWhitelist,
      enforceAllowedBinary: true,
      workdirRoots: profile.workdirRoots,
      maxCommandArgs: 128,
      defaultArgs: profile.defaultArgs.length ? profile.defaultArgs : (callbacks.defaultArgs || []),
      defaultWorkingDir: callbacks.defaultWorkingDir || process.cwd(),
    };

    return new CliExecutorAdapter(executorType, options);
  }

  if (executorType === 'cli') {
    const profile = getExecutorProfile(executorType, callbacks);
    if (!profile) {
      return new PendingExecutorAdapter(executorType, callbacks);
    }
    const options = {
      ...callbacks,
      defaultBinary: profile.defaultBinary,
      allowedBinaries: profile.allowedBinaries,
      envWhitelist: profile.envWhitelist || callbacks.envWhitelist,
      workdirRoots: profile.workdirRoots,
      enforceAllowedBinary: true,
      maxCommandArgs: 128,
      defaultArgs: profile.defaultArgs.length ? profile.defaultArgs : (callbacks.defaultArgs || []),
      defaultWorkingDir: callbacks.defaultWorkingDir || process.cwd(),
      // Real subprocess agents complete via child exit, not a periodic tool
      // heartbeat — a model turn easily runs >15s silently. Use a generous cap
      // (output resets it in the adapter) so live agents aren't reaped mid-run.
      // Configurable via ORCA_CLI_HEARTBEAT_TIMEOUT_MS; default 30 min.
      heartbeatTimeoutMs: callbacks.heartbeatTimeoutMs
        || Number.parseInt(process.env.ORCA_CLI_HEARTBEAT_TIMEOUT_MS, 10) || 30 * 60 * 1000,
    };
    return new CliExecutorAdapter(executorType, options);
  }

  // SEAM: unknown executor types fall through to a PendingExecutorAdapter.
  // A future API-backed adapter is one more branch here (+ one adapter file),
  // mirroring the CliExecutorAdapter wiring above.
  return new PendingExecutorAdapter(executorType, callbacks);
}
export {
  buildExecutorCommandArgs,
  FIRST_CLASS_CLI_EXECUTOR_TYPES,
};
