// Single source of truth for the remote client's known workstation URLs and which
// one it is currently connected to. Previously this logic was duplicated (and
// slightly inconsistent) across app.js (deep link), the connectWorkstation handler,
// and the connect/pair render functions — which let case-only variants ("http://X"
// vs "HTTP://X") slip in as duplicate "recent workstations". Centralizing it makes
// normalization + dedup + active-detection consistent everywhere.

import { isLocalHostName } from './dom.js';

const STORAGE_KEY = 'orca.workstations';
const PENDING_KEY = 'orca.pendingWorkstation';
const MAX_RECENTS = 6;

// Canonical form of a workstation URL: lowercase scheme + host (so case-only
// variants collapse), default scheme http://, no trailing slash, no fragment.
// Returns '' for empty/garbage input.
export function normalizeWorkstationUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^[a-z]+:\/\//i.test(value)) value = `http://${value}`;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    let out = u.toString();
    out = out.replace(/\/+$/, '');
    return out;
  } catch {
    return '';
  }
}

// A short, human label for a workstation URL — just the host (and port), dropping
// the scheme so the list reads cleanly. Falls back to the raw value.
export function workstationLabel(url) {
  const norm = normalizeWorkstationUrl(url) || String(url || '');
  try {
    return new URL(norm).host || norm;
  } catch {
    return norm.replace(/^https?:\/\//i, '');
  }
}

// The normalized, de-duplicated list of recently used workstation URLs, newest
// first. De-dup is by canonical form, so "http://X" and "HTTP://X" are one entry.
export function readWorkstations() {
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { raw = []; }
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const norm = normalizeWorkstationUrl(entry);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.slice(0, MAX_RECENTS);
}

// Record a workstation as most-recent (normalized + de-duped). Returns the list.
export function rememberWorkstation(url) {
  const norm = normalizeWorkstationUrl(url);
  if (!norm) return readWorkstations();
  const prior = readWorkstations().filter((entry) => entry !== norm);
  const next = [norm, ...prior].slice(0, MAX_RECENTS);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* unavailable */ }
  return next;
}

// Drop a workstation from the recent list. Returns the remaining list.
export function forgetWorkstation(url) {
  const norm = normalizeWorkstationUrl(url);
  const next = readWorkstations().filter((entry) => entry !== norm);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* unavailable */ }
  return next;
}

// The workstation this remote client is CURRENTLY connected to: its own origin,
// but only when that origin is a real (remote) workstation. On localhost — the
// workstation's own browser, or the installed app before it has been pointed at a
// workstation (tauri://localhost) — there is no remote workstation, so return ''.
export function activeWorkstationUrl() {
  if (typeof window === 'undefined') return '';
  if (isLocalHostName(window.location.hostname)) return '';
  return normalizeWorkstationUrl(window.location.origin);
}

export function isActiveWorkstation(url) {
  const active = activeWorkstationUrl();
  return Boolean(active) && normalizeWorkstationUrl(url) === active;
}

// The QR-scan / deep-link pending URL (set by app.js __orcaConnect before it
// navigates) so the connect screen pre-fills the right address.
export function pendingWorkstationUrl() {
  try { return normalizeWorkstationUrl(sessionStorage.getItem(PENDING_KEY) || ''); } catch { return ''; }
}

export function setPendingWorkstationUrl(url) {
  const norm = normalizeWorkstationUrl(url);
  try {
    if (norm) sessionStorage.setItem(PENDING_KEY, norm);
    else sessionStorage.removeItem(PENDING_KEY);
  } catch { /* unavailable */ }
}
