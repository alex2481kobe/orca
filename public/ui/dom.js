// Core DOM + URL/navigation safety helpers shared across the dashboard.
// Depends only on shared state (refs) and pure escaping helpers. Extracted from app.js.

import { refs } from './state.js';
import { safeText, safeAttr } from './format.js';

export function clientUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, window.location.origin);
    if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
      parsed.protocol = window.location.protocol;
      parsed.hostname = window.location.hostname;
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

// Attribute-safe href/src value. Only same-page anchors, root-relative paths,
// and http(s) URLs are allowed; anything else (e.g. javascript:) becomes '#'.
export function safeHref(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') || raw.startsWith('#')) return safeAttr(raw);
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return safeAttr(parsed.toString());
    }
  } catch {
    /* fall through to safe no-op */
  }
  return '#';
}

// Only navigate to safe destinations (blocks javascript:/data: from server data).
export function safeNavigate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return;
  if (raw.startsWith('/') || raw.startsWith('#')) {
    window.location.href = raw;
    return;
  }
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      window.location.href = parsed.toString();
    }
  } catch {
    /* refuse unsafe navigation */
  }
}

export function authRequiredMessage() {
  return 'This browser is not authenticated. Pair it from the trusted workstation or unlock the workstation with the API token.';
}

export function isLocalHostName(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').toLowerCase());
}

export function writeHtml(el, html) {
  if (!el) return;
  if (el.__lastHtml === html) return;
  el.__lastHtml = html;
  el.innerHTML = html;
}

export function renderAlert(text, level = 'info') {
  refs.alerts.innerHTML = `<div class="card ${level}">${safeText(text)}</div>`;
  clearTimeout(renderAlert.timer);
  renderAlert.timer = setTimeout(() => {
    if (refs.alerts) refs.alerts.innerHTML = '';
  }, 3500);
}
