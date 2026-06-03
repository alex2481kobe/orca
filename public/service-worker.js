const CACHE_NAME = 'orca-static-v31';
const STATIC_ASSETS = [
  '/',
  '/styles.css',
  '/app.js',
  '/ui/access-mode.js',
  '/ui/api.js',
  '/ui/constants.js',
  '/ui/controller.js',
  '/ui/dom.js',
  '/ui/executor.js',
  '/ui/format.js',
  '/ui/handlers-access.js',
  '/ui/handlers-actions.js',
  '/ui/handlers-config.js',
  '/ui/handlers-create.js',
  '/ui/handlers-integrations.js',
  '/ui/handlers-lane-actions.js',
  '/ui/handlers-lane.js',
  '/ui/handlers-session-actions.js',
  '/ui/handlers-system-actions.js',
  '/ui/handlers.js',
  '/ui/notifications.js',
  '/ui/qr.js',
  '/ui/render-fragments.js',
  '/ui/render-helpers.js',
  '/ui/render-home.js',
  '/ui/render-lane.js',
  '/ui/render-project.js',
  '/ui/render-session-parts.js',
  '/ui/render-session.js',
  '/ui/render-shell.js',
  '/ui/render-views.js',
  '/ui/sidebar.js',
  '/ui/state.js',
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
