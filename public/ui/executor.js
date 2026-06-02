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
      const suffix = profile.enabled === false ? ' (setup)' : '';
      return `<option value="${id}">${label}${suffix}</option>`;
    })
    .join('');
}

export function leaderOptions(selected = 'codex') {
  const profiles = shell.executorProfiles || {};
  const normalized = normalizeExecutorType(selected);
  const titleCase = (id) => id.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  const available = FIRST_CLASS_CLI_EXECUTOR_TYPES.filter((id) => profiles[id]);
  // Fall back to the canonical pair before profiles have loaded so the leader
  // select is never empty.
  const ids = available.length ? available : ['codex', 'claude'];
  const cliOpts = ids
    .map((id) => `<option value="${safeAttr(id)}"${normalized === id ? ' selected' : ''}>${safeText(titleCase(id))}-led</option>`)
    .join('');
  const mixedSelected = normalized === 'mixed' ? ' selected' : '';
  return `${cliOpts}<option value="mixed"${mixedSelected}>Mixed</option>`;
}

export function cliExecutorOptions(selected = '') {
  const profiles = shell.executorProfiles || {};
  return FIRST_CLASS_CLI_EXECUTOR_TYPES
    .filter((id) => profiles[id])
    .map((id) => {
      const selectedAttr = normalizeExecutorType(selected) === id ? ' selected' : '';
      return `<option value="${safeAttr(id)}"${selectedAttr}>${safeText(id)}</option>`;
    })
    .join('');
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
