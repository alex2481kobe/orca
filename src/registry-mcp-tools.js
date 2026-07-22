// MCP tool registry: command/arg/env sanitization + tool CRUD, as a prototype
// mixin (methods) plus the validation helpers. Extracted from registry.js.

import path from 'node:path';
import { clonePayload, nowIso } from './registry-utils.js';

// Local copy of the workdir byte cap (sanitizeMcpWorkdir); kept module-local to
// avoid coupling back to registry.js.
const MAX_WORKDIR_BYTES = 2048;

const MCP_TOOL_SCOPE_ALLOWLIST = new Set([
  'all',
  'mock',
  'codex',
  'claude',
  'gemini-cli',
  'composer-cli',
  'cli',
  'custom-cli',
]);
const MAX_MCP_TOOL_ARG_LENGTH = 255;
const MAX_MCP_TOOL_ARGS = 64;

function getMcpCommandAllowlist() {
  const override = process.env.ORCA_MCP_TOOL_COMMAND_ALLOWLIST;
  if (!override) return null;
  return String(override)
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function sanitizeMcpName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) {
    throw { status: 422, message: 'MCP tool name is required.' };
  }
  if (!/^[a-z0-9-_\.]+$/.test(name)) {
    throw { status: 422, message: 'MCP tool names may only include letters, numbers, hyphen, underscore, and period.' };
  }
  return name;
}

function normalizeMcpScope(raw) {
  const rawList = Array.isArray(raw) ? raw : [];
  const scopes = rawList
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const sanitized = Array.from(new Set(scopes));
  const invalid = sanitized.filter((scope) => !MCP_TOOL_SCOPE_ALLOWLIST.has(scope));
  if (invalid.length) {
    throw { status: 422, message: `MCP tool scope contains unsupported values: ${invalid.join(', ')}` };
  }
  return sanitized;
}

function normalizeCommandArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => sanitizeMcpArgument(item, index))
    .filter(Boolean)
    .slice(0, MAX_MCP_TOOL_ARGS);
}

function sanitizeMcpArgument(raw, index) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.length > MAX_MCP_TOOL_ARG_LENGTH) {
    throw {
      status: 422,
      message: `MCP tool argument #${index + 1} is too long.`,
    };
  }
  if (/[|&;<>$`\r\n\t]/.test(text)) {
    throw {
      status: 422,
      message: `MCP tool argument #${index + 1} contains blocked characters.`,
    };
  }
  return text;
}

// Env keys that can hijack process loading, PATH resolution, or the runtime;
// never accept these from a user-defined MCP tool.
const DANGEROUS_ENV_KEYS = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'BASH_ENV',
  'ENV',
  'IFS',
  'SHELLOPTS',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
]);

function sanitizeMcpEnv(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw { status: 422, message: 'MCP tool env must be an object of string keys/values.' };
  }
  const out = {};
  const keys = Object.keys(raw);
  if (keys.length > 64) {
    throw { status: 422, message: 'MCP tool env has too many entries (max 64).' };
  }
  for (const key of keys) {
    const value = raw[key];
    const safeKey = String(key || '').trim();
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/i.test(safeKey)) {
      throw { status: 422, message: `MCP tool env key "${safeKey}" is invalid (use letters, digits, underscore).` };
    }
    if (DANGEROUS_ENV_KEYS.has(safeKey.toUpperCase())) {
      throw { status: 422, message: `MCP tool env key "${safeKey}" is not allowed (it can hijack process loading/PATH).` };
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw { status: 422, message: `MCP tool env value for ${safeKey} must be a primitive.` };
    }
    const text = String(value);
    if (text.length > 1024) {
      throw { status: 422, message: `MCP tool env value for ${safeKey} is too long (max 1024).` };
    }
    if (/[\x00-\x1f\x7f]/.test(text)) {
      throw { status: 422, message: `MCP tool env value for ${safeKey} contains control characters.` };
    }
    out[safeKey] = text;
  }
  return out;
}

