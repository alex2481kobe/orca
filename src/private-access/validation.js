// Private-access validation, normalization, and URL/settings helpers.
// Extracted from private-access.js.

import { randomUUID } from 'node:crypto';
import { validateNetworkUrl } from '../url-policy.js';

export const nowIso = () => new Date().toISOString();

export const ACCESS_MODES = new Set(['auto', 'local', 'tailnet-http', 'tailnet-https-serve']);
export const TARGET_ACCESS_MODES = new Set(['local', 'tailnet-http', 'tailnet-https-serve']);
export const SETUP_STATES = new Set([
  'not_configured',
  'setup_pending',
  'configured_unchecked',
  'reachable',
  'unreachable',
  'external_verification_required',
]);
export const MAX_PRIVATE_ACCESS_TARGETS = 100;

export const DEFAULT_SETTINGS = {
  preferredMode: 'auto',
  openTarget: 'external',
  pwaMode: 'enabled',
  notificationMode: 'in_app',
  tailscaleCommandBehavior: 'dry_run_only',
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
  const allowedModes = allowAuto ? ACCESS_MODES : TARGET_ACCESS_MODES;
  if (containsFunnel(mode) || !allowedModes.has(mode)) {
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
  if (raw.openTarget !== undefined) {
    const value = normalizeText(raw.openTarget).toLowerCase();
    settings.openTarget = ['external', 'in_app'].includes(value) ? value : DEFAULT_SETTINGS.openTarget;
  }
  if (raw.pwaMode !== undefined) {
    const value = normalizeText(raw.pwaMode).toLowerCase();
    settings.pwaMode = ['enabled', 'disabled'].includes(value) ? value : DEFAULT_SETTINGS.pwaMode;
  }
  if (raw.notificationMode !== undefined) {
    const value = normalizeText(raw.notificationMode).toLowerCase();
    settings.notificationMode = ['off', 'in_app', 'browser'].includes(value) ? value : DEFAULT_SETTINGS.notificationMode;
  }
  if (raw.tailscaleCommandBehavior !== undefined) {
    const value = normalizeText(raw.tailscaleCommandBehavior).toLowerCase();
    settings.tailscaleCommandBehavior = ['dry_run_only', 'approval_required'].includes(value)
      ? value
      : DEFAULT_SETTINGS.tailscaleCommandBehavior;
  }
  if (raw.setupStatus !== undefined) {
    settings.setupStatus = normalizeSetupStatus(raw.setupStatus, DEFAULT_SETTINGS.setupStatus);
  }
  return settings;
}

export function normalizeTarget(raw = {}, existing = null) {
  rejectPrototypeKeys(raw, 'target');
  const id = normalizeText(existing?.id || raw.id || randomUUID());
  const label = normalizeText(raw.label || existing?.label || 'Local dev server').slice(0, 100);
  const mode = normalizeMode(raw.mode || existing?.mode || 'local');
  const localUrl = validateAccessUrl(raw.localUrl ?? existing?.localUrl, { mode: 'local', field: 'localUrl' });
  const tailnetHttpUrl = validateAccessUrl(raw.tailnetHttpUrl ?? existing?.tailnetHttpUrl, {
    mode: 'tailnet-http',
    allowBlank: true,
    field: 'tailnetHttpUrl',
  });
  const httpsServeUrl = validateAccessUrl(raw.httpsServeUrl ?? existing?.httpsServeUrl, {
    mode: 'tailnet-https-serve',
    allowBlank: true,
    field: 'httpsServeUrl',
  });
  if (mode === 'tailnet-http' && !tailnetHttpUrl) {
    throw { status: 422, message: 'tailnet-http targets require tailnetHttpUrl.' };
  }
  if (mode === 'tailnet-https-serve' && !httpsServeUrl) {
    throw { status: 422, message: 'tailnet-https-serve targets require httpsServeUrl.' };
  }
  const preferredOpenTarget = normalizeText(raw.preferredOpenTarget || existing?.preferredOpenTarget || 'external').toLowerCase();
  const type = normalizeText(raw.type || existing?.type || 'app').slice(0, 40);
  const group = normalizeText(raw.group || existing?.group || '').slice(0, 80);
  const notes = normalizeText(raw.notes || existing?.notes || '').slice(0, 500);
  const evidencePreset = normalizeText(raw.evidencePreset || existing?.evidencePreset || 'screenshot').slice(0, 40);

  return {
    id,
    label,
    type,
    group,
    mode,
    localUrl,
    tailnetHttpUrl,
    httpsServeUrl,
    preferredOpenTarget: ['external', 'in_app'].includes(preferredOpenTarget) ? preferredOpenTarget : 'external',
    favorite: Boolean(raw.favorite ?? existing?.favorite ?? false),
    hidden: Boolean(raw.hidden ?? existing?.hidden ?? false),
    healthStatus: existing?.healthStatus || 'configured_unchecked',
    lastCheckedAt: existing?.lastCheckedAt || null,
    lastHealthDetail: existing?.lastHealthDetail || null,
    evidencePreset,
    notes,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

export function targetUrlForMode(target) {
  if (!target) return null;
  if (target.mode === 'tailnet-https-serve') return target.httpsServeUrl || null;
  if (target.mode === 'tailnet-http') return target.tailnetHttpUrl || null;
  return target.localUrl;
}

export function commandText(command) {
  return command.map((part) => String(part)).join(' ');
}
