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

export const API_TOKEN_STORAGE_KEY = 'orcaApiToken';
export const SIDEBAR_ORDER_STORAGE_KEY = 'orcaSidebarOrder:v1';
export const NOTIFICATION_SEEN_STORAGE_KEY = 'orcaNotificationsSeen:v1';
export const FOLDER_ICON = `
  <span class="sidebar-folder" aria-hidden="true">
    <svg viewBox="0 0 20 16" focusable="false">
      <path d="M1.5 4.5h6l1.4 2h9.6v7.2c0 .7-.6 1.3-1.3 1.3H2.8c-.7 0-1.3-.6-1.3-1.3V4.5Z"></path>
      <path d="M1.5 4.5V3c0-.8.6-1.4 1.4-1.4h4.4l1.5 1.8h8c.8 0 1.4.6 1.4 1.4v1.7"></path>
    </svg>
  </span>
`;
export const COMPOSE_ICON = `
  <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
    <path d="M4.2 2.8h7.2a1.4 1.4 0 0 1 1.4 1.4v2.4"></path>
    <path d="M9.8 17.2H4.2a1.4 1.4 0 0 1-1.4-1.4V4.2a1.4 1.4 0 0 1 1.4-1.4"></path>
    <path d="m11.1 14.7 4.9-4.9 2.1 2.1-4.9 4.9-2.7.6.6-2.7Z"></path>
  </svg>
`;
export const PENCIL_ICON = `
  <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
    <path d="M4 16h3l8.3-8.3a1.5 1.5 0 0 0-2.1-2.1L4.9 13Z"></path>
    <path d="m12.2 6.6 2.1 2.1"></path>
  </svg>
`;
