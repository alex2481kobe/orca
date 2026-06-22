// Agent tool discovery envelope. Extracted from agent-tools.js.

import { CONTRACT_VERSION, ROLES } from './contract.js';
import { getToolDefinitions } from './tool-definitions.js';
import { availableToolIdsForRole } from './roles.js';
import { buildMcpToolsByExecutor } from './registry-views.js';

export function buildAgentToolDiscovery(registry = null) {
  const tools = getToolDefinitions();
  const groups = [...new Set(tools.map((tool) => tool.group))].sort();
  const roles = [...ROLES].sort().map((role) => ({
    role,
    allowedImplementedTools: availableToolIdsForRole(role),
    plannedTools: [],
  }));
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    publicSafe: true,
    secretPolicy: 'Discovery never includes secret values, env values, absolute workdirs, private docs, or local usernames.',
    leasePolicy: 'Scoped tool leases authenticate MCP and CLI agent calls. Route guards accept only the tool ids granted to the lease; admin-only host actions still require API token or loopback workstation auth.',
    groups,
    roles,
    executorCapabilities: typeof registry?.getExecutorCapabilitiesMatrix === 'function'
      ? registry.getExecutorCapabilitiesMatrix()
      : {},
    mcpToolsByExecutor: buildMcpToolsByExecutor(registry),
    tools,
  };
}