function sanitizeMcpWorkdir(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  const text = String(raw).trim();
  if (!text) return '';
  if (text.length > MAX_WORKDIR_BYTES) {
    throw { status: 422, message: 'MCP tool workdir is too long.' };
  }
  if (/\x00/.test(text)) {
    throw { status: 422, message: 'MCP tool workdir contains invalid bytes.' };
  }
  if (/[\x01-\x1f\x7f]/.test(text)) {
    throw { status: 422, message: 'MCP tool workdir contains control characters.' };
  }
  return text;
}

function sanitizeMcpText(raw, label, maxLen) {
  if (raw === undefined || raw === null) return '';
  const text = String(raw);
  if (text.length > maxLen) {
    throw { status: 422, message: `MCP tool ${label} exceeds ${maxLen}-character limit.` };
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw { status: 422, message: `MCP tool ${label} contains control characters.` };
  }
  return text.trim();
}

function sanitizeMcpCommand(raw) {
  const command = String(raw || '').trim();
  if (!command) {
    throw { status: 422, message: 'MCP tool command is required.' };
  }
  if (/\s/.test(command)) {
    throw { status: 422, message: 'MCP tool command must be a single executable token.' };
  }
  if (command.length > 255) {
    throw { status: 422, message: 'MCP tool command is too long.' };
  }
  if (/[|&;<>$`]/.test(command)) {
    throw { status: 422, message: 'MCP tool command contains blocked characters.' };
  }
  const allowlist = getMcpCommandAllowlist();
  if (allowlist && allowlist.length) {
    const normalized = command.toLowerCase();
    const baseCommand = path.basename(normalized);
    const allowed = allowlist.some((allowedCommand) => {
      const normalizedAllowed = String(allowedCommand || '').trim().toLowerCase();
      if (!normalizedAllowed) return false;
      if (normalized === normalizedAllowed) return true;
      return baseCommand === normalizedAllowed;
    });
    if (!allowed) {
      throw { status: 422, message: `MCP tool command "${command}" is not in the allowlist.` };
    }
  }
  return command;
}

export function normalizeMcpToolDefinition(payload = {}, { actor = 'dashboard', existing = null } = {}) {
  const name = sanitizeMcpName(payload.name || payload.id || existing?.name || existing?.id);
  const command = sanitizeMcpCommand(payload.command ?? existing?.command);
  const now = nowIso();
  return {
    id: name,
    name,
    command,
    args: Array.isArray(payload.args) ? normalizeCommandArray(payload.args) : normalizeCommandArray(existing?.args),
    env: payload.env !== undefined ? sanitizeMcpEnv(payload.env) : sanitizeMcpEnv(existing?.env),
    workdir: payload.workdir !== undefined ? sanitizeMcpWorkdir(payload.workdir) : sanitizeMcpWorkdir(existing?.workdir),
    enabled: payload.enabled !== undefined ? payload.enabled !== false : existing?.enabled !== false,
    scope: Array.isArray(payload.scope) ? normalizeMcpScope(payload.scope) : normalizeMcpScope(existing?.scope || []),
    description: sanitizeMcpText(payload.description ?? existing?.description, 'description', 500),
    notes: sanitizeMcpText(payload.notes ?? existing?.notes, 'notes', 1000),
    owner: sanitizeMcpText(payload.owner || existing?.owner || actor, 'owner', 120) || actor,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

export const mcpToolMethods = {
  getMcpTools(scope = null) {
    const normalizedScope = String(scope || '').trim().toLowerCase();
    if (!normalizedScope) {
      return clonePayload(this.mcpTools);
    }

    const matching = this.mcpTools.filter((tool) => {
      const toolScopes = Array.isArray(tool.scope) ? tool.scope : [];
      return toolScopes.includes('all') || toolScopes.includes(normalizedScope);
    });
    return clonePayload(matching);
  },

  getMcpTool(locator) {
    if (!locator) return null;
    const target = String(locator).toLowerCase();
    return this.mcpTools.find((tool) => tool.id === target || tool.name === target);
  },

  createMcpTool(payload = {}, context = {}) {
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('manageMcpTools', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const name = sanitizeMcpName(payload.name);
    if (this.getMcpTool(name)) {
      throw { status: 409, message: `MCP tool "${name}" already exists.` };
    }

    const tool = normalizeMcpToolDefinition(payload, { actor });

    this.mcpTools.push(tool);
    this.recordAudit({
      type: 'mcp_tool_created',
      actor,
      summary: `Created MCP tool ${name}`,
      evidence: { tool },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(tool);
  },

  updateMcpTool(locator, patch = {}, context = {}) {
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('manageMcpTools', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const tool = this.getMcpTool(locator);
    if (!tool) {
      throw { status: 404, message: 'MCP tool not found.' };
    }

    if (patch.name) {
      const nextName = sanitizeMcpName(patch.name);
      if (nextName !== tool.name && this.getMcpTool(nextName)) {
        throw { status: 409, message: `MCP tool "${nextName}" already exists.` };
      }
      tool.name = nextName;
      tool.id = nextName;
    }
    if (patch.command) tool.command = sanitizeMcpCommand(patch.command);
    if (Array.isArray(patch.args)) tool.args = normalizeCommandArray(patch.args);
    if (typeof patch.enabled === 'boolean') tool.enabled = patch.enabled;
    if (Array.isArray(patch.scope)) {
      tool.scope = normalizeMcpScope(patch.scope);
    }
    if (patch.env !== undefined) tool.env = sanitizeMcpEnv(patch.env);
    if (patch.workdir !== undefined) tool.workdir = sanitizeMcpWorkdir(patch.workdir);
    if (patch.description !== undefined) tool.description = sanitizeMcpText(patch.description, 'description', 500);
    if (patch.owner !== undefined) tool.owner = sanitizeMcpText(patch.owner, 'owner', 120) || tool.owner;
    if (patch.notes !== undefined) tool.notes = sanitizeMcpText(patch.notes, 'notes', 1000);

    tool.updatedAt = nowIso();
    this.recordAudit({
      type: 'mcp_tool_updated',
      actor,
      summary: `Updated MCP tool ${tool.name}`,
      evidence: { tool },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(tool);
  },

  deleteMcpTool(locator, context = {}) {
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('manageMcpTools', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const target = this.getMcpTool(locator);
    if (!target) {
      throw { status: 404, message: 'MCP tool not found.' };
    }

    const before = this.mcpTools.length;
    this.mcpTools = this.mcpTools.filter((tool) => tool.id !== target.id);
    if (this.mcpTools.length === before) {
      throw { status: 500, message: 'Failed to remove MCP tool.' };
    }

    const affectedLanes = [];
    for (const lane of this.lanes) {
      if (!Array.isArray(lane.mcpTools)) continue;
      const originalCount = lane.mcpTools.length;
      lane.mcpTools = lane.mcpTools.filter((item) => item?.id !== target.id);
      if (lane.mcpTools.length !== originalCount) {
        affectedLanes.push(lane.id);
        lane.updatedAt = nowIso();
      }
    }

    this.recordAudit({
      type: 'mcp_tool_deleted',
      actor,
      summary: `Deleted MCP tool ${target.name}`,
      evidence: {
        tool: target,
        affectedLanes,
      },
      status: 'passed',
    });
    this.persistState();
    return { removed: true, tool: clonePayload(target) };
  },

  listToolsForExecutor(executorType = '') {
    return this.mcpTools.filter((tool) => {
      if (!tool.enabled) return false;
      if (!tool.scope.length) return true;
      const target = String(executorType || '').toLowerCase();
      return tool.scope.includes(target) || tool.scope.includes('all');
    });
  },
};
