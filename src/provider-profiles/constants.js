// Provider-profile constants + clone. Extracted from provider-profiles.js.

export const nowIso = () => new Date().toISOString();
export const SECRET_SERVICE = 'Orca';

export const PROVIDER_IDS = [
  'codex',
  'claude',
  'gemini-cli',
  'composer-cli',
  'custom-cli',
  'openai-compatible',
  'gemini',
  'kimi',
  'deepseek',
  'openrouter',
  'composer',
];
export const PROVIDER_KINDS = new Set(['mock', 'codex', 'claude', 'cli', 'api']);
export const INSTALL_POLICIES = new Set(['manual', 'plan_only', 'approval_required', 'managed']);
export const UPDATE_POLICIES = new Set(['manual', 'notify_only', 'approval_required', 'managed']);
export const API_STYLES = new Set(['openai-compatible', 'gemini', 'custom']);
export const CREDENTIAL_BACKENDS = new Set(['auto', 'memory', 'env', 'macos-keychain', 'windows-credential-manager', 'linux-secret-service']);
export const ROLE_COMPATIBILITY = ['orchestrator', 'executor', 'auditor', 'critique'];

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
