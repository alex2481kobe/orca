// Private-access validation, normalization, and URL/settings helpers.
//

import { validateNetworkUrl } from '../url-policy.js';

export const nowIso = () => new Date().toISOString();

export const ACCESS_MODES = new Set(['auto', 'local', 'tailnet-http', 'tailnet-https-serve']);
export const SETUP_STATES = new Set([
  'not_configured',
  'setup_pending',
  'configured_unchecked',
  'reachable',
  'unreachable',
  'external_verification_required',
]);

export const DEFAULT_SETTINGS = {
  preferredMode: 'auto',
  setupStatus: 'not_configured',
};

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

export function normalizePort(value, fallback = 3000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return parsed;
}

export function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function containsFunnel(value) {
  return String(value || '').toLowerCase().includes('funnel');
}

export function rejectPrototypeKeys(value, pathLabel = 'body') {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw { status: 422, message: `${pathLabel} contains unsafe key "${key}".` };
    }
    if (isPlainObject(value[key])) rejectPrototypeKeys(value[key], `${pathLabel}.${key}`);
  }
}

export function validateAccessUrl(raw, { mode = 'local', allowBlank = false, field = 'url' } = {}) {
  const text = normalizeText(raw);
  if (!text) {
    if (allowBlank) return null;
    throw { status: 422, message: `${field} is required.` };
  }
  if (text.length > 2048) {
    throw { status: 422, message: `${field} is too long.` };
  }
  if (containsFunnel(text)) {
    throw { status: 422, message: 'Tailscale Funnel is not supported — Orca only uses private tailnet Serve.' };
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw { status: 422, message: `${field} must be a valid absolute URL.` };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw { status: 422, message: `${field} must use http or https.` };
  }
  if (parsed.username || parsed.password) {
    throw { status: 422, message: `${field} must not include credentials.` };
  }
  if (!parsed.hostname || parsed.hostname.length > 253) {
    throw { status: 422, message: `${field} has an invalid host.` };
  }
  if (mode === 'local') {
    return validateNetworkUrl(text, {
      field,
      allowedHosts: ['loopback'],
      requireProtocol: parsed.protocol,
    }).url;
  }
  if (mode === 'tailnet-http' && parsed.protocol !== 'http:') {
    throw { status: 422, message: 'tailnet-http targets must use http.' };
  }
  if (mode === 'tailnet-https-serve' && parsed.protocol !== 'https:') {
    throw { status: 422, message: 'tailnet-https-serve targets must use https.' };
  }
  if (mode === 'tailnet-http' || mode === 'tailnet-https-serve') {
    return validateNetworkUrl(text, {
      field,
      allowedHosts: ['tailnet'],
      requireProtocol: parsed.protocol,
    }).url;
  }
  return validateNetworkUrl(text, { field }).url;
}

export function normalizeMode(raw, { allowAuto = false } = {}) {
  const mode = normalizeText(raw || (allowAuto ? 'auto' : 'local')).toLowerCase();
  if (containsFunnel(mode) || !ACCESS_MODES.has(mode) || (!allowAuto && mode === 'auto')) {
    throw { status: 422, message: 'Unsupported private access mode.' };
  }
  return mode;
}

export function normalizeSetupStatus(raw, fallback = 'not_configured') {
  const status = normalizeText(raw || fallback).toLowerCase();
  return SETUP_STATES.has(status) ? status : fallback;
}

export function normalizeSettings(raw = {}) {
  rejectPrototypeKeys(raw, 'settings');
  const settings = { ...DEFAULT_SETTINGS };
  if (raw.preferredMode !== undefined) settings.preferredMode = normalizeMode(raw.preferredMode, { allowAuto: true });
  if (raw.setupStatus !== undefined) {
    settings.setupStatus = normalizeSetupStatus(raw.setupStatus, DEFAULT_SETTINGS.setupStatus);
  }
  return settings;
}

export function commandText(command) {
  return command.map((part) => String(part)).join(' ');
}
