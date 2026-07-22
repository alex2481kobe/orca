// The remote client's known workstation URLs and which one it is connected to.
// A phone (or any browser away from the workstation) can be pointed at more than
// one Orca; this is the single source of truth for that list so case-only variants
// ("http://X" vs "HTTP://X") collapse to one entry everywhere.

const STORAGE_KEY = 'orca.workstations';
const MAX_RECENTS = 6;

function isLocalHostName(hostname) {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(String(hostname || '').toLowerCase());
}

// Canonical form: lowercase scheme + host (case-only variants collapse), default
// scheme http://, no trailing slash, no fragment. '' for empty/garbage input.
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
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// A short, human label for a workstation URL — just the host (and port).
export function workstationLabel(url) {
  const norm = normalizeWorkstationUrl(url) || String(url || '');
  try { return new URL(norm).host || norm; } catch { return norm.replace(/^https?:\/\//i, ''); }
}

// The normalized, de-duplicated list of recent workstation URLs, newest first.
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

// The workstation this client is CURRENTLY connected to: its own origin, but only
// when that origin is a real remote workstation (not the workstation's own loopback
// browser). '' on loopback.
export function activeWorkstationUrl() {
  if (typeof window === 'undefined') return '';
  if (isLocalHostName(window.location.hostname)) return '';
  return normalizeWorkstationUrl(window.location.origin);
}

export function isActiveWorkstation(url) {
  const active = activeWorkstationUrl();
  return Boolean(active) && normalizeWorkstationUrl(url) === active;
}
