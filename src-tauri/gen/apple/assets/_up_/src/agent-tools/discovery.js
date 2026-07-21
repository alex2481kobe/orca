// Agent tool discovery envelope. Extracted from agent-tools.js.

import { CONTRACT_VERSION, ROLES } from './contract.js';
import { getToolDefinitions } from './tool-definitions.js';
import { availableToolIdsForRole, blockedToolSummariesForRole } from './roles.js';
import { buildMcpToolsByExecutor } from './registry-views.js';

export function buildAgentToolDiscovery(registry = null) {
  const tools = getToolDefinitions();
  const groups = [...new Set(tools.map((tool) => tool.group))].sort();
  const roles = [...ROLES].sort().map((role) => ({
    role,
    allowedImplementedTools: availableToolIdsForRole(role),
    plannedTools: blockedToolSummariesForRole(role).map((tool) => tool.id),
  }));
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    publicSafe: true,
    secretPolicy: 'Discovery never includes secret values, env values, absolute workdirs, private docs, or local usernames.',
    leasePolicy: 'Mutating agent tools require normal dashboard auth today; lane/session leases are minted by /api/agent-tools/leases and are required by future guarded tool execution routes.',
    groups,
    roles,
    executorCapabilities: typeof registry?.getExecutorCapabilitiesMatrix === 'function'
      ? registry.getExecutorCapabilitiesMatrix()
      : {},
    mcpToolsByExecutor: buildMcpToolsByExecutor(registry),
    tools,
  };
}
