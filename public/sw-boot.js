// Service-worker boot. The pre-v2 app registered a service worker that precached
// the (now-deleted) legacy UI. If it is left registered it keeps serving that old
// shell from cache — including when the daemon is down, and on phones where it
// renders the old workstation-only UI. v2 must (a) register its OWN service worker
// and (b) evict the stale one. Registering the same-scope /service-worker.js
// replaces any prior registration and triggers an immediate update check; the new
// worker's `activate` handler then deletes every cache bucket that is not the
// current one (the legacy precache included). This file is deliberately tiny and
// dependency-free so it runs even if the app module fails to load.
(function bootServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function registerCurrentWorker() {
    navigator.serviceWorker.register('/service-worker.js')
      .then(function (registration) {
        // Force an update check now rather than waiting for the browser's periodic
        // (up to 24h) cycle, so a stale worker is replaced on this visit.
        if (registration && typeof registration.update === 'function') {
          registration.update().catch(function () {});
        }
      })
      .catch(function () { /* SW registration is best-effort; the app still works without it. */ });
  });
})();
