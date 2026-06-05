// Appearance / light-dark theming. The setting is per-device (localStorage),
// one of: 'system' (default), 'light', 'dark'. JS resolves it to a concrete
// data-theme="light"|"dark" on <html>; CSS keys the light palette off that.
//
// No-flash init also runs inline in index.html <head> before CSS paints; this
// module owns the live updates (system-change listener) and the setter.

const KEY = 'orca.theme';

export function getThemePref() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

// Carry the current theme to another ORIGIN (the workstation we're navigating to)
// via a query param, so its per-origin theme matches and it doesn't flash to the
// wrong color. theme-init.js reads + strips the param before first paint. Only an
// explicit light/dark choice is carried; 'system' lets the new origin follow the
// OS (same device → same prefers-color-scheme, so it already matches).
export function appendThemeParam(url) {
  const pref = getThemePref();
  if (pref !== 'light' && pref !== 'dark') return url;
  try {
    const u = new URL(url);
    u.searchParams.set('orca_theme', pref);
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + 'orca_theme=' + pref;
  }
}

function systemPrefersDark() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function resolvedTheme(pref = getThemePref()) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersDark() ? 'dark' : 'light';
}

function apply(pref = getThemePref()) {
  document.documentElement.setAttribute('data-theme', resolvedTheme(pref));
}

export function setThemePref(pref) {
  const next = pref === 'light' || pref === 'dark' ? pref : 'system';
  try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  apply(next);
}

export function initTheme() {
  apply();
  // Follow the OS when in 'system' mode.
  const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (mq) {
    const onChange = () => { if (getThemePref() === 'system') apply('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  // Sync across tabs / the inline init.
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(); });
}
