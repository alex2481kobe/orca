#!/usr/bin/env node
/*
 * Orca PWA cache smoke.
 *
 * Verifies that the service worker keeps the phone app installable while
 * caching only static assets. Sensitive API, artifact, evidence, logs, and
 * token-bearing document URLs must never be written to Cache Storage.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.cwd();
const serviceWorkerPath = path.resolve(root, 'public', 'service-worker.js');
const manifestPath = path.resolve(root, 'public', 'manifest.webmanifest');

const log = (label, info = '') => console.log(`[pwa-cache] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[pwa-cache FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

function makeResponse(label) {
  return {
    ok: true,
    label,
    clone() {
      return makeResponse(`${label}:clone`);
    },
  };
}

function request(url, options = {}) {
  return {
    url,
    method: options.method || 'GET',
    destination: options.destination || '',
  };
}

async function buildServiceWorkerHarness() {
  const source = await fs.readFile(serviceWorkerPath, 'utf8');
  const listeners = new Map();
  const cachePuts = [];
  const cacheMatches = [];
  const addAllCalls = [];
  const deletedCaches = [];
  const openedCaches = [];
  const fetchedUrls = [];

  const cacheApi = {
    async addAll(items) {
      addAllCalls.push([...items]);
    },
    async put(key, response) {
      cachePuts.push({
        key: typeof key === 'string' ? key : key?.url || String(key),
        responseLabel: response?.label || '',
      });
    },
  };

  const context = {
    URL,
    Promise,
    console,
    fetch: async (req) => {
      fetchedUrls.push(typeof req === 'string' ? req : req.url);
      return makeResponse(typeof req === 'string' ? req : req.url);
    },
    caches: {
      async open(name) {
        openedCaches.push(name);
        return cacheApi;
      },
      async keys() {
        return ['orca-static-old', 'orca-static-v1'];
      },
      async delete(name) {
        deletedCaches.push(name);
        return true;
      },
      async match(key) {
        cacheMatches.push(typeof key === 'string' ? key : key?.url || String(key));
        return makeResponse(`cached:${typeof key === 'string' ? key : key?.url || String(key)}`);
      },
    },
    self: {
      location: {
        origin: 'http://127.0.0.1:3000',
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      skipWaiting() {
        return Promise.resolve();
      },
      clients: {
        claim() {
          return Promise.resolve();
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, {
    filename: serviceWorkerPath,
  });

  async function runLifecycle(type) {
    const waits = [];
    const handler = listeners.get(type);
    if (!handler) fail('missing service-worker listener', type);
    handler({
      waitUntil(promise) {
        waits.push(Promise.resolve(promise));
      },
    });
    await Promise.all(waits);
  }

  async function runFetch(req) {
    let responsePromise = null;
    const handler = listeners.get('fetch');
    if (!handler) fail('missing service-worker listener', 'fetch');
    handler({
      request: req,
      respondWith(promise) {
        responsePromise = Promise.resolve(promise);
      },
    });
    return responsePromise ? responsePromise : null;
  }

  return {
    addAllCalls,
    cacheMatches,
    cachePuts,
    deletedCaches,
    fetchedUrls,
    openedCaches,
    runFetch,
    runLifecycle,
    source,
  };
}

async function assertManifest() {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  if (manifest.display !== 'standalone') fail('manifest display must be standalone');
  if (manifest.scope !== '/') fail('manifest scope must be root');
  if (manifest.start_url !== '/') fail('manifest start_url must not contain tokens or query params');
  if (!Array.isArray(manifest.icons) || !manifest.icons.length) fail('manifest must define an icon');
  if (raw.includes('apiToken') || raw.includes('ORCA_API_TOKEN')) {
    fail('manifest must not reference token fields');
  }
  log('manifest', `${manifest.name || manifest.short_name} scope=${manifest.scope}`);
}

async function assertServiceWorkerSource(source) {
  const forbiddenCacheWrites = [
    "cache.put(request",
    "cache.put(event.request",
    "caches.match(request",
    "caches.match(event.request",
  ];
  for (const marker of forbiddenCacheWrites) {
    if (source.includes(marker)) fail('service worker uses request object as cache key', marker);
  }
  for (const marker of ['/api/', '/artifacts/']) {
    if (!source.includes(marker)) fail('service worker missing sensitive prefix guard', marker);
  }
  if (!source.includes('canCacheStaticResponse')) fail('service worker missing cache write gate');
  if (!source.includes("cacheKey === '/' && url.search")) fail('service worker must refuse searched app-shell cache writes');
  log('source', 'static cache guards present');
}

function assertNoSensitiveCacheWrites(cachePuts) {
  const sensitive = cachePuts.filter((item) =>
    item.key.includes('/api/') ||
    item.key.includes('/artifacts/') ||
    item.key.includes('token=') ||
    item.key.includes('apiToken=') ||
    item.key.includes('secret') ||
    item.key.includes('evidence') ||
    item.key.includes('log')
  );
  if (sensitive.length) fail('sensitive cache write detected', JSON.stringify(sensitive));
}

async function assertAssetVersionCoupling() {
  const sw = await fs.readFile(serviceWorkerPath, 'utf8');
  const indexHtml = await fs.readFile(path.resolve(root, 'public', 'index.html'), 'utf8');
  const swToken = (sw.match(/const CACHE_NAME = 'orca-static-([^']+)';/) || [])[1];
  const indexTokens = [...new Set([...indexHtml.matchAll(/\?v=([A-Za-z0-9._-]+)/g)].map((m) => m[1]))];
  if (!swToken) fail('service-worker CACHE_NAME token not found');
  if (!indexTokens.length) fail('index.html has no ?v= cache-buster');
  if (indexTokens.length > 1) fail('index.html ?v= tokens disagree', indexTokens.join(', '));
  if (indexTokens[0] !== swToken) {
    fail('asset-version drift: CACHE_NAME and index.html ?v= must match', `sw=${swToken} index=${indexTokens[0]} (run scripts/sync-asset-version.mjs)`);
  }
  log('asset-version', `CACHE_NAME + ?v= coupled at "${swToken}"`);
}

async function main() {
  await assertManifest();
  await assertAssetVersionCoupling();
  const harness = await buildServiceWorkerHarness();
  await assertServiceWorkerSource(harness.source);
  await harness.runLifecycle('install');
  await harness.runLifecycle('activate');
  const precache = harness.addAllCalls[0] || [];
  const expectedPrecache = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/favicon-32.png'];
  for (const item of expectedPrecache) {
    if (!precache.includes(item)) fail('precache missing static asset', item);
  }
  // Auto-derive the expected client-module set from disk so a newly added
  // public/ui/*.js module that's forgotten in STATIC_ASSETS fails the smoke
  // instead of silently shipping uncached (the /ui/dropdown.js miss class).
  const uiDir = path.resolve(root, 'public', 'ui');
  const uiModules = (await fs.readdir(uiDir))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `/ui/${name}`)
    .sort();
  const missingUi = uiModules.filter((item) => !precache.includes(item));
  if (missingUi.length) fail('precache missing ui module(s)', JSON.stringify(missingUi));
  log('ui-modules', `${uiModules.length} /ui/*.js module(s) all precached`);
  if (precache.some((item) => item.startsWith('/api/') || item.startsWith('/artifacts/'))) {
    fail('precache contains sensitive route', JSON.stringify(precache));
  }
  log('precache', `${precache.length} static asset(s)`);

  const apiResponse = await harness.runFetch(request('http://127.0.0.1:3000/api/projects', { destination: '' }));
  if (apiResponse) fail('API GET should bypass service worker respondWith');

  const artifactResponse = await harness.runFetch(request('http://127.0.0.1:3000/artifacts/session/lane/evidence.json', { destination: '' }));
  if (artifactResponse) fail('artifact GET should bypass service worker respondWith');

  const postResponse = await harness.runFetch(request('http://127.0.0.1:3000/api/projects', { method: 'POST' }));
  if (postResponse) fail('mutating POST should bypass service worker respondWith');

  await harness.runFetch(request('http://127.0.0.1:3000/app.js?v=20260528', { destination: 'script' }));
  await harness.runFetch(request('http://127.0.0.1:3000/?apiToken=manual-test-token', { destination: 'document' }));
  await harness.runFetch(request('http://127.0.0.1:3000/projects/demo/sessions/one', { destination: 'document' }));

  assertNoSensitiveCacheWrites(harness.cachePuts);
  const keys = harness.cachePuts.map((item) => item.key);
  if (!keys.includes('/app.js')) fail('versioned app.js should cache under normalized static key');
  if (keys.includes('/?apiToken=manual-test-token') || keys.includes('/')) {
    const rootWrites = harness.cachePuts.filter((item) => item.key === '/');
    if (rootWrites.length > 0) fail('token-bearing root document must not write root cache entry after install');
  }
  if (!harness.deletedCaches.includes('orca-static-old')) fail('activate should delete old static caches');
  log('fetch', `cacheWrites=${JSON.stringify(harness.cachePuts.map((item) => item.key))}`);
  log('done', 'static-only service-worker cache verified');
}

await main().catch((error) => {
  console.error('[pwa-cache ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
});
