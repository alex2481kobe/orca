// Executor type support + startup blockers, as a prototype mixin for OrcaRegistry.
//
// This replaces registry-cli-info.js + registry-executor-caps.js (713 lines) that
// shelled out to each CLI, grepped its --help text for slash commands and flags,
// and parsed ~/.codex/config.toml — all to build a capability matrix for a composer
// UI that no longer exists. Nothing read the result: lane.executorCapabilities was
// written on every lane and never consumed, and the /api/executors/* routes had no
// caller. Orca's contract with a CLI is now just: is the binary runnable.
//
// What survives is what is actually load-bearing: the set of executor types
// createLane will accept, and a cheap "can I run this binary" probe behind
// /api/system/blockers.

import { spawnSync } from 'node:child_process';
import { nowIso } from './registry-utils.js';
import {
  FIRST_CLASS_CLI_EXECUTOR_TYPES,
  getExecutorProfile as getExecutorProfileFromFactory,
} from './executor-factory.js';

const VERSION_TTL_MS = 60 * 1000;
const versionCache = new Map();

// Bounded, cached `<binary> --version`. 4s timeout, 64 KiB buffer, no shell.
function probeBinary(binary) {
  const key = String(binary || '');
  const cached = versionCache.get(key);
  if (cached && (Date.now() - cached.at) < VERSION_TTL_MS) return cached.value;
  let value;
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    value = result.error
      ? { exists: false, version: null, exitCode: result.error.code ?? null }
      : { exists: true, version: String(result.stdout || result.stderr || '').trim() || null, exitCode: result.status };
  } catch (error) {
    value = { exists: false, version: null, exitCode: error?.code ?? null };
  }
  if (versionCache.size > 64) versionCache.clear();
  versionCache.set(key, { value, at: Date.now() });
  return value;
}

export const executorMethods = {
  getSupportedExecutorTypes() {
    const supported = ['mock', ...FIRST_CLASS_CLI_EXECUTOR_TYPES];
    // The generic 'cli' executor only exists when explicitly enabled by env.
    if (getExecutorProfileFromFactory('cli')) supported.push('cli');
    return [...new Set(supported)];
  },

  async describeSystemBlockers() {
    const blockers = [];
    for (const executorType of ['codex', 'claude']) {
      const profile = getExecutorProfileFromFactory(executorType) || {};
      const binary = String(profile.defaultBinary || executorType);
      const probe = probeBinary(binary);
      if (!probe.exists) {
        blockers.push({
          id: `executor-${executorType}-missing`,
          severity: 'error',
          area: 'executor',
          summary: `${executorType.toUpperCase()} CLI not executable`,
          detail: `Configured binary ${binary} could not be invoked (exitCode=${probe.exitCode ?? 'n/a'}).`,
          remediation: `The ${executorType} binary is not executable on this machine, so lanes with executorType '${executorType}' cannot spawn. Point Orca at a working binary or choose another executor.`,
          approvalRequired: true,
        });
      } else if (!probe.version) {
        blockers.push({
          id: `executor-${executorType}-version-unknown`,
          severity: 'warn',
          area: 'executor',
          summary: `${executorType.toUpperCase()} CLI version is unknown`,
          detail: `${binary} exists but did not return a version. Trust state cannot be verified.`,
          remediation: `Run \`${binary} --version\` manually and confirm output.`,
          approvalRequired: false,
        });
      }
    }
    return { generatedAt: nowIso(), blockers };
  },
};
