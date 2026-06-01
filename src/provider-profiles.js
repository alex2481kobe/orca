import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  readJsonFileWithRecovery,
  writeJsonFileAtomic,
} from './state-store.js';
import { validateNetworkUrl } from './url-policy.js';

const nowIso = () => new Date().toISOString();
const SECRET_SERVICE = 'Command Deck';

const PROVIDER_IDS = [
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
const PROVIDER_KINDS = new Set(['mock', 'codex', 'claude', 'cli', 'api']);
const INSTALL_POLICIES = new Set(['manual', 'plan_only', 'approval_required', 'managed']);
const UPDATE_POLICIES = new Set(['manual', 'notify_only', 'approval_required', 'managed']);
const API_STYLES = new Set(['openai-compatible', 'gemini', 'custom']);
const CREDENTIAL_BACKENDS = new Set(['auto', 'memory', 'env', 'macos-keychain', 'windows-credential-manager', 'linux-secret-service']);
const ROLE_COMPATIBILITY = ['orchestrator', 'executor', 'auditor', 'critique'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function ensurePlainObject(value, label = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw { status: 422, message: `${label} must be an object.` };
  }
  // Recurse so prototype-pollution keys can't hide in nested objects/arrays.
  const visit = (node, nodeLabel) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${nodeLabel}[${index}]`));
      return;
    }
    for (const key of Object.keys(node)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw { status: 422, message: `${nodeLabel} contains unsafe key "${key}".` };
      }
      visit(node[key], `${nodeLabel}.${key}`);
    }
  };
  visit(value, label);
}

function safeSlug(value) {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!slug) throw { status: 422, message: 'Provider id is required.' };
  return slug;
}

function normalizeStringArray(raw, fallback = [], maxItems = 32) {
  const input = Array.isArray(raw) ? raw : fallback;
  return input
    .map((value) => normalizeText(value).slice(0, 240))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, maxItems);
}

function normalizeEnvName(raw, { allowBlank = false } = {}) {
  const name = normalizeText(raw).toUpperCase();
  if (!name) {
    if (allowBlank) return null;
    throw { status: 422, message: 'Environment variable name is required.' };
  }
  if (!/^[A-Z_][A-Z0-9_]{0,120}$/.test(name)) {
    throw { status: 422, message: 'Environment variable name is invalid.' };
  }
  return name;
}

function normalizeSecretRef(raw, { allowBlank = false } = {}) {
  const ref = normalizeText(raw);
  if (!ref) {
    if (allowBlank) return null;
    throw { status: 422, message: 'Secret reference is required.' };
  }
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(ref)) {
    throw { status: 422, message: 'Secret reference is invalid.' };
  }
  return ref;
}

function validateBaseUrl(raw, { allowBlank = false } = {}) {
  const text = normalizeText(raw);
  if (!text) {
    if (allowBlank) return null;
    throw { status: 422, message: 'Base URL is required.' };
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw { status: 422, message: 'Base URL must be absolute.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw { status: 422, message: 'Base URL must use http or https.' };
  }
  if (parsed.username || parsed.password) {
    throw { status: 422, message: 'Base URL must not include credentials.' };
  }
  // SSRF guard: allow public provider endpoints plus loopback/tailnet, but
  // block private, metadata, link-local, multicast, and obfuscated hosts.
  validateNetworkUrl(text, {
    field: 'Base URL',
    allowedHosts: ['loopback', 'tailnet'],
    allowPublic: true,
    allowSensitive: true,
  });
  return parsed.toString().replace(/\/$/, '');
}

function validateBinary(raw, { allowBlank = false } = {}) {
  const text = normalizeText(raw);
  if (!text) {
    if (allowBlank) return null;
    throw { status: 422, message: 'Binary is required.' };
  }
  if (text.length > 255 || /[\x00-\x1f\x7f|&;<>$`()]/.test(text)) {
    throw { status: 422, message: 'Binary contains unsafe characters.' };
  }
  if (text.includes('..')) {
    throw { status: 422, message: 'Binary path must not contain "..".' };
  }
  return text;
}

function normalizeInstallPolicy(raw, fallback = 'plan_only') {
  const value = normalizeText(raw || fallback).toLowerCase();
  return INSTALL_POLICIES.has(value) ? value : fallback;
}

function normalizeUpdatePolicy(raw, fallback = 'notify_only') {
  const value = normalizeText(raw || fallback).toLowerCase();
  return UPDATE_POLICIES.has(value) ? value : fallback;
}

