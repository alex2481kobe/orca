// Agent tool contract. Split into contract/tool-definitions/roles/registry-views/
// discovery/next-action; this barrel preserves the public surface.

export { CONTRACT_VERSION } from './agent-tools/contract.js';
export { TOOL_DEFINITIONS, findTool } from './agent-tools/tool-definitions.js';
export { normalizeRole, availableToolIdsForRole } from './agent-tools/roles.js';
export { buildAgentToolDiscovery } from './agent-tools/discovery.js';
export { buildNextActionEnvelope } from './agent-tools/next-action.js';
export { ROLE_INSTRUCTIONS, roleInstructions } from './agent-tools/role-instructions.js';
