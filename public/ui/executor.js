// Executor + MCP-tool helper functions (type normalization, command/binary
// targeting, profile lookups, provider/CLI option builders, tool scoping).
// Extracted from app.js.

import { shell } from './state.js';
import { safeText, safeAttr } from './format.js';
import {
  CLI_EXECUTOR_TARGET_ALIASES,
  API_PROVIDER_EXECUTOR_TYPES,
  FIRST_CLASS_CLI_EXECUTOR_TYPES,
  MCP_TOOL_SCOPE_ALLOWLIST,
} from './constants.js';

export function normalizeExecutorType(raw) {
  return String(raw || '').toLowerCase().trim();
}

export function parseCommandParts(raw) {
  return String(raw || '').trim().split(/\s+/).filter(Boolean);
}

export function executorTargetsCommand(executorType, commandParts) {
  const normalizedType = normalizeExecutorType(executorType);
  if (!normalizedType) return true;
  if (!Array.isArray(commandParts) || !commandParts.length) return true;
  const first = String(commandParts[0]).toLowerCase();
  const aliases = CLI_EXECUTOR_TARGET_ALIASES[normalizedType] || [normalizedType];
  return aliases.some((alias) => first.includes(alias));
}

export function executorTargetsBinary(executorType, binary) {
  const normalizedType = normalizeExecutorType(executorType);
  if (!normalizedType) return true;
  const normalizedBinary = String(binary || '').trim().toLowerCase();
  const binaryName = normalizedBinary.split('/').pop();
  const aliases = CLI_EXECUTOR_TARGET_ALIASES[normalizedType] || [normalizedType];
  return aliases.some((alias) => binaryName.includes(alias));
}

export function getExecutorProfile(type) {
  const profileType = normalizeExecutorType(type);
  return shell.executorProfiles && shell.executorProfiles[profileType] ? shell.executorProfiles[profileType] : null;
}

export function getProviderProfile(type) {
  const profileType = normalizeExecutorType(type);
  const profiles = Array.isArray(shell.providerCatalog?.profiles) ? shell.providerCatalog.profiles : [];
  return profiles.find((profile) => normalizeExecutorType(profile.id) === profileType) || null;
}

export function isApiExecutorType(type) {
  return API_PROVIDER_EXECUTOR_TYPES.includes(normalizeExecutorType(type));
}

export function apiProviderOptions() {
  const profiles = Array.isArray(shell.providerCatalog?.profiles) ? shell.providerCatalog.profiles : [];
  return profiles
    .filter((profile) => profile.kind === 'api')
    .map((profile) => {
      const id = safeAttr(profile.id);
      const label = safeText(profile.displayName || profile.id);
      // Not-yet-configured providers are greyed out (disabled) — set them up in
      // Settings before they can be selected as an agent.
      const notReady = profile.enabled === false;
      const suffix = notReady ? ' (setup)' : '';
      const disabledAttr = notReady ? ' disabled' : '';
      return `<option value="${id}"${disabledAttr}>${label}${suffix}</option>`;
    })
    .join('');
}

export function leaderOptions(selected = 'codex') {
  const profiles = shell.executorProfiles || {};
  const normalized = normalizeExecutorType(selected);
  const titleCase = (id) => id.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  const available = FIRST_CLASS_CLI_EXECUTOR_TYPES.filter((id) => profiles[id]);
  // Fall back to the full first-class list before profiles have loaded so the
  // leader select is never empty (and never a stale hardcoded pair).
  const ids = available.length ? available : [...FIRST_CLASS_CLI_EXECUTOR_TYPES];
  const cliOpts = ids
    .map((id) => `<option value="${safeAttr(id)}"${normalized === id ? ' selected' : ''}>${safeText(titleCase(id))}-led</option>`)
    .join('');
  const mixedSelected = normalized === 'mixed' ? ' selected' : '';
  return `${cliOpts}<option value="mixed"${mixedSelected}>Mixed</option>`;
}

// "Installed" means the CLI's binary was actually detected on the workstation.
export function isExecutorInstalled(type) {
  return Boolean(getExecutorProfile(type)?.capabilities?.binaryExists);
}

