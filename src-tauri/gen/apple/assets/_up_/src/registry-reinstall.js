// Executor CLI reinstall command governance. Extracted from registry.js.
//
// Reinstall is a high-risk, approval-gated admin action: it shells out to a
// package manager to (re)install the Codex/Claude CLIs. Everything here exists to
// make sure the command that runs can only install the intended, allowlisted
// package from a trusted source — never an attacker-chosen registry, alias, or
// URL. All functions are pure (env-reading only); the actual spawn happens in
// registry.runExecutorCliReinstall.

import path from 'node:path';
import { normalizeExecutorType, parseBooleanEnv } from './registry-utils.js';

export const REINSTALL_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REINSTALL_ARG_LEN = 120;
const MAX_REINSTALL_ARGS = 24;
const ALLOWED_REINSTALL_BINARIES = new Set(['npm', 'pnpm', 'bun', 'brew', 'pip', 'pip3']);
const REINSTALL_PACKAGE_ALLOWLIST = {
  codex: ['codex', 'codex-cli', '@openai/codex'],
  claude: ['claude', 'claude-cli', 'claude-code', '@anthropic/claude-code', 'anthropic-ai/tap/claude'],
};
const REINSTALL_INSTALL_VERBS = {
  npm: ['install', 'i', 'update', 'upgrade', 'reinstall'],
  pnpm: ['install', 'add', 'update', 'upgrade', 'reinstall'],
  bun: ['install', 'add', 'upgrade', 'reinstall'],
  brew: ['install', 'upgrade', 'reinstall'],
  pip: ['install'],
  pip3: ['install'],
};
const DEFAULT_REINSTALL_COMMANDS = {
  codex: ['npm', 'install', '--yes', '-g', '@openai/codex'],
  claude: ['npm', 'install', '--yes', '-g', '@anthropic/claude-code'],
};
const DEFAULT_REINSTALL_SOURCE_REPOS = {
  codex: ['openai/codex'],
  claude: ['anthropic/claude-code'],
};
const FIRST_CLASS_CLI_TARGET_ALIASES = {
  codex: ['codex'],
  claude: ['claude'],
  'gemini-cli': ['gemini', 'gemini-cli'],
  'composer-cli': ['cursor-agent', 'composer-cli'],
};