function apiProfile({
  id,
  displayName,
  baseUrl,
  apiStyle,
  secretRef,
  apiKeyEnv,
  enabled = false,
}) {
  return {
    id,
    displayName,
    kind: 'api',
    enabled,
    roleCompatibility: [...ROLE_COMPATIBILITY],
    defaultModel: '',
    allowedModels: [],
    defaultArgs: [],
    permissionsProfile: 'restricted',
    mcpScopes: ['api', 'all'],
    workdirRoots: [],
    defaultWorkingDir: '',
    envWhitelist: [],
    maxConcurrentLanes: 4,
    healthCheck: { type: 'api-config' },
    installPolicy: 'plan_only',
    updatePolicy: 'notify_only',
    baseUrl,
    apiStyle,
    secretRef,
    apiKeyEnv,
    timeoutMs: 30000,
    retryPolicy: { retries: 1, backoffMs: 500 },
    streaming: true,
    requestTemplate: 'chat-completions-compatible',
    responseParser: 'chat-completions-compatible',
    redactionPolicy: 'redact-authorization-and-body-secrets',
  };
}

function defaultProfiles() {
  const cwd = process.cwd();
  return {
    codex: {
      id: 'codex',
      displayName: 'Codex',
      kind: 'codex',
      enabled: true,
      roleCompatibility: [...ROLE_COMPATIBILITY],
      defaultModel: process.env.COMMAND_DECK_CODEX_MODEL || '',
      allowedModels: normalizeStringArray(process.env.COMMAND_DECK_CODEX_MODELS?.split(','), [], 32),
      defaultArgs: [],
      permissionsProfile: 'per-lane',
      mcpScopes: ['codex', 'all'],
      workdirRoots: [cwd],
      defaultWorkingDir: cwd,
      envWhitelist: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'SHELL', 'TERM'],
      maxConcurrentLanes: 2,
      healthCheck: { type: 'cli-version', command: ['codex', '--version'] },
      installPolicy: 'plan_only',
      updatePolicy: 'notify_only',
      binary: process.env.COMMAND_DECK_CODEX_BINARY || 'codex',
      allowedBinaries: normalizeStringArray([process.env.COMMAND_DECK_CODEX_BINARY || 'codex', 'codex']),
      officialSourcePolicy: 'openai/codex or @openai/codex only',
      secretRef: null,
      apiKeyEnv: null,
    },
    claude: {
      id: 'claude',
      displayName: 'Claude',
      kind: 'claude',
      enabled: true,
      roleCompatibility: [...ROLE_COMPATIBILITY],
      defaultModel: process.env.COMMAND_DECK_CLAUDE_MODEL || '',
      allowedModels: normalizeStringArray(process.env.COMMAND_DECK_CLAUDE_MODELS?.split(','), [], 32),
      defaultArgs: [],
      permissionsProfile: 'per-lane',
      mcpScopes: ['claude', 'all'],
      workdirRoots: [cwd],
      defaultWorkingDir: cwd,
      envWhitelist: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'SHELL', 'TERM'],
      maxConcurrentLanes: 2,
      healthCheck: { type: 'cli-version', command: ['claude', '--version'] },
      installPolicy: 'plan_only',
      updatePolicy: 'notify_only',
      binary: process.env.COMMAND_DECK_CLAUDE_BINARY || 'claude',
      allowedBinaries: normalizeStringArray([process.env.COMMAND_DECK_CLAUDE_BINARY || 'claude', 'claude']),
      officialSourcePolicy: 'anthropic/claude-code or @anthropic/claude-code only',
      secretRef: null,
      apiKeyEnv: null,
    },
    'gemini-cli': {
      id: 'gemini-cli',
      displayName: 'Gemini CLI',
      kind: 'cli',
      enabled: true,
      roleCompatibility: [...ROLE_COMPATIBILITY],
      defaultModel: process.env.COMMAND_DECK_GEMINI_CLI_MODEL || '',
      allowedModels: normalizeStringArray(process.env.COMMAND_DECK_GEMINI_CLI_MODELS?.split(','), [], 32),
      defaultArgs: normalizeStringArray((process.env.COMMAND_DECK_GEMINI_CLI_DEFAULT_ARGS || '').split(/\s+/), [], 64),
      permissionsProfile: 'per-lane',
      mcpScopes: ['gemini-cli', 'all'],
      workdirRoots: normalizeStringArray((process.env.COMMAND_DECK_GEMINI_CLI_WORKDIR_ROOTS || cwd).split(','), [cwd], 32),
      defaultWorkingDir: cwd,
      envWhitelist: normalizeStringArray((process.env.COMMAND_DECK_GEMINI_CLI_ENV_WHITELIST || 'PATH,HOME,TMPDIR,LANG,LC_ALL,LC_CTYPE,USER,SHELL,TERM').split(','), [], 64),
      maxConcurrentLanes: 2,
      healthCheck: { type: 'cli-version', command: [process.env.COMMAND_DECK_GEMINI_CLI_BINARY || 'gemini', '--version'] },
      installPolicy: 'plan_only',
      updatePolicy: 'notify_only',
      binary: process.env.COMMAND_DECK_GEMINI_CLI_BINARY || 'gemini',
      allowedBinaries: normalizeStringArray((process.env.COMMAND_DECK_GEMINI_CLI_ALLOWED_BINARIES || process.env.COMMAND_DECK_GEMINI_CLI_BINARY || 'gemini').split(','), ['gemini'], 32),
      officialSourcePolicy: 'google-gemini/gemini-cli or @google/gemini-cli only',
      secretRef: null,
      apiKeyEnv: null,
    },
    'composer-cli': {
      id: 'composer-cli',
      displayName: 'Composer CLI',
      kind: 'cli',
      enabled: true,
      roleCompatibility: [...ROLE_COMPATIBILITY],
      defaultModel: process.env.COMMAND_DECK_COMPOSER_CLI_MODEL || '',
      allowedModels: normalizeStringArray(process.env.COMMAND_DECK_COMPOSER_CLI_MODELS?.split(','), [], 32),
      defaultArgs: normalizeStringArray((process.env.COMMAND_DECK_COMPOSER_CLI_DEFAULT_ARGS || '').split(/\s+/), [], 64),
      permissionsProfile: 'per-lane',
      mcpScopes: ['composer-cli', 'all'],
      workdirRoots: normalizeStringArray((process.env.COMMAND_DECK_COMPOSER_CLI_WORKDIR_ROOTS || cwd).split(','), [cwd], 32),
      defaultWorkingDir: cwd,
      envWhitelist: normalizeStringArray((process.env.COMMAND_DECK_COMPOSER_CLI_ENV_WHITELIST || 'PATH,HOME,TMPDIR,LANG,LC_ALL,LC_CTYPE,USER,SHELL,TERM').split(','), [], 64),
      maxConcurrentLanes: 2,
      healthCheck: { type: 'cli-version', command: [process.env.COMMAND_DECK_COMPOSER_CLI_BINARY || 'cursor-agent', '--version'] },
      installPolicy: 'plan_only',
      updatePolicy: 'notify_only',
      binary: process.env.COMMAND_DECK_COMPOSER_CLI_BINARY || 'cursor-agent',
      allowedBinaries: normalizeStringArray((process.env.COMMAND_DECK_COMPOSER_CLI_ALLOWED_BINARIES || process.env.COMMAND_DECK_COMPOSER_CLI_BINARY || 'cursor-agent').split(','), ['cursor-agent'], 32),
      officialSourcePolicy: 'Cursor Agent CLI only; defaults to cursor-agent',
      secretRef: null,
      apiKeyEnv: null,
    },
    'custom-cli': {
      id: 'custom-cli',
      displayName: 'Custom CLI',
      kind: 'cli',
      enabled: Boolean(process.env.COMMAND_DECK_ENABLE_CUSTOM_CLI === 'true' || process.env.COMMAND_DECK_CLI_BINARY),
      roleCompatibility: [...ROLE_COMPATIBILITY],
      defaultModel: '',
      allowedModels: [],
      defaultArgs: normalizeStringArray((process.env.COMMAND_DECK_CLI_DEFAULT_ARGS || '').split(/\s+/), [], 64),
      permissionsProfile: 'restricted',
      mcpScopes: ['cli', 'all'],
      workdirRoots: normalizeStringArray((process.env.COMMAND_DECK_CLI_WORKDIR_ROOTS || cwd).split(','), [cwd], 32),
      defaultWorkingDir: cwd,
      envWhitelist: normalizeStringArray((process.env.COMMAND_DECK_CLI_ENV_WHITELIST || 'PATH,HOME,TMPDIR,LANG,LC_ALL,LC_CTYPE,USER,SHELL,TERM').split(','), [], 64),
      maxConcurrentLanes: 1,
      healthCheck: { type: 'cli-version', command: [process.env.COMMAND_DECK_CLI_BINARY || 'node', '--version'] },
      installPolicy: 'plan_only',
      updatePolicy: 'notify_only',
      binary: process.env.COMMAND_DECK_CLI_BINARY || 'node',
      allowedBinaries: normalizeStringArray((process.env.COMMAND_DECK_CLI_ALLOWED_BINARIES || process.env.COMMAND_DECK_CLI_BINARY || 'node').split(','), ['node'], 32),
      officialSourcePolicy: 'user-configured allowlist only',
      secretRef: null,
      apiKeyEnv: null,
    },
    'openai-compatible': apiProfile({
      id: 'openai-compatible',
      displayName: 'OpenAI-compatible API',
      baseUrl: 'https://api.openai.com/v1',
      apiStyle: 'openai-compatible',
      secretRef: 'provider:openai-compatible',
      apiKeyEnv: 'COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY',
    }),
    gemini: apiProfile({
      id: 'gemini',
      displayName: 'Gemini API',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiStyle: 'gemini',
      secretRef: 'provider:gemini',
      apiKeyEnv: 'COMMAND_DECK_GEMINI_API_KEY',
    }),
    kimi: apiProfile({
      id: 'kimi',
      displayName: 'Kimi API',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiStyle: 'openai-compatible',
      secretRef: 'provider:kimi',
      apiKeyEnv: 'COMMAND_DECK_KIMI_API_KEY',
    }),
    deepseek: apiProfile({
      id: 'deepseek',
      displayName: 'DeepSeek API',
      baseUrl: 'https://api.deepseek.com/v1',
      apiStyle: 'openai-compatible',
      secretRef: 'provider:deepseek',
      apiKeyEnv: 'COMMAND_DECK_DEEPSEEK_API_KEY',
    }),
    openrouter: apiProfile({
      id: 'openrouter',
      displayName: 'OpenRouter API',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiStyle: 'openai-compatible',
      secretRef: 'provider:openrouter',
      apiKeyEnv: 'COMMAND_DECK_OPENROUTER_API_KEY',
    }),
    composer: apiProfile({
      id: 'composer',
      displayName: 'Composer',
      baseUrl: 'http://127.0.0.1:3000',
      apiStyle: 'openai-compatible',
      secretRef: 'provider:composer',
      apiKeyEnv: 'COMMAND_DECK_COMPOSER_API_KEY',
      enabled: false,
    }),
  };
}

