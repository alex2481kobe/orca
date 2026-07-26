// Argument/command sanitization + shell tokenization.

import { MAX_ARGS, CONTROL_CHAR_RE } from './constants.js';

export function parseEnv(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const output = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    if (CONTROL_CHAR_RE.test(key) || CONTROL_CHAR_RE.test(String(value))) continue;
    output[key.trim()] = String(value);
  }
  return output;
}

export function safeFire(callback, ...args) {
  try {
    return Promise.resolve(callback(...args)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export function normalizeArgs(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .slice(0, MAX_ARGS);
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    return splitShellTokens(text).filter(Boolean).slice(0, MAX_ARGS);
  }
  return [];
}

export function splitShellTokens(raw) {
  const input = String(raw || '').trim();
  if (!input) return [];

  const out = [];
  let token = '';
  let quote = null;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (escape) {
      token += char;
      escape = false;
      continue;
    }

    if (char === '\\') {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      token += char;
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (token) {
        out.push(token);
        token = '';
      }
      continue;
    }

    token += char;
  }

  if (quote) {
    throw new Error('Unclosed quote in command string.');
  }

  if (escape) {
    token += '\\';
  }

  if (token) {
    out.push(token);
  }
  return out;
}

export function sanitizeCommandComponent(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${label} must not be empty.`);
  }
  if (text.length > 255) {
    throw new Error(`${label} is too long.`);
  }
  if (CONTROL_CHAR_RE.test(text)) {
    throw new Error(`${label} contains control characters.`);
  }
  return text;
}

export function sanitizeArgument(value, index) {
  const text = sanitizeCommandComponent(value, `Argument #${index}`);
  return text;
}

export function sanitizeBinary(value) {
  const text = sanitizeCommandComponent(value, 'Binary');
  if (/[|&;<>$`()]/.test(text)) {
    throw new Error('Binary contains blocked characters.');
  }
  return text;
}

export function normalizeAllowedBinaries(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    try {
      const normalized = sanitizeBinary(raw);
      const lower = normalized.toLowerCase();
      if (!out.includes(lower)) out.push(lower);
    } catch {
      continue;
    }
  }
  return out;
}

// Cap total forwarded child output (stdout+stderr) to bound memory use.
export const MAX_EXECUTOR_OUTPUT_BYTES = 10 * 1024 * 1024;

export function displayArg(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : JSON.stringify(text);
}

// Server-managed env keys a lane may never set or override.
export const RESERVED_EXECUTOR_ENV_KEYS = new Set([
  'ORCA_LANE_ID',
  'ORCA_ORCHESTRATOR_ID',
  'ORCA_SESSION_ID',
  'ORCA_PROJECT_ID',
  'ORCA_ARTIFACT_DIR',
  'ORCA_MCP_CONFIG',
]);

// Injected by the server runtime (runtimeEnvForLane), and must NEVER be accepted
// from a lane's own env — otherwise a lane could forge its tool-lease token,
// agent-tools base URL (SSRF / lease exfil), or role to escalate privileges.
export const RUNTIME_ONLY_ENV_KEYS = new Set([
  'ORCA_TOOL_LEASE_TOKEN',
  'ORCA_AGENT_TOOLS_BASE_URL',
  'ORCA_ROLE',
]);