function normalizeReinstallToken(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (value.length > MAX_REINSTALL_ARG_LEN) return null;
  if (/[|&;<>$`\r\n\t]/.test(value)) return null;
  return value;
}

export function getReinstallPackageAllowlist(type) {
  const normalizedType = normalizeExecutorType(type);
  const envKey = `ORCA_${normalizedType.toUpperCase()}_REINSTALL_PACKAGES`;
  const override = process.env[envKey];
  if (!override) {
    return REINSTALL_PACKAGE_ALLOWLIST[normalizedType] || [];
  }
  return String(override)
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

export function getReinstallSourceRepos(type) {
  const normalizedType = normalizeExecutorType(type);
  const envKey = `ORCA_${normalizedType.toUpperCase()}_REINSTALL_SOURCE_REPOS`;
  const override = process.env[envKey];
  if (!override) {
    return DEFAULT_REINSTALL_SOURCE_REPOS[normalizedType] || [];
  }
  return String(override)
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''));
}

export function shouldPreferSourceReinstall(type) {
  const normalizedType = normalizeExecutorType(type);
  const envKey = `ORCA_${normalizedType.toUpperCase()}_REINSTALL_PREFER_SOURCE`;
  return parseBooleanEnv(process.env[envKey], false);
}

export function getReinstallSourceCommand(type) {
  const repos = getReinstallSourceRepos(type);
  const preferredRepo = repos[0];
  if (!preferredRepo) return null;
  return ['npm', 'install', '--yes', '-g', `git+https://github.com/${preferredRepo}.git`];
}

function normalizeReinstallSourceRepo(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;

  const source = text.startsWith('git+') ? text.slice(4) : text;
  if (!source.startsWith('https://')) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, '');
  if (host !== 'github.com') return null;
  const parts = String(parsed.pathname || '').split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

function tokenMatchesReinstallSource(token, allowedSource) {
  const normalizedToken = normalizeReinstallSourceRepo(token);
  const normalizedAllowed = String(allowedSource || '').trim().toLowerCase();
  if (!normalizedToken || !normalizedAllowed) return false;
  return normalizedToken === normalizedAllowed;
}

// Only a plain semver / dist-tag may follow the "name@" separator. This rejects
// npm aliasing (pkg@npm:other), and git/file/url refs (pkg@git+https://...,
// pkg@file:...) that would otherwise install an attacker-chosen package while
// still "matching" the allowlisted name.
const SAFE_PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function packageMatchesAllowedName(normalizedToken, normalizedAllowed) {
  if (normalizedToken === normalizedAllowed) return true;
  const prefix = `${normalizedAllowed}@`;
  if (!normalizedToken.startsWith(prefix)) return false;
  const version = normalizedToken.slice(prefix.length);
  return SAFE_PACKAGE_VERSION.test(version);
}

function tokenMatchesPackage(token, allowedPackage) {
  const normalizedToken = String(token || '').toLowerCase();
  const normalizedAllowed = String(allowedPackage || '').toLowerCase();
  if (!normalizedToken || !normalizedAllowed) return false;
  const isScopedAllowed = normalizedAllowed.includes('/');
  if (normalizedToken.startsWith('http://')
    || normalizedToken.startsWith('https://')
    || normalizedToken.startsWith('git+')
    || normalizedToken.startsWith('file:')) return false;

  if (!isScopedAllowed) {
    if (normalizedToken.includes('/')) {
      // Disallow path-like package references to avoid URL/path spoofing.
      return false;
    }
    return packageMatchesAllowedName(normalizedToken, normalizedAllowed);
  }

  if (normalizedToken.includes('://')) return false;
  return packageMatchesAllowedName(normalizedToken, normalizedAllowed);
}

function hasAllowedReinstallTarget(parts, expectedType) {
  const packageAllowlist = getReinstallPackageAllowlist(expectedType);
  const sourceAllowlist = getReinstallSourceRepos(expectedType);
  if (!packageAllowlist.length && !sourceAllowlist.length) return true;

  const hasAllowedPackage = packageAllowlist.some((allowedPackage) => parts.some((part) => tokenMatchesPackage(part, allowedPackage)));
  const hasAllowedSource = sourceAllowlist.some((allowedSource) => parts.some((part) => tokenMatchesReinstallSource(part, allowedSource)));
  return hasAllowedPackage || hasAllowedSource;
}

function commandTargetsExecutor(type, commandParts) {
  const normalizedType = String(type || '').toLowerCase().trim();
  if (!normalizedType) return true;

  return commandParts.some((part) => {
    const token = normalizeReinstallToken(part);
    if (!token) return false;
    return token.includes(normalizedType);
  });
}

export function commandTargetsExecutorFirstToken(type, commandParts) {
  const normalizedType = String(type || '').toLowerCase().trim();
  if (!normalizedType) return true;
  if (!Array.isArray(commandParts)) return false;
  if (!commandParts.length) return true;
  const first = String(commandParts[0] || '').toLowerCase();
  const aliases = FIRST_CLASS_CLI_TARGET_ALIASES[normalizedType] || [normalizedType];
  return aliases.some((alias) => first.includes(alias));
}

function getInstallerVerbsForBinary(binary) {
  if (!binary) return ['install'];
  const normalizedBinary = String(binary).toLowerCase();
  const byBinary = REINSTALL_INSTALL_VERBS[normalizedBinary];
  const byBase = REINSTALL_INSTALL_VERBS[path.basename(normalizedBinary)];
  return byBase || byBinary || ['install'];
}

// Flags that redirect where a package comes from, rewrite config, or change
// execution semantics — these turn an allowlisted "reinstall codex" into a
// vector for pulling attacker-controlled code (e.g. --registry https://evil).
function isDangerousReinstallFlag(token) {
  const t = String(token || '').toLowerCase();
  if (t.includes('://')) return true; // url embedded in a --flag=value form
  return /^--?(registry|config|userconfig|globalconfig|prefix|cache|script-shell|scripts-prepend-node-path|node-options|unsafe-perm|allow-scripts|ignore-scripts|install-links|cwd|chdir|init-|tarball|pack-destination|auth|_auth|email)\b/.test(t);
}

// Every argument after the binary must be a known-safe token: an install verb, a
// benign flag, or an allowlisted package/source. Strict only when an allowlist
// exists for this executor type (it does for codex/claude).
function reinstallArgsAreSafe(args, { installVerbs, packageAllowlist, sourceAllowlist }) {
  const strict = packageAllowlist.length > 0 || sourceAllowlist.length > 0;
  for (const arg of args) {
    const lower = String(arg || '').toLowerCase();
    if (installVerbs.includes(normalizeReinstallToken(arg))) continue;
    if (lower.startsWith('-')) {
      if (isDangerousReinstallFlag(lower)) return false;
      continue;
    }
    const okPkg = packageAllowlist.some((p) => tokenMatchesPackage(arg, p));
    const okSrc = sourceAllowlist.some((s) => tokenMatchesReinstallSource(arg, s));
    if (okPkg || okSrc) continue;
    if (strict) return false; // unknown positional token in strict mode
    if (lower.includes('://')) return false; // bare URL target with no allowlist
  }
  return true;
}

export function normalizeReinstallCommand(raw, expectedType = null) {
  if (!raw) return null;
  if (!Array.isArray(raw) && typeof raw !== 'string') return null;

  let parts = [];
  if (Array.isArray(raw)) {
    parts = raw.map((item) => String(item || '').trim()).filter(Boolean);
  } else {
    const text = String(raw).trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        parts = parsed.map((item) => String(item || '').trim()).filter(Boolean);
      } else {
        parts = text.split(/\s+/).filter(Boolean);
      }
    } catch {
      parts = text.split(/\s+/).filter(Boolean);
    }
  }

  if (!parts.length || parts.length > MAX_REINSTALL_ARGS) return null;

  const [binary, ...args] = parts;
  const normalizedBinary = normalizeReinstallToken(binary);
  if (!ALLOWED_REINSTALL_BINARIES.has(normalizedBinary)) return null;

  const installVerbs = getInstallerVerbsForBinary(normalizedBinary);
  const hasInstallerVerb = args.some((arg) => installVerbs.includes(normalizeReinstallToken(arg)));
  if (!hasInstallerVerb) return null;

  if (!hasAllowedReinstallTarget(parts, expectedType)) return null;

  if (!commandTargetsExecutor(expectedType, parts)) return null;

  for (const part of parts) {
    if (!normalizeReinstallToken(part)) return null;
  }

  // Reject any extra/unknown arg (alt registries, config overrides, bare URLs)
  // so an allowlisted package name can't smuggle attacker-controlled sources.
  if (!reinstallArgsAreSafe(args, {
    installVerbs,
    packageAllowlist: getReinstallPackageAllowlist(expectedType),
    sourceAllowlist: getReinstallSourceRepos(expectedType),
  })) {
    return null;
  }

  return [binary, ...args];
}

export function getReinstallCommand(type) {
  const executorType = normalizeExecutorType(type);
  const config = {
    codex: 'ORCA_CODEX_REINSTALL_COMMAND',
    claude: 'ORCA_CLAUDE_REINSTALL_COMMAND',
  };
  const envVar = config[executorType];
  if (!envVar) return null;
  const configured = process.env[envVar];
  if (configured === undefined) {
    if (shouldPreferSourceReinstall(executorType)) {
      const sourceCommand = getReinstallSourceCommand(executorType);
      if (sourceCommand) {
        return normalizeReinstallCommand(sourceCommand, executorType);
      }
    }
    return normalizeReinstallCommand(DEFAULT_REINSTALL_COMMANDS[executorType], executorType);
  }
  return normalizeReinstallCommand(configured, executorType);
}