function isPlainRetryPolicy(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Number.isFinite(Number.parseInt(value.retries, 10))
    && Number.isFinite(Number.parseInt(value.backoffMs, 10));
}

function normalizeProfile(raw, existing = null) {
  ensurePlainObject(raw, 'profile');
  const id = safeSlug(raw.id || existing?.id);
  const kind = normalizeText(raw.kind || existing?.kind || 'api').toLowerCase();
  if (!PROVIDER_KINDS.has(kind)) throw { status: 422, message: `Unsupported provider kind "${kind}".` };
  const installPolicy = normalizeInstallPolicy(raw.installPolicy ?? existing?.installPolicy);
  const updatePolicy = normalizeUpdatePolicy(raw.updatePolicy ?? existing?.updatePolicy);
  if (installPolicy === 'managed' || updatePolicy === 'managed') {
    throw { status: 422, message: 'Managed install/update cannot be enabled by import or normal profile update.' };
  }
  const profile = {
    ...(existing || {}),
    ...raw,
    id,
    kind,
    displayName: normalizeText(raw.displayName ?? existing?.displayName ?? id).slice(0, 120),
    enabled: Boolean(raw.enabled ?? existing?.enabled ?? false),
    roleCompatibility: normalizeStringArray(raw.roleCompatibility ?? existing?.roleCompatibility, ROLE_COMPATIBILITY, 8)
      .filter((role) => ROLE_COMPATIBILITY.includes(role)),
    defaultModel: normalizeText(raw.defaultModel ?? existing?.defaultModel).slice(0, 120),
    allowedModels: normalizeStringArray(raw.allowedModels ?? existing?.allowedModels, [], 64),
    defaultArgs: normalizeStringArray(raw.defaultArgs ?? existing?.defaultArgs, [], 128),
    permissionsProfile: normalizeText(raw.permissionsProfile ?? existing?.permissionsProfile ?? 'restricted').slice(0, 80),
    mcpScopes: normalizeStringArray(raw.mcpScopes ?? existing?.mcpScopes, ['all'], 16),
    workdirRoots: normalizeStringArray(raw.workdirRoots ?? existing?.workdirRoots, [], 32),
    defaultWorkingDir: normalizeText(raw.defaultWorkingDir ?? existing?.defaultWorkingDir).slice(0, 2048),
    envWhitelist: normalizeStringArray(raw.envWhitelist ?? existing?.envWhitelist, [], 64),
    maxConcurrentLanes: Math.max(0, Math.min(32, Number.parseInt(raw.maxConcurrentLanes ?? existing?.maxConcurrentLanes ?? 1, 10) || 1)),
    installPolicy,
    updatePolicy,
    secretRef: normalizeSecretRef(raw.secretRef ?? existing?.secretRef, { allowBlank: true }),
    apiKeyEnv: normalizeEnvName(raw.apiKeyEnv ?? existing?.apiKeyEnv, { allowBlank: true }),
    updatedAt: nowIso(),
    createdAt: existing?.createdAt || nowIso(),
  };

  if (kind === 'api') {
    profile.baseUrl = validateBaseUrl(raw.baseUrl ?? existing?.baseUrl, { allowBlank: false });
    const style = normalizeText(raw.apiStyle ?? existing?.apiStyle ?? 'openai-compatible').toLowerCase();
    profile.apiStyle = API_STYLES.has(style) ? style : 'openai-compatible';
    profile.timeoutMs = Math.max(1000, Math.min(180000, Number.parseInt(raw.timeoutMs ?? existing?.timeoutMs ?? 30000, 10) || 30000));
    profile.retryPolicy = isPlainRetryPolicy(raw.retryPolicy ?? existing?.retryPolicy)
      ? raw.retryPolicy ?? existing?.retryPolicy
      : { retries: 1, backoffMs: 500 };
    profile.streaming = Boolean(raw.streaming ?? existing?.streaming ?? true);
    profile.requestTemplate = normalizeText(raw.requestTemplate ?? existing?.requestTemplate ?? 'chat-completions-compatible').slice(0, 120);
    profile.responseParser = normalizeText(raw.responseParser ?? existing?.responseParser ?? 'chat-completions-compatible').slice(0, 120);
    profile.redactionPolicy = normalizeText(raw.redactionPolicy ?? existing?.redactionPolicy ?? 'redact-authorization-and-body-secrets').slice(0, 120);
  }

  if (['codex', 'claude', 'cli'].includes(kind)) {
    profile.binary = validateBinary(raw.binary ?? existing?.binary ?? id, { allowBlank: false });
    profile.allowedBinaries = normalizeStringArray(raw.allowedBinaries ?? existing?.allowedBinaries, [profile.binary], 32).map((value) => validateBinary(value));
    profile.healthCheck = raw.healthCheck ?? existing?.healthCheck ?? { type: 'cli-version', command: [profile.binary, '--version'] };
  }

  return profile;
}

