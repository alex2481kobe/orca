// Project quick-link (live dev-server link) normalization + health checks.
// Extracted from registry.js. Pure helpers plus one bounded outbound health
// probe (loopback/tailnet only, 2.5s timeout, redirect: manual).

import { randomUUID } from 'node:crypto';
import { nowIso } from './registry-utils.js';
import { validateNetworkUrl, publicHostResolvesSafely } from './url-policy.js';

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

export function normalizeQuickLinkHealthPath(raw, fallback = '/') {
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

function quickLinkHealthCheckUrl(baseUrl, healthPath = '/') {
  const path = normalizeQuickLinkHealthPath(healthPath);
  if (path === '/') return baseUrl;
  const origin = new URL(baseUrl).origin;
  return new URL(path, origin).toString();
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

export function effectiveQuickLinkUrl(link, { prefer = 'auto' } = {}) {
  if (!link) return '';
  if (prefer === 'local') return link.localUrl || link.url || '';
  if (prefer === 'https') return link.httpsServeUrl || link.tailnetHttpUrl || link.localUrl || link.url || '';
  if (prefer === 'tailnet') return link.tailnetHttpUrl || link.httpsServeUrl || link.localUrl || link.url || '';
  return link.url || link.tailnetHttpUrl || link.httpsServeUrl || link.localUrl || '';
}

export async function boundedQuickLinkHealthCheck(link, { prefer = 'auto' } = {}) {
  const candidate = effectiveQuickLinkUrl(link, { prefer });
  if (!candidate || candidate.startsWith('/')) {
    return {
      status: 'not_checkable',
      httpStatus: null,
      detail: 'Relative dashboard links do not have an external health check.',
      checkedUrl: candidate || '',
    };
  }
  let policy;
  try {
    policy = validateNetworkUrl(candidate, {
      field: 'quick link health URL',
      allowedHosts: ['loopback', 'tailnet'],
      allowPublic: true,
      allowSensitive: false,
    });
    policy = {
      ...policy,
      url: quickLinkHealthCheckUrl(policy.url, link.healthPath || '/'),
    };
  } catch (error) {
    return {
      status: 'unreachable',
      httpStatus: null,
      detail: error.message || 'Quick link URL failed validation.',
      checkedUrl: candidate,
    };
  }
  // SSRF / DNS-rebinding guard: validateNetworkUrl trusts the hostname string, so
  // a public name that resolves to an internal IP would pass. Re-check the resolved
  // address(es) before fetching.
  try {
    const safe = await publicHostResolvesSafely(new URL(policy.url).hostname);
    if (!safe) {
      return {
        status: 'unreachable',
        httpStatus: null,
        detail: 'Quick link host resolves to a non-public address.',
        checkedUrl: policy.url,
      };
    }
  } catch {
    return { status: 'unreachable', httpStatus: null, detail: 'Quick link host could not be resolved.', checkedUrl: policy.url };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(policy.url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    return {
      status: response.status >= 200 && response.status < 500 ? 'reachable' : 'unreachable',
      httpStatus: response.status,
      detail: response.status >= 200 && response.status < 500
        ? `Responded with HTTP ${response.status}.`
        : `Unexpected HTTP ${response.status}.`,
      checkedUrl: policy.url,
    };
  } catch (error) {
    return {
      status: 'unreachable',
      httpStatus: null,
      detail: error?.name === 'AbortError' ? 'Health check timed out.' : 'Health check failed.',
      checkedUrl: policy.url,
    };
  } finally {
    clearTimeout(timeout);
  }
}
