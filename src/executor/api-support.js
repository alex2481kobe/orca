// API-provider request/profile helpers + log redaction. Extracted from
// executor-factory.js.

import { API_PROVIDER_TYPES, API_RESPONSE_BYTES, CONTROL_CHAR_RE } from './constants.js';
import { CredentialStore, defaultProfiles } from '../provider-profiles.js';

export function parseEnv(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const output = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    if (CONTROL_CHAR_RE.test(key) || CONTROL_CHAR_RE.test(String(value))) continue;
    output[key.trim()] = String(value);
  }
  return output;
}

export function parsePositiveInteger(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

export function providerEnvPrefix(providerId) {
  return String(providerId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function isApiProviderType(type) {
  return API_PROVIDER_TYPES.includes(String(type || '').toLowerCase());
}

export function redactedText(value, secrets = []) {
  let out = String(value ?? '');
  for (const secret of secrets) {
    const text = String(secret || '');
    if (!text) continue;
    out = out.split(text).join('[REDACTED]');
  }
  return out;
}

export function trimForLog(value, max = 4000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

export function buildOpenAiCompatibleBody(lane, profile) {
  const prompt = String(lane.taskPrompt || lane.taskDescription || lane.title || 'Run Orca lane.').trim().slice(0, 8000);
  const model = String(lane.model || profile.defaultModel || process.env[`ORCA_${providerEnvPrefix(profile.id)}_MODEL`] || 'orca-default').trim();
  return {
    model,
    messages: [
      {
        role: 'system',
        content: 'You are an API provider lane running inside Orca. Return concise progress or completion output.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    stream: false,
  };
}

export function modelForProfile(lane, profile) {
  return String(lane.model || profile.defaultModel || process.env[`ORCA_${providerEnvPrefix(profile.id)}_MODEL`] || 'orca-default').trim();
}

export function safeGeminiModel(lane, profile) {
  const raw = String(lane.model || profile.defaultModel || process.env[`ORCA_${providerEnvPrefix(profile.id)}_MODEL`] || 'gemini-1.5-flash').trim();
  const withoutPrefix = raw.replace(/^models\//, '').trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(withoutPrefix)) {
    throw new Error('Gemini model contains unsupported characters.');
  }
  return withoutPrefix;
}

export function buildGeminiBody(lane) {
  const prompt = String(lane.taskPrompt || lane.taskDescription || lane.title || 'Run Orca lane.').trim().slice(0, 8000);
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
    },
  };
}

export function buildApiRequestBody(lane, profile) {
  if (profile.apiStyle === 'gemini') return buildGeminiBody(lane, profile);
  return buildOpenAiCompatibleBody(lane, profile);
}

export function apiEndpointForProfile(profile) {
  const baseUrl = String(profile.baseUrl || '').replace(/\/+$/, '');
  if (profile.apiStyle === 'openai-compatible') return `${baseUrl}/chat/completions`;
  if (profile.apiStyle === 'gemini') return `${baseUrl}/models/${safeGeminiModel({}, profile)}:generateContent`;
  return null;
}

export function getApiProviderProfile(type) {
  const requested = String(type || '').toLowerCase().trim();
  const providerId = requested === 'api' ? 'openai-compatible' : requested;
  const seeded = defaultProfiles()[providerId];
  if (!seeded || seeded.kind !== 'api') return null;
  return applyApiProviderEnvOverrides({ ...seeded, type: requested, id: providerId }, requested);
}

export function applyApiProviderEnvOverrides(profile, requestedType = profile?.type || profile?.id) {
  if (!profile || profile.kind !== 'api') return null;
  const providerId = profile.id;
  const prefix = providerEnvPrefix(providerId);
  const baseUrl = process.env[`ORCA_${prefix}_BASE_URL`] || profile.baseUrl;
  const apiKeyEnv = process.env[`ORCA_${prefix}_API_KEY_ENV`] || profile.apiKeyEnv || `ORCA_${prefix}_API_KEY`;
  return {
    ...profile,
    type: requestedType,
    id: providerId,
    baseUrl,
    apiKeyEnv,
    timeoutMs: parsePositiveInteger(process.env[`ORCA_${prefix}_TIMEOUT_MS`], profile.timeoutMs || 30000, { min: 1000, max: 180000 }),
    maxResponseBytes: parsePositiveInteger(process.env[`ORCA_${prefix}_MAX_RESPONSE_BYTES`], API_RESPONSE_BYTES, { min: 1024, max: 2 * 1024 * 1024 }),
    defaultModel: process.env[`ORCA_${prefix}_MODEL`] || profile.defaultModel || '',
  };
}

export function getApiProviderExecutorTypes() {
  return API_PROVIDER_TYPES.filter((type) => Boolean(getApiProviderProfile(type)));
}