class CredentialStore {
  constructor({
    backend = process.env.COMMAND_DECK_CREDENTIAL_BACKEND || 'auto',
    runner = spawnSync,
    platform = process.platform,
    env = process.env,
    service = SECRET_SERVICE,
  } = {}) {
    this.backend = CREDENTIAL_BACKENDS.has(backend) ? backend : 'auto';
    this.runner = runner;
    this.platform = platform;
    this.env = env;
    this.service = service;
    this.memory = new Map();
  }

  activeBackend() {
    if (this.backend === 'memory') return 'memory';
    if (this.backend === 'env') return 'env';
    if (this.backend === 'macos-keychain') return 'macos-keychain';
    if (this.backend === 'windows-credential-manager') return 'windows-credential-manager';
    if (this.backend === 'linux-secret-service') return 'linux-secret-service';
    if (this.backend === 'auto' && this.platform === 'darwin') return 'macos-keychain';
    return 'env';
  }

  backendStatuses() {
    const active = this.activeBackend();
    return [
      {
        id: 'memory',
        active: active === 'memory',
        available: true,
        writable: active === 'memory',
        persistence: 'process-memory',
        status: active === 'memory' ? 'active' : 'available_for_tests',
        blockedReason: null,
      },
      {
        id: 'env',
        active: active === 'env',
        available: true,
        writable: false,
        persistence: 'environment',
        status: active === 'env' ? 'active_fallback' : 'fallback_available',
        blockedReason: 'Environment variables are read-only from Command Deck and are never written by dashboard secret entry.',
      },
      {
        id: 'macos-keychain',
        active: active === 'macos-keychain',
        available: this.platform === 'darwin',
        writable: this.platform === 'darwin',
        persistence: 'os-credential-store',
        status: this.platform === 'darwin' ? (active === 'macos-keychain' ? 'active' : 'available') : 'blocked_on_this_host',
        blockedReason: this.platform === 'darwin' ? null : 'macOS Keychain is available only on darwin hosts.',
      },
      {
        id: 'windows-credential-manager',
        active: active === 'windows-credential-manager',
        available: false,
        writable: false,
        persistence: 'os-credential-store',
        status: this.platform === 'win32' ? 'blocked_adapter_not_implemented' : 'blocked_on_this_host',
        blockedReason: 'Windows Credential Manager adapter is not implemented in this Node runtime; use env fallback or a future OS adapter.',
      },
      {
        id: 'linux-secret-service',
        active: active === 'linux-secret-service',
        available: false,
        writable: false,
        persistence: 'os-credential-store',
        status: this.platform === 'linux' ? 'blocked_adapter_not_implemented' : 'blocked_on_this_host',
        blockedReason: 'Linux Secret Service/libsecret adapter is not implemented in this Node runtime; use env fallback or a future OS adapter.',
      },
    ];
  }

