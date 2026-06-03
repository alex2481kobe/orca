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
// Client-side (SPA) navigation. Same-origin path routes are pushed onto history
// and re-rendered in place via a popstate event — NEVER a full window reload
// (that blanked the UI on every project/session click). Hash routes drive the
// home-panel switch via hashchange. External http(s) links open in a new tab.
export function safeNavigate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return;
  if (raw.startsWith('#')) {
    window.location.hash = raw;
    return;
  }
  const goPath = (pathWithRest) => {
    const current = window.location.pathname + window.location.search + window.location.hash;
    if (pathWithRest !== current) {
      window.history.pushState({}, '', pathWithRest);
    }
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  if (raw.startsWith('/')) {
    goPath(raw);
    return;
  }
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin === window.location.origin) {
      goPath(parsed.pathname + parsed.search + parsed.hash);
      return;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
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

// Returns true only when the DOM was actually rewritten (HTML differed from the
// last write), so callers can react to real changes — e.g. auto-scroll the chat
// thread only when new content arrived, not on every idle poll.
export function writeHtml(el, html) {
  if (!el) return false;
  if (el.__lastHtml === html) return false;
  el.__lastHtml = html;
  el.innerHTML = html;
  return true;
}

export function renderAlert(text, level = 'info') {
  refs.alerts.innerHTML = `<div class="card ${level}">${safeText(text)}</div>`;
  clearTimeout(renderAlert.timer);
  renderAlert.timer = setTimeout(() => {
    if (refs.alerts) refs.alerts.innerHTML = '';
  }, 3500);
}
