// Executor factory. Helpers/adapters split under executor/; this barrel holds
// the factory + re-exports the public surface.

import { MockWorkerAdapter } from './worker-contract.js';
import { API_PROVIDER_TYPES, FIRST_CLASS_CLI_EXECUTOR_TYPES, CLI_EXECUTOR_TYPES, CLI_EXECUTOR_DEFAULTS, MAX_ARGS } from './executor/constants.js';
import { buildExecutorCommandArgs } from './executor/command-builder.js';
import { isApiProviderType, getApiProviderProfile, getApiProviderExecutorTypes } from './executor/api-support.js';
import { CliExecutorAdapter, PendingExecutorAdapter } from './executor/cli-adapter.js';
import { ApiExecutorAdapter } from './executor/api-adapter.js';

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
  const workdirRoots = parseEnvList(process.env[`ORCA_${upper}_WORKDIR_ROOTS`], [process.cwd()]);
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
      heartbeatTimeoutMs: callbacks.heartbeatTimeoutMs || 15000,
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
      heartbeatTimeoutMs: callbacks.heartbeatTimeoutMs || 15000,
    };
    return new CliExecutorAdapter(executorType, options);
  }

  if (isApiProviderType(executorType)) {
    const profile = getApiProviderProfile(executorType);
    if (!profile) {
      return new PendingExecutorAdapter(executorType, callbacks);
    }
    return new ApiExecutorAdapter(executorType, {
      ...callbacks,
      profile,
    });
  }

  return new PendingExecutorAdapter(executorType, callbacks);
}
export {
  API_PROVIDER_TYPES,
  buildExecutorCommandArgs,
  FIRST_CLASS_CLI_EXECUTOR_TYPES,
  getApiProviderExecutorTypes,
  getApiProviderProfile,
  isApiProviderType,
};