  runMacosSecurity(args, { timeout = 4000 } = {}) {
    const result = this.runner('security', args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }) || {};
    return {
      status: Number.isInteger(result.status) ? result.status : null,
      stdout: String(result.stdout || ''),
      errorCode: result.error?.code || null,
    };
  }

  async describe(ref, envName = null) {
    const normalizedRef = ref ? normalizeSecretRef(ref, { allowBlank: false }) : null;
    const normalizedEnv = envName ? normalizeEnvName(envName, { allowBlank: false }) : null;
    const envPresent = normalizedEnv ? typeof this.env[normalizedEnv] === 'string' && this.env[normalizedEnv].length > 0 : false;
    const backend = this.activeBackend();
    if (backend === 'memory') {
      return {
        present: Boolean(normalizedRef && this.memory.has(normalizedRef)) || envPresent,
        backend: normalizedRef && this.memory.has(normalizedRef) ? 'memory' : (envPresent ? 'env' : 'memory'),
        ref: normalizedRef,
        envName: normalizedEnv,
        envFallbackPresent: envPresent,
      };
    }
    if (backend === 'macos-keychain' && normalizedRef) {
      const result = this.runMacosSecurity(['find-generic-password', '-s', this.service, '-a', normalizedRef], { timeout: 2000 });
      if (result.status === 0) {
        return { present: true, backend: 'macos-keychain', ref: normalizedRef, envName: normalizedEnv, envFallbackPresent: envPresent };
      }
    }
    return {
      present: envPresent,
      backend: envPresent ? 'env' : backend,
      ref: normalizedRef,
      envName: normalizedEnv,
      envFallbackPresent: envPresent,
    };
  }

  async get(ref, envName = null) {
    const normalizedRef = ref ? normalizeSecretRef(ref, { allowBlank: false }) : null;
    const normalizedEnv = envName ? normalizeEnvName(envName, { allowBlank: false }) : null;
    const backend = this.activeBackend();
    if (backend === 'memory' && this.memory.has(normalizedRef)) return this.memory.get(normalizedRef);
    if (backend === 'macos-keychain' && normalizedRef) {
      const result = this.runMacosSecurity(['find-generic-password', '-s', this.service, '-a', normalizedRef, '-w'], { timeout: 2000 });
      if (result.status === 0 && result.stdout) return String(result.stdout).trim();
    }
    if (normalizedEnv && typeof this.env[normalizedEnv] === 'string') return this.env[normalizedEnv];
    return null;
  }

  async has(ref, envName = null) {
    const description = await this.describe(ref, envName);
    return Boolean(description.present);
  }

  async set(ref, value) {
    const normalizedRef = normalizeSecretRef(ref, { allowBlank: false });
    const secret = String(value || '');
    if (!secret) throw { status: 422, message: 'Secret value is required.' };
    const backend = this.activeBackend();
    if (backend === 'memory') {
      this.memory.set(normalizedRef, secret);
      return this.describe(normalizedRef);
    }
    if (backend === 'macos-keychain') {
      const result = this.runMacosSecurity(['add-generic-password', '-U', '-s', this.service, '-a', normalizedRef, '-w', secret], { timeout: 4000 });
      if (result.status !== 0) throw { status: 500, message: 'Could not store secret in macOS Keychain.' };
      return this.describe(normalizedRef);
    }
    throw { status: 409, message: 'No writable OS credential backend is available. Configure an env var fallback or enable a supported credential backend.' };
  }

  async delete(ref) {
    const normalizedRef = normalizeSecretRef(ref, { allowBlank: false });
    const backend = this.activeBackend();
    if (backend === 'memory') {
      this.memory.delete(normalizedRef);
      return { deleted: true, backend: 'memory', ref: normalizedRef };
    }
    if (backend === 'macos-keychain') {
      const result = this.runMacosSecurity(['delete-generic-password', '-s', this.service, '-a', normalizedRef], { timeout: 4000 });
      return {
        deleted: result.status === 0,
        backend: 'macos-keychain',
        ref: normalizedRef,
        status: result.status === 0 ? 'deleted' : 'not_found_or_unavailable',
      };
    }
    return { deleted: false, backend, ref: normalizedRef, status: 'not_writable' };
  }
}

