const CACHE_NAME = 'orca-static-v15';
const STATIC_ASSETS = [
  '/',
  '/styles.css',
  '/app.js',
  '/ui/qr.js',
  '/ui/format.js',
  '/ui/state.js',
  '/ui/constants.js',
  '/ui/dom.js',
  '/ui/notifications.js',
  '/ui/executor.js',
  '/manifest.webmanifest',
  '/favicon-32.png',
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

  const cacheKey = cacheKeyForStaticAsset(url);
  if (!cacheKey && !isAppShellDocument(request)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && canCacheStaticResponse(url, cacheKey)) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
        }
        return response;
      })
      .catch(() => caches.match(cacheKey || '/').then((cached) => cached || caches.match('/'))),
  );
});
