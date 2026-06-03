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

// Extract model aliases / example names a CLI documents in its `--model` help
// block. Claude, for example, prints: "Provide an alias for the latest model
// (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-opus-4-8')."
// Aliases like 'opus'/'sonnet' never go stale (they resolve to the latest), so
// detecting them here keeps the model picker current without hardcoding version
// numbers. Returns [] for CLIs that document no examples (free-text still works).
export function parseModelHints(helpText) {
  const lines = String(helpText || '').split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /(^|\s)(-[a-z],\s*)?--model(\s|<|=)/i.test(line) && !/--fallback-model/i.test(line));
  if (startIdx < 0) return [];
  const block = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break; // blank line ends the option block
    if (/^\s*-{1,2}[a-z]/i.test(line)) break; // next option starts
    if (!/^\s/.test(line)) break; // dedented prose, no longer this option
    block.push(line);
  }
  const text = block.join(' ');
  // Match a single model-like token inside quotes. Requiring the whole quoted
  // span to be one valid token avoids desync from stray apostrophes in prose
  // (e.g. "model's full name") that would otherwise swallow real examples.
  const STOP = new Set(['e.g', 'eg', 'i.e', 'the', 'an', 'or', 'for', 'of', 'to', 'and', 'model', 'alias', 'name', 'full', 'latest', 'current', 'session']);
  const tokens = [];
  for (const match of text.matchAll(/['"`]([a-z][a-z0-9._-]{1,39})['"`]/gi)) {
    const token = match[1].trim();
    if (!STOP.has(token.toLowerCase())) tokens.push(token);
  }
  return tokens.filter((token, index, all) => all.indexOf(token) === index).slice(0, 16);
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
