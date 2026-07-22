// Asset version — keep in lockstep with the ?v= cache-buster in index.html.
// Bump BOTH together via `node scripts/sync-asset-version.mjs <version>`; the
// pwa-cache smoke fails if they drift. (The suffix after 'orca-static-' is the
// shared token.)
const CACHE_NAME = 'orca-static-v2-23';
const STATIC_ASSETS = [
  '/',
  '/styles.css',
  '/ui/overview.css',
  '/ui/overview.js',
  '/ui/icons.js',
  '/ui/home-disclosure.js',
  '/ui/qr.js',
  '/ui/workstations.js',
  '/theme-init.js',
  '/sw-boot.js',
  '/manifest.webmanifest',
  '/favicon-32.png',
  '/orca-mark.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];
const STATIC_ASSET_PATHS = new Set(STATIC_ASSETS);
const SENSITIVE_PREFIXES = [
  '/api/',
  '/artifacts/',
];

function isSensitiveUrl(url) {
  return SENSITIVE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function cacheKeyForStaticAsset(url) {
  if (!STATIC_ASSET_PATHS.has(url.pathname)) return null;
  return url.pathname;
}

function isAppShellDocument(request) {
  return request.destination === 'document';
}

function canCacheStaticResponse(url, cacheKey) {
  if (!cacheKey) return false;
  if (cacheKey === '/' && url.search) return false;
  return true;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isSensitiveUrl(url)) return;

  // A top-level navigation (document request, or a deep-link SPA route) gets the
  // app-shell fallback when offline. Everything else is an addressable asset.
  const isNavigation = request.mode === 'navigate' || isAppShellDocument(request);
  const cacheKey = cacheKeyForStaticAsset(url);
  if (!cacheKey && !isNavigation) return;

  // Static module graph (JS/CSS/icons): STALE-WHILE-REVALIDATE. Serve the cached
  // copy instantly (no network round-trip on every load — the old network-first
  // strategy paid a round-trip per asset for no offline benefit), and refresh the
  // cache in the background. Deploys bump CACHE_NAME, so the activate handler drops
  // the old cache and the next load re-fetches — versioning, not freshness-per-load.
  if (cacheKey && !isNavigation) {
    event.respondWith((async () => {
      const cached = await caches.match(cacheKey);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok && canCacheStaticResponse(url, cacheKey)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
          }
          return response;
        })
        .catch(() => null);
      if (cached) {
        // Revalidate in the background. waitUntil only extends the SW lifetime; the
        // fetch promise already runs, so guard it for environments without it.
        if (typeof event.waitUntil === 'function') event.waitUntil(networkFetch);
        return cached;
      }
      const fresh = await networkFetch;
      return fresh || new Response('Offline', { status: 504, statusText: 'Offline' });
    })());
    return;
  }

  // Document navigations: network-first with an app-shell fallback when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && canCacheStaticResponse(url, cacheKey)) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
        }
        return response;
      })
      .catch(async () => {
        // App-shell fallback applies ONLY to document navigations. Never return
        // index.html for a script/style/icon request — the browser would parse
        // HTML as the wrong type, crashing module imports and blanking (which on
        // iOS can auto-close) a standalone PWA.
        const shell = await caches.match('/');
        if (shell) return shell;
        // Nothing usable cached: return an explicit error rather than resolving
        // respondWith() to undefined (which surfaces as a hard network error and
        // can blank/close a standalone window).
        return new Response('Offline', { status: 504, statusText: 'Offline' });
      }),
  );
});
