/* No-flash init. Runs synchronously in <head> BEFORE the stylesheet, so the
   correct data-theme AND the viewport-height context (native app / installed PWA)
   are set before first paint. Mirrors ui/theme.js + ui/dom.js. Kept as an external
   file (not inline) to comply with the script-src 'self' CSP. */
(function () {
  var root = document.documentElement;
  // --- Viewport-height context (must be pre-paint so layout never flashes the
  //     wrong height / a bottom gap). data-native + data-standalone switch --vph
  //     from 100dvh (browser) to 100vh (full-screen app/PWA) in styles.css. ---
  try {
    var params = new URLSearchParams(window.location.search);
    // The native app carries orca_app=1 when it navigates to the workstation origin
    // (Tauri does NOT inject __TAURI__ at remote origins). Persist it per-origin.
    if (params.get('orca_app') === '1') {
      try { localStorage.setItem('orca.nativeApp', '1'); } catch (e) {}
    }
    var native = false;
    try { native = Boolean(window.__TAURI__) || localStorage.getItem('orca.nativeApp') === '1'; } catch (e) { native = Boolean(window.__TAURI__); }
    if (!native) native = /OrcaApp/.test((window.navigator && window.navigator.userAgent) || '');
    if (native) root.setAttribute('data-native', '1');
    var mm = window.matchMedia;
    var standalone = (window.navigator && window.navigator.standalone === true)
      || Boolean(mm && (mm('(display-mode: standalone)').matches || mm('(display-mode: fullscreen)').matches));
    if (standalone) root.setAttribute('data-standalone', '1');
  } catch (e) { /* leave defaults (browser dvh) */ }

  // --- Theme (per-ORIGIN; carried across the app→workstation navigation as
  //     ?orca_theme=… so the new origin doesn't flash the wrong color). ---
  try {
    var tparams = new URLSearchParams(window.location.search);
    var fromUrl = tparams.get('orca_theme');
    if (fromUrl === 'dark' || fromUrl === 'light') {
      localStorage.setItem('orca.theme', fromUrl);
    } else if (fromUrl === 'system') {
      localStorage.removeItem('orca.theme');
    }
    // Strip our transport params so the URL stays clean.
    if (fromUrl || tparams.get('orca_app')) {
      tparams.delete('orca_theme');
      tparams.delete('orca_app');
      var qs = tparams.toString();
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    }
    var p = localStorage.getItem('orca.theme');
    var dark = (p === 'dark')
      || (p !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    root.setAttribute('data-theme', 'dark');
  }
})();
