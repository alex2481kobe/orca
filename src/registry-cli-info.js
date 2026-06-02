// Executor CLI introspection helpers. Extracted from registry.js.
//
// These probe a CLI binary (version + --help) and parse capabilities out of help
// text, so Orca can advertise what each executor supports. All are pure aside
// from the bounded, timed spawnSync probes (4s timeout, capped buffers).

import { spawnSync } from 'node:child_process';
import { normalizeExecutorType, safeArray } from './registry-utils.js';

export function getCliVersion(binary) {
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });

    if (result.error) {
      return {
        exists: false,
        version: null,
        exitCode: result.error.code,
      };
    }

    const raw = String(result.stdout || result.stderr || '').trim();
    return {
      exists: true,
      version: raw || null,
      exitCode: result.status,
    };
  } catch (error) {
    return {
      exists: false,
      version: null,
      exitCode: error.code,
    };
  }
}

export function getCliHelp(binary, executorType) {
  try {
    const args = normalizeExecutorType(executorType) === 'codex'
      ? ['exec', '--help']
      : ['--help'];
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    if (result.error) {
      return {
        ok: false,
        text: '',
        exitCode: result.error.code,
      };
    }
    return {
      ok: result.status === 0,
      text: String(result.stdout || result.stderr || '').slice(0, 128 * 1024),
      exitCode: result.status,
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      exitCode: error.code,
    };
  }
}

export function helpHas(helpText, pattern) {
  return pattern.test(String(helpText || ''));
}

export function parseHelpChoices(helpText, flagName) {
  const text = String(helpText || '');
  const line = text.split(/\r?\n/).find((entry) => entry.includes(flagName) && (entry.includes('choices:') || entry.includes('possible values:')));
  if (!line) return [];
  const match = line.match(/\((?:choices|possible values):\s*([^)]+)\)/i);
  if (!match) return [];
  return match[1]
    .split(/[,\s|]+/)
    .map((value) => value.replace(/["'`]/g, '').trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 32);
}

export function compactCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return null;
  return {
    type: capabilities.type,
    displayName: capabilities.displayName,
    kind: capabilities.kind,
    binary: capabilities.binary,
    binaryExists: Boolean(capabilities.binaryExists),
    version: capabilities.version || null,
    roles: safeArray(capabilities.roles),
    controls: capabilities.controls || {},
    invocation: capabilities.invocation || {},
    mcpScopes: safeArray(capabilities.mcpScopes),
    detection: capabilities.detection || {},
  };
}