class ProviderProfileStore {
  constructor({ stateFile = null, credentialStore = null } = {}) {
    this.stateFile = stateFile || path.join(process.cwd(), '.command-deck', 'providers.json');
    this.credentialStore = credentialStore || new CredentialStore();
    this.loaded = false;
    this.loadStatus = null;
    this.state = {
      schemaVersion: 1,
      profiles: defaultProfiles(),
      auditEvents: [],
    };
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const fallback = {
      schemaVersion: 1,
      profiles: defaultProfiles(),
      auditEvents: [],
    };
    try {
      const recovered = await readJsonFileWithRecovery(this.stateFile, { fallback });
      this.loadStatus = recovered.status;
      const parsed = recovered.data || fallback;
      const shouldAuditRecovery = this.loadStatus?.recovered || this.loadStatus?.ok === false;
      const seeded = defaultProfiles();
      const loaded = parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {};
      const profiles = { ...seeded };
      for (const [id, raw] of Object.entries(loaded)) {
        const base = profiles[id] || null;
        profiles[id] = normalizeProfile({ ...base, ...raw, id: raw.id || id }, base);
      }
      this.state = {
        schemaVersion: 1,
        profiles,
        auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents.slice(0, 200) : [],
      };
      if (shouldAuditRecovery) {
        this.recordAudit({
          type: 'provider_state_recovered',
          actor: 'system',
          summary: `Provider profile state loaded from ${this.loadStatus.source}`,
          status: this.loadStatus.ok ? 'passed' : 'failed',
          evidence: {
            source: this.loadStatus.source,
            recovered: this.loadStatus.recovered,
            filePath: this.loadStatus.filePath,
            backupPath: this.loadStatus.backupPath,
            corruptPath: this.loadStatus.corruptPath,
            reason: this.loadStatus.reason,
            backupReason: this.loadStatus.backupReason,
          },
        });
        await this.persist();
      }
    } catch {
      this.state = fallback;
    }
  }

