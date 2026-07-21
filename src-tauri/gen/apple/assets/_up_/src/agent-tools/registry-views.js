// Registry projection shared by discovery + next-action. Extracted from
// agent-tools.js.

export function buildMcpToolsByExecutor(registry) {
  if (typeof registry?.getSupportedExecutorTypes !== 'function' || typeof registry?.listToolsForExecutor !== 'function') {
    return {};
  }
  return registry.getSupportedExecutorTypes().reduce((accum, executorType) => {
    accum[executorType] = registry.listToolsForExecutor(executorType).map((tool) => ({
      id: tool.id,
      name: tool.name,
      scope: Array.isArray(tool.scope) ? tool.scope : [],
      enabled: Boolean(tool.enabled),
    }));
    return accum;
  }, {});
}
