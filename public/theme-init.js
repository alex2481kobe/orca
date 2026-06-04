/* No-flash theme init. Runs synchronously in <head> BEFORE the stylesheet, so
   the correct data-theme is set before first paint. Mirrors ui/theme.js. Kept
   as an external file (not inline) to comply with the script-src 'self' CSP. */
(function () {
  try {
    var p = localStorage.getItem('orca.theme');
    var dark = (p === 'dark')
      || (p !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