  async persist() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeJsonFileAtomic(this.stateFile, { ...this.state, savedAt: nowIso() });
  }

  recordAudit(event) {
    this.state.auditEvents.unshift({ id: randomUUID(), createdAt: nowIso(), ...event });
    this.state.auditEvents = this.state.auditEvents.slice(0, 200);
  }

  async listProfiles() {
    await this.ensureLoaded();
    const profiles = await Promise.all(Object.values(this.state.profiles).map(async (profile) => ({
      ...clone(profile),
      credential: await this.credentialStore.describe(profile.secretRef, profile.apiKeyEnv),
    })));
    profiles.sort((a, b) => {
      const ai = PROVIDER_IDS.indexOf(a.id);
      const bi = PROVIDER_IDS.indexOf(b.id);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.id.localeCompare(b.id);
    });
    return {
      schemaVersion: 1,
      generatedAt: nowIso(),
      credentialBackend: this.credentialStore.activeBackend(),
      credentialBackends: this.credentialStore.backendStatuses(),
      loadStatus: this.loadStatus ? clone(this.loadStatus) : null,
      profiles,
    };
  }

  async getProfile(id) {
    await this.ensureLoaded();
    const profile = this.state.profiles[safeSlug(id)];
    if (!profile) throw { status: 404, message: 'Provider profile not found.' };
    return clone(profile);
  }

  async updateProfile(id, raw, { actor = 'dashboard', approved = false } = {}) {
    await this.ensureLoaded();
    if (!approved) throw { status: 409, message: 'Provider profile changes require explicit approval.', requiresApproval: true, risk: 'high' };
    const profileId = safeSlug(id);
    const existing = this.state.profiles[profileId] || { id: profileId };
    const normalized = normalizeProfile({ ...existing, ...raw, id: profileId }, existing);
    this.state.profiles[profileId] = normalized;
    this.recordAudit({
      type: 'provider_profile_updated',
      actor,
      summary: `Provider profile ${profileId} updated`,
      status: 'passed',
      evidence: { providerId: profileId, enabled: normalized.enabled, kind: normalized.kind },
    });
    await this.persist();
    return clone(normalized);
  }

  async health(id) {
    const profile = await this.getProfile(id);
    if (['codex', 'claude', 'cli'].includes(profile.kind)) {
      const binary = profile.binary || profile.id;
      const result = spawnSync(binary, ['--version'], {
        encoding: 'utf8',
        timeout: 2500,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      return {
        providerId: profile.id,
        kind: profile.kind,
        status: result.status === 0 ? 'ready' : (profile.enabled ? 'blocked' : 'disabled'),
        enabled: profile.enabled,
        binary,
        version: result.status === 0 ? String(result.stdout || result.stderr || '').trim() : null,
        exitCode: result.status,
        errorCode: result.error?.code || null,
        installPolicy: profile.installPolicy,
        updatePolicy: profile.updatePolicy,
        dryRunOnly: true,
      };
    }
    const credential = await this.credentialStore.describe(profile.secretRef, profile.apiKeyEnv);
    return {
      providerId: profile.id,
      kind: profile.kind,
      status: credential.present ? 'configured' : (profile.enabled ? 'missing_secret' : 'disabled'),
      enabled: profile.enabled,
      baseUrl: profile.baseUrl,
      apiStyle: profile.apiStyle,
      credential,
      installPolicy: profile.installPolicy,
      updatePolicy: profile.updatePolicy,
      networkProbe: 'not-run-by-default',
    };
  }

  async setSecret(id, value, { actor = 'dashboard', approved = false } = {}) {
    await this.ensureLoaded();
    if (!approved) throw { status: 409, message: 'Secret writes require explicit approval.', requiresApproval: true, risk: 'high' };
    const profile = await this.getProfile(id);
    if (!profile.secretRef) throw { status: 422, message: 'Provider profile has no secretRef.' };
    const credential = await this.credentialStore.set(profile.secretRef, value);
    this.recordAudit({
      type: 'provider_secret_set',
      actor,
      summary: `Secret stored for provider ${profile.id}`,
      status: 'passed',
      evidence: { providerId: profile.id, secretRef: profile.secretRef, backend: credential.backend },
    });
    await this.persist();
    return { providerId: profile.id, credential };
  }

  async deleteSecret(id, { actor = 'dashboard', approved = false } = {}) {
    await this.ensureLoaded();
    if (!approved) throw { status: 409, message: 'Secret deletion requires explicit approval.', requiresApproval: true, risk: 'high' };
    const profile = await this.getProfile(id);
    if (!profile.secretRef) throw { status: 422, message: 'Provider profile has no secretRef.' };
    const credential = await this.credentialStore.delete(profile.secretRef);
    this.recordAudit({
      type: 'provider_secret_deleted',
      actor,
      summary: `Secret deleted for provider ${profile.id}`,
      status: 'passed',
      evidence: { providerId: profile.id, secretRef: profile.secretRef, backend: credential.backend },
    });
    await this.persist();
    return {
      providerId: profile.id,
      credential,
      fallback: profile.apiKeyEnv ? await this.credentialStore.describe(profile.secretRef, profile.apiKeyEnv) : null,
    };
  }

  async exportProfiles() {
    await this.ensureLoaded();
    return {
      schemaVersion: 1,
      exportedAt: nowIso(),
      profiles: Object.values(this.state.profiles).map((profile) => clone(profile)),
      excludesSecrets: true,
    };
  }

  validateImport(payload) {
    ensurePlainObject(payload, 'import');
    if (payload.schemaVersion !== 1) throw { status: 422, message: 'Unsupported provider import schemaVersion.' };
    if (!Array.isArray(payload.profiles)) throw { status: 422, message: 'Provider import requires a profiles array.' };
    const accepted = [];
    const errors = [];
    for (const raw of payload.profiles) {
      try {
        ensurePlainObject(raw, 'profile');
        if (raw.secretValue || raw.apiKey || raw.token) throw { status: 422, message: 'Provider imports must not include secret values.' };
        const id = safeSlug(raw.id);
        accepted.push(normalizeProfile(raw, this.state.profiles[id] || null));
      } catch (error) {
        errors.push(error.message || 'Invalid provider profile.');
      }
    }
    return {
      acceptedCount: accepted.length,
      errorCount: errors.length,
      errors,
      profiles: accepted.map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        kind: profile.kind,
        enabled: profile.enabled,
        secretRef: profile.secretRef,
        apiKeyEnv: profile.apiKeyEnv,
      })),
      dryRun: true,
    };
  }

  async importDryRun(payload) {
    await this.ensureLoaded();
    return this.validateImport(payload);
  }

  async importApply(payload, { actor = 'dashboard', approved = false } = {}) {
    await this.ensureLoaded();
    if (!approved) throw { status: 409, message: 'Provider import requires explicit approval.', requiresApproval: true, risk: 'high' };
    const dryRun = this.validateImport(payload);
    if (dryRun.errorCount > 0) throw { status: 422, message: 'Provider import contains invalid profiles.', errors: dryRun.errors };
    for (const profileSummary of dryRun.profiles) {
      const raw = payload.profiles.find((item) => safeSlug(item.id) === profileSummary.id);
      this.state.profiles[profileSummary.id] = normalizeProfile(raw, this.state.profiles[profileSummary.id] || null);
    }
    this.recordAudit({
      type: 'provider_profiles_imported',
      actor,
      summary: `Imported ${dryRun.acceptedCount} provider profile(s)`,
      status: 'passed',
      evidence: { acceptedCount: dryRun.acceptedCount },
    });
    await this.persist();
    return { ...dryRun, dryRun: false };
  }
}

export {
  CredentialStore,
  ProviderProfileStore,
  PROVIDER_IDS,
  defaultProfiles,
  normalizeProfile,
};
