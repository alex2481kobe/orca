// Executor factory constants. Extracted from executor-factory.js.

import { fileURLToPath } from 'node:url';

export const ORCA_MCP_SERVER_PATH = fileURLToPath(new URL('../mcp-server.js', import.meta.url));

export const noopAsync = async () => {};

export const DEFAULT_ENV_WHITELIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'USERNAME',
  'SHELL',
  'TERM',
];

export const MAX_ARGS = 256;
export const MAX_WORKDIR_BYTES = 2048;
export const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
export const FIRST_CLASS_CLI_EXECUTOR_TYPES = ['codex', 'claude', 'gemini-cli', 'composer-cli'];
export const CLI_EXECUTOR_TYPES = [...FIRST_CLASS_CLI_EXECUTOR_TYPES, 'cli'];
export const CLI_EXECUTOR_DEFAULTS = {
  codex: {
    envPrefix: 'CODEX',
    binary: 'codex',
    allowedBinaries: ['codex'],
  },
  claude: {
    envPrefix: 'CLAUDE',
    binary: 'claude',
    allowedBinaries: ['claude'],
  },
  'gemini-cli': {
    envPrefix: 'GEMINI_CLI',
    binary: 'gemini',
    allowedBinaries: ['gemini'],
  },
  'composer-cli': {
    envPrefix: 'COMPOSER_CLI',
    binary: 'cursor-agent',
    allowedBinaries: ['cursor-agent'],
  },
  cli: {
    envPrefix: 'CLI',
    binary: 'node',
    allowedBinaries: ['node'],
  },
};
