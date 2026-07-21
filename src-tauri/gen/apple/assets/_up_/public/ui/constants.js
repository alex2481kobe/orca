// Static configuration constants + inline SVG icon markup for the dashboard.
// Pure data, no state. Extracted from app.js.

export const MOBILE_NAV_BREAKPOINT = 880;

export const API_PROVIDER_EXECUTOR_TYPES = ['api', 'openai-compatible', 'gemini', 'kimi', 'deepseek', 'openrouter', 'composer'];
export const FIRST_CLASS_CLI_EXECUTOR_TYPES = ['codex', 'claude', 'gemini-cli', 'composer-cli'];
export const CLI_EXECUTOR_TARGET_ALIASES = {
  codex: ['codex'],
  claude: ['claude'],
  'gemini-cli': ['gemini', 'gemini-cli'],
  'composer-cli': ['cursor-agent', 'composer-cli'],
};
export const MCP_TOOL_SCOPE_ALLOWLIST = [
  'all',
  'mock',
  'codex',
  'claude',
  'gemini-cli',
  'composer-cli',
  'cli',
  'custom-cli',
  ...API_PROVIDER_EXECUTOR_TYPES,
];

export const SIDEBAR_ORDER_STORAGE_KEY = 'orcaSidebarOrder:v1';
export const NOTIFICATION_SEEN_STORAGE_KEY = 'orcaNotificationsSeen:v1';
// Icons moved to the design-system icon module — import from ./icons.js.
