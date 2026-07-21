// Role normalization + per-role tool permission filtering. Extracted from
// agent-tools.js.

import { ROLES } from './contract.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';

export function normalizeRole(role) {
  const normalized = String(role || 'orchestrator').trim().toLowerCase();
  return ROLES.has(normalized) ? normalized : 'orchestrator';
}

export function availableToolIdsForRole(role) {
  const normalizedRole = normalizeRole(role);
  return TOOL_DEFINITIONS
    .filter((tool) => tool.implemented && tool.roles.includes(normalizedRole))
    .map((tool) => tool.id);
}

export function blockedToolSummariesForRole(role) {
  const normalizedRole = normalizeRole(role);
  return TOOL_DEFINITIONS
    .filter((tool) => tool.roles.includes(normalizedRole) && !tool.implemented)
    .map((tool) => ({
      id: tool.id,
      reason: 'planned_not_wired',
    }));
}
