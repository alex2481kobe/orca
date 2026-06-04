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
