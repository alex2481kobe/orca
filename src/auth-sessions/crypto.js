// Pure crypto/encoding helpers for browser auth sessions. Extracted from
// auth-sessions.js. CSPRNG tokens, constant-time hash compare, cookie parsing.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'orca_session';
export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const nowIso = () => new Date().toISOString();

export function hashSecret(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

// Constant-time equality for two same-format hex hashes.
export function hashesEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function parsePositiveMs(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function safeLabel(value, fallback = '') {
  return String(value || fallback).trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
}

export function generatePairingCode() {
  const raw = randomBytes(6).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function generateSessionToken() {
  return `${randomUUID()}-${randomBytes(24).toString('base64url')}`;
}

export function parseCookies(cookieHeader) {
  const out = {};
  String(cookieHeader || '').split(';').forEach((part) => {
    const [rawKey, ...rawValue] = part.split('=');
    const key = rawKey?.trim();
    if (!key) return;
    const raw = rawValue.join('=').trim();
    // A malformed percent-encoding (e.g. "%ZZ") must not throw on an
    // attacker-controlled cookie header.
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  });
  return out;
}