// Whether any real first-class CLI is installed (used to drop the mock fallback
// from the UI once the operator has a genuine agent).
export function anyCliInstalled() {
  return FIRST_CLASS_CLI_EXECUTOR_TYPES.some((id) => isExecutorInstalled(id));
}

// The model a CLI defaults to (operator-configured ORCA_<CLI>_MODEL, else the
// first model the CLI reports, else '' = the CLI's own built-in default).
export function defaultModelFor(type) {
  const node = getExecutorProfile(type)?.capabilities?.controls?.model;
  if (!node) return '';
  if (node.defaultValue) return node.defaultValue;
  return Array.isArray(node.values) && node.values.length ? node.values[0] : '';
}

// All model identifiers a given agent knows about (preset values + catalog slugs).
export function modelValuesForAgent(type) {
  const node = getExecutorProfile(type)?.capabilities?.controls?.model;
  const vals = Array.isArray(node?.values) ? node.values : [];
  const cat = Array.isArray(node?.catalog) ? node.catalog.map((m) => m.slug) : [];
  return [...new Set([...vals, ...cat].filter(Boolean))];
}

// True when `model` clearly belongs to a DIFFERENT installed agent (e.g. gpt-5.5
// left over while claude is selected). Free-text models the current agent doesn't
// list (e.g. opus-4-6) are NOT foreign — only models another agent advertises.
export function isForeignModel(model, type) {
  const m = String(model || '').trim();
  if (!m) return false;
  const current = normalizeExecutorType(type);
  if (modelValuesForAgent(current).includes(m)) return false;
  return FIRST_CLASS_CLI_EXECUTOR_TYPES.some(
    (other) => normalizeExecutorType(other) !== current && modelValuesForAgent(other).includes(m),
  );
}

export function cliExecutorOptions(selected = '') {
  const normalized = normalizeExecutorType(selected);
  // Show ALL first-class CLIs; ones whose binary isn't installed are greyed out
  // (disabled) rather than hidden, so the operator sees what's available.
  return FIRST_CLASS_CLI_EXECUTOR_TYPES
    .map((id) => {
      const installed = isExecutorInstalled(id);
      const selectedAttr = normalized === id ? ' selected' : '';
      const disabledAttr = installed ? '' : ' disabled';
      const suffix = installed ? '' : ' (not installed)';
      return `<option value="${safeAttr(id)}"${selectedAttr}${disabledAttr}>${safeText(id)}${suffix}</option>`;
    })
    .join('');
}

// The agent a new session/message should default to: the operator's chosen leader
// when it's installed, else the first installed first-class CLI, else codex.
export function firstInstalledExecutor() {
  return FIRST_CLASS_CLI_EXECUTOR_TYPES.find((id) => isExecutorInstalled(id)) || 'codex';
}

export function defaultExecutorType(preferred = '') {
  const norm = normalizeExecutorType(preferred);
  if (norm && isExecutorInstalled(norm)) return norm;
  return firstInstalledExecutor();
}

export function getExecutorScopedMcpTools(executorType) {
  const normalizedType = normalizeExecutorType(executorType);
  const tools = Array.isArray(shell.mcpTools) ? shell.mcpTools : [];
  return tools.filter((tool) => {
    const scope = Array.isArray(tool.scope) && tool.scope.length
      ? tool.scope.map((value) => String(value || '').toLowerCase())
      : [];
    return tool.enabled !== false && (!scope.length || scope.includes('all') || scope.includes(normalizedType));
  });
}

export function findMcpTool(locator) {
  if (!locator) return null;
  const target = String(locator).trim().toLowerCase();
  return Array.isArray(shell.mcpTools)
    ? shell.mcpTools.find((tool) => (tool.id === target || tool.name === target))
    : null;
}

export function normalizeMcpToolScopes(rawScopes) {
  const scopes = Array.isArray(rawScopes)
    ? rawScopes
    : String(rawScopes || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const normalized = Array.from(new Set(scopes));
  const invalid = normalized.filter((scope) => !MCP_TOOL_SCOPE_ALLOWLIST.includes(scope));
  if (invalid.length) {
    return {
      scopes: null,
      error: `Unsupported MCP scope(s): ${invalid.join(', ')}`,
    };
  }
  return { scopes: normalized.length ? normalized : ['all'], error: null };
}
