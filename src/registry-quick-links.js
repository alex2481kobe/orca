// Project quick-link (live dev-server link) normalization + health checks.
// Pure helpers only — the outbound health probe went
// with the deleted project.quick_link.health tool.

import { randomUUID } from 'node:crypto';
import { nowIso } from './registry-utils.js';
import { validateNetworkUrl } from './url-policy.js';

export const MAX_PROJECT_QUICK_LINKS = 50;
const QUICK_LINK_KINDS = new Set(['dev-server', 'vite', 'preview', 'dashboard', 'artifact', 'docs', 'other']);
const QUICK_LINK_HEALTH_STATUSES = new Set(['configured_unchecked', 'reachable', 'unreachable', 'not_checkable']);
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function sanitizeQuickLinkText(raw, fallback = '', max = 120) {
  return String(raw ?? fallback)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);
}

function normalizeQuickLinkHealthPath(raw, fallback = '/') {
  const text = sanitizeQuickLinkText(raw, fallback, 240) || fallback;
  if (!text || text === '/') return '/';
  if (text.startsWith('//') || text.startsWith('\\') || URL_SCHEME_RE.test(text)) {
    throw { status: 422, message: 'healthPath must be a relative URL path.' };
  }
  if (text.includes('\\')) {
    throw { status: 422, message: 'healthPath must use URL path separators.' };
  }
  return text.startsWith('/') ? text : `/${text}`;
}

function normalizeQuickLinkUrl(raw, field, { allowBlank = false } = {}) {
  const text = sanitizeQuickLinkText(raw, '', 2048);
  if (!text) {
    if (allowBlank) return '';
    throw { status: 422, message: `${field} is required.` };
  }
  if (text.startsWith('/') && !text.startsWith('//')) return text;
  const parsed = validateNetworkUrl(text, {
    field,
    allowedHosts: ['loopback', 'tailnet'],
    allowPublic: true,
    allowSensitive: false,
  });
  return parsed.url;
}

export function normalizeQuickLink(raw = {}, existing = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw { status: 422, message: 'Quick link must be an object.' };
  }
  const localUrl = normalizeQuickLinkUrl(raw.localUrl ?? existing?.localUrl, 'localUrl', { allowBlank: true });
  const tailnetHttpUrl = normalizeQuickLinkUrl(raw.tailnetHttpUrl ?? existing?.tailnetHttpUrl, 'tailnetHttpUrl', { allowBlank: true });
  const httpsServeUrl = normalizeQuickLinkUrl(raw.httpsServeUrl ?? existing?.httpsServeUrl, 'httpsServeUrl', { allowBlank: true });
  const primaryRaw = raw.url ?? existing?.url ?? tailnetHttpUrl ?? httpsServeUrl ?? localUrl;
  const url = normalizeQuickLinkUrl(primaryRaw, 'quick link URL', { allowBlank: false });
  const parsedPort = (() => {
    const rawPort = Number.parseInt(raw.port ?? existing?.port ?? '', 10);
    if (Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535) return rawPort;
    try {
      const parsed = new URL(url, 'http://orca.local');
      const urlPort = Number.parseInt(parsed.port || '', 10);
      if (Number.isFinite(urlPort) && urlPort >= 1 && urlPort <= 65535) return urlPort;
    } catch {
      /* relative dashboard URL */
    }
    return null;
  })();
  const kind = sanitizeQuickLinkText(raw.kind ?? existing?.kind ?? (parsedPort ? 'dev-server' : 'other'), 'other', 40).toLowerCase();
  const healthStatus = sanitizeQuickLinkText(raw.healthStatus ?? existing?.healthStatus ?? 'configured_unchecked', 'configured_unchecked', 40);
  return {
    id: sanitizeQuickLinkText(raw.id ?? existing?.id ?? randomUUID(), '', 80).replace(/[^A-Za-z0-9._:-]/g, '-') || randomUUID(),
    label: sanitizeQuickLinkText(raw.label ?? existing?.label ?? 'Live link', 'Live link', 100),
    url,
    localUrl,
    tailnetHttpUrl,
    httpsServeUrl,
    port: parsedPort,
    kind: QUICK_LINK_KINDS.has(kind) ? kind : 'other',
    group: sanitizeQuickLinkText(raw.group ?? existing?.group ?? '', '', 80),
    favorite: Boolean(raw.favorite ?? existing?.favorite ?? false),
    hidden: Boolean(raw.hidden ?? existing?.hidden ?? false),
    healthPath: normalizeQuickLinkHealthPath(raw.healthPath ?? existing?.healthPath ?? '/'),
    healthStatus: QUICK_LINK_HEALTH_STATUSES.has(healthStatus) ? healthStatus : 'configured_unchecked',
    lastCheckedAt: existing?.lastCheckedAt || raw.lastCheckedAt || null,
    lastStatusCode: Number.isFinite(existing?.lastStatusCode) ? existing.lastStatusCode : (Number.isFinite(raw.lastStatusCode) ? raw.lastStatusCode : null),
    lastHealthDetail: sanitizeQuickLinkText(existing?.lastHealthDetail || raw.lastHealthDetail || '', '', 180),
    createdAt: existing?.createdAt || raw.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

export function normalizeQuickLinks(rawLinks = []) {
  if (!Array.isArray(rawLinks)) return [];
  return rawLinks
    .slice(0, MAX_PROJECT_QUICK_LINKS)
    .map((link) => normalizeQuickLink(link));
}

// Derive the tailnet HTTP preview URL for a dev-server port from the
// workstation's MagicDNS name, e.g. tailnetUrlForPort(5173, 'orca.tail.ts.net')
// -> 'http://orca.tail.ts.net:5173'. Pure: returns '' when the port is out of
// range or MagicDNS is unknown (Tailscale not up) so callers can degrade to the
// localUrl. `healthPath` is optional and appended verbatim (leading slash added).
export function tailnetUrlForPort(port, magicDnsName, { healthPath = '' } = {}) {
  const parsedPort = Number.parseInt(port, 10);
  if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) return '';
  const host = String(magicDnsName || '').trim().replace(/\.$/, '');
  if (!host) return '';
  const rawPath = String(healthPath || '').trim();
  const suffix = rawPath ? (rawPath.startsWith('/') ? rawPath : `/${rawPath}`) : '';
  return `http://${host}:${parsedPort}${suffix}`;
}

export function effectiveQuickLinkUrl(link, { prefer = 'auto' } = {}) {
  if (!link) return '';
  if (prefer === 'local') return link.localUrl || link.url || '';
  if (prefer === 'https') return link.httpsServeUrl || link.tailnetHttpUrl || link.localUrl || link.url || '';
  if (prefer === 'tailnet') return link.tailnetHttpUrl || link.httpsServeUrl || link.localUrl || link.url || '';
  return link.url || link.tailnetHttpUrl || link.httpsServeUrl || link.localUrl || '';
}
