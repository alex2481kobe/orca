// Route-inventory shared helpers: the route() factory + auth-contract
// resolution. Extracted from route-inventory.js.

export const ROUTE_INVENTORY_VERSION = 'orca.route-inventory.v1';

export const jsonBodyLimit = 'ORCA_MAX_JSON_BYTES default 262144';
export const corsDefault = 'same-origin/browser session or x-orca-token; CORS denied by default';
export const centralRateLimit = 'central in-memory policy via src/rate-limiter.js; emits 429 with Retry-After and X-RateLimit-* headers';

// Auth contract vocabulary (single source of truth, mirrored in server.js):
//   none                                  -> public: liveness, auth status, static shell.
//   one_time_pairing_code                 -> /api/auth/pair (consumes a code, no prior auth).
//   api_token_or_paired_browser_session   -> operator: workflow control + all reads.
//   ..._plus_optional_worker_token        -> operator, optionally a worker token.
//   api_token_or_local_host_admin         -> admin: host mutation, credentials, network, devices.
const AUTH_PUBLIC = 'none';
const AUTH_OPERATOR = 'api_token_or_paired_browser_session';
const AUTH_ADMIN = 'api_token_or_local_host_admin';

// Genuinely public (no workspace/host data, or self-authorizing pairing).
const PUBLIC_ROUTE_KEYS = new Set([
  'GET /api/health',
  'GET /api/auth/status',
  'POST /api/auth/pair',
  'GET /',
  'GET /styles.css',
  'GET /app.js',
  'GET /manifest.webmanifest',
  'GET /service-worker.js',
]);

// Host-level administration: only the workstation (API token or non-proxied
// loopback bootstrap) may reach these. Paired devices are denied (403).
const ADMIN_ROUTE_KEYS = new Set([
  'POST /api/executors/{executor}/cli/reinstall',
  'GET /api/providers/export',
  'PATCH /api/providers/{providerId}',
  'POST /api/providers/{providerId}/secret',
  'DELETE /api/providers/{providerId}/secret',
  'POST /api/providers/import/dry-run',
  'POST /api/providers/import/apply',
  'GET /api/app/export',
  'POST /api/app/import/dry-run',
  'POST /api/app/import/apply',
  'GET /api/app/support-bundle',
  'PATCH /api/private-access/settings',
  'POST /api/private-access/targets',
  'PATCH /api/private-access/targets/{targetId}',
  'DELETE /api/private-access/targets/{targetId}',
  'POST /api/private-access/targets/{targetId}/check',
  'POST /api/auth/pairing-codes',
  'POST /api/capture/install',
]);

function resolveAuthContract(method, routePath, declared) {
  const key = `${method} ${routePath}`;
  if (PUBLIC_ROUTE_KEYS.has(key)) return declared === AUTH_PUBLIC ? AUTH_PUBLIC : declared;
  if (ADMIN_ROUTE_KEYS.has(key)) return AUTH_ADMIN;
  // Preserve special operator variants (e.g. heartbeat worker token).
  if (String(declared || '').includes('worker_token')) return declared;
  // Everything else returns data or mutates the workspace -> operator minimum.
  return AUTH_OPERATOR;
}

export function route(entry) {
  return {
    contractVersion: ROUTE_INVENTORY_VERSION,
    owner: 'orca-server',
    bodyLimit: entry.method === 'GET' ? 'none' : jsonBodyLimit,
    rateLimit: entry.rateLimit || centralRateLimit,
    mobileBehavior: entry.mobileBehavior || 'available through dashboard/mobile manifest where relevant',
    ...entry,
    auth: resolveAuthContract(entry.method, entry.route, entry.auth),
  };
}
