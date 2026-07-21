// Core DOM + URL/navigation safety helpers shared across the dashboard.
// Depends only on shared state (refs) and pure escaping helpers. Extracted from app.js.

import { refs } from './state.js';
import { safeAttr } from './format.js';

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

// The installed MOBILE app (Tauri on iOS/Android). Its webview is served from
// tauri://localhost, so the hostname looks local — but it is a REMOTE client
// (the workstation/server is on another machine), never the workstation itself.
export function isMobileApp() {
  if (typeof window === 'undefined') return false;
  const ua = (window.navigator && window.navigator.userAgent) || '';
  return Boolean(window.__TAURI__) && /iPhone|iPad|iPod|Android/i.test(ua);
}

// True only on the trusted workstation: a localhost origin that is NOT the mobile
// app. Drives workstation-only UI (host management) vs remote/mobile clients.
export function isWorkstation() {
  if (typeof window === 'undefined') return false;
  return isLocalHostName(window.location.hostname) && !isMobileApp();
}

// Running inside the native (Tauri) app — at ANY origin. `__TAURI__` only exists on
// the app's own bundled pages; once it navigates to the workstation origin that
// global is gone, so we also honor a per-origin flag persisted from the orca_app=1
// param the connect flow carries (theme-init.js sets it), plus a UA token if ever
// present. Drives the full-screen viewport layout + suppresses the "get the app" promo.
export function isNativeApp() {
  if (typeof window === 'undefined') return false;
  if (window.__TAURI__) return true;
  try { if (localStorage.getItem('orca.nativeApp') === '1') return true; } catch { /* storage blocked */ }
  return /OrcaApp/.test((window.navigator && window.navigator.userAgent) || '');
}

// Carry the native-app signal to the workstation origin (where __TAURI__ is gone)
// so it can render the full-screen app layout. No-op for plain browsers.
export function appendNativeFlag(url) {
  if (!isNativeApp()) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('orca_app', '1');
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + 'orca_app=1';
  }
}

// Visiting in a mobile-Safari/Chrome on iOS in a BROWSER (not the installed app)
// — the case where we suggest downloading the native iOS app.
export function isIosWeb() {
  if (typeof window === 'undefined') return false;
  if (window.__TAURI__) return false;
  // Already in the native app (even at the workstation origin where __TAURI__ is
  // gone) — never nag it to "get the app".
  if (isNativeApp()) return false;
  const ua = (window.navigator && window.navigator.userAgent) || '';
  const iOS = /iPhone|iPad|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (window.navigator?.maxTouchPoints || 0) > 1);
  return iOS;
}

// Best-effort detection of the CURRENT device's browser + platform from the UA.
// Used to show one accurate "Add to Home Screen" instruction for the browser the
// user is actually on, instead of a generic iPhone/Android list. Order matters:
// Edge/Samsung/Opera UAs all contain "Chrome", and Chrome's contains "Safari".
export function detectBrowser() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const ua = (nav && nav.userAgent) || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1);
  const isAndroid = /Android/.test(ua);
  let name = 'your browser';
  if (/Edg(A|iOS)?\//.test(ua)) name = 'Edge';
  else if (/SamsungBrowser/.test(ua)) name = 'Samsung Internet';
  else if (/(OPR|Opera|OPT)\//.test(ua)) name = 'Opera';
  else if (/Firefox\/|FxiOS/.test(ua)) name = 'Firefox';
  else if (/CriOS\//.test(ua)) name = 'Chrome';
  else if (/Chrome\//.test(ua)) name = 'Chrome';
  else if (/Safari\//.test(ua)) name = 'Safari';
  const platform = isIOS ? 'ios' : isAndroid ? 'android' : 'desktop';
  // Already installed / launched from the Home Screen or as a standalone window.
  const standalone = (nav && nav.standalone === true)
    || (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches === true);
  return { name, platform, isIOS, isAndroid, standalone };
}

// One sentence telling the user exactly how to install Orca to their Home Screen
// in the browser they are CURRENTLY using. "Add to Home Screen" is a phone/tablet
// concept, so this returns null for: the installed native app (already an app),
// desktop/laptop browsers (no home screen), and anything already standalone.
export function installToHomeHint() {
  // The native app (Tauri, desktop OR mobile) is already installed — nothing to add.
  if (typeof window !== 'undefined' && window.__TAURI__) return null;
  const { name, platform, standalone } = detectBrowser();
  if (standalone) return null;
  if (platform === 'ios') {
    // On iOS/iPadOS every browser shares WebKit; install goes through the Share sheet.
    return `In ${name}, tap the Share button, then "Add to Home Screen".`;
  }
  if (platform === 'android') {
    if (name === 'Firefox') return 'In Firefox, open the ⋮ menu, then "Install" (or "Add to Home screen").';
    if (name === 'Samsung Internet') return 'In Samsung Internet, open the menu, then "Add page to", then "Home screen".';
    return `In ${name}, open the ⋮ menu, then "Add to Home screen" (or "Install app").`;
  }
  // Desktop / laptop browsers: no Home Screen, so no hint.
  return null;
}

// Returns true only when the DOM was actually rewritten (HTML differed from the
// last write), so callers can react to real changes — e.g. auto-scroll the chat
// thread only when new content arrived, not on every idle poll.
//
// SECURITY INVARIANT: `html` MUST already be safe. Every render function that
// builds the string interpolates dynamic values exclusively through safeText()
// (element text) or safeAttr() (attribute values) from format.js. Never pass a
// raw, unescaped server/user value here. (CodeQL flags this innerHTML sink — it
// does not recognize the project's safeText/safeAttr escapers; the inputs are
// escaped by construction, verified across all callers.)
export function writeHtml(el, html) {
  if (!el) return false;
  if (el.__lastHtml === html) return false;
  el.__lastHtml = html;
  el.innerHTML = html;
  return true;
}

export function renderAlert(text, level = 'info') {
  // Only surface real problems. Informational / success toasts ("X canceled",
  // "X archived", "lane started"…) are noise and also caused a layout shift, so
  // they are dropped — the UI already reflects the change. Errors still show, as a
  // fixed overlay toast (never pushes content).
  if (level !== 'bad' && level !== 'error') return;
  if (!refs.alerts) return;
  // Build via DOM + textContent (not innerHTML) so the message is inert text by
  // construction — no markup is ever parsed from it, regardless of escaping.
  refs.alerts.textContent = '';
  const box = document.createElement('div');
  box.className = 'alert bad';
  box.setAttribute('role', 'alert');
  box.textContent = String(text ?? '');
  refs.alerts.appendChild(box);
  clearTimeout(renderAlert.timer);
  renderAlert.timer = setTimeout(() => {
    if (refs.alerts) refs.alerts.textContent = '';
  }, 5000);
}
