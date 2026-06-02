// Provider-profile field validation/normalization. Extracted from
// provider-profiles.js.

import { validateNetworkUrl } from '../url-policy.js';
import {
  nowIso,
  PROVIDER_KINDS,
  INSTALL_POLICIES,
  UPDATE_POLICIES,
  API_STYLES,
  ROLE_COMPATIBILITY,
} from './constants.js';

export function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

export function ensurePlainObject(value, label = 'payload') {
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

export function safeSlug(value) {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!slug) throw { status: 422, message: 'Provider id is required.' };
  return slug;
}

export function normalizeStringArray(raw, fallback = [], maxItems = 32) {
  const input = Array.isArray(raw) ? raw : fallback;
  return input
    .map((value) => normalizeText(value).slice(0, 240))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, maxItems);
}

export function normalizeEnvName(raw, { allowBlank = false } = {}) {
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

export function normalizeSecretRef(raw, { allowBlank = false } = {}) {
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

export function validateBaseUrl(raw, { allowBlank = false } = {}) {
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

export function validateBinary(raw, { allowBlank = false } = {}) {
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

export function normalizeInstallPolicy(raw, fallback = 'plan_only') {
  const value = normalizeText(raw || fallback).toLowerCase();
  return INSTALL_POLICIES.has(value) ? value : fallback;
}

export function normalizeUpdatePolicy(raw, fallback = 'notify_only') {
  const value = normalizeText(raw || fallback).toLowerCase();
  return UPDATE_POLICIES.has(value) ? value : fallback;
}

export function isPlainRetryPolicy(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Number.isFinite(Number.parseInt(value.retries, 10))
    && Number.isFinite(Number.parseInt(value.backoffMs, 10));
}

export function normalizeProfile(raw, existing = null) {
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
