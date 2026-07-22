import { createHash } from 'node:crypto';

const DEFAULT_LIMITS = {
  auth: { limit: 12, windowMs: 60_000 },
  authPair: { limit: 8, windowMs: 60_000 },
  // GET /api/auth/status + /api/auth/sessions are POLLED reads (the dashboard
  // syncs the paired-device list ~1/s while a pairing code is on screen, plus an
  // SSE-driven sync on every change). They are auth-gated and expose no secrets,
  // so they must NOT share the strict `auth` mutation budget — doing so 429'd the
  // poll after ~12s and froze pairing reflection for the rest of the window (the
  // "workstation takes ~27s to show the paired device" bug). The brute-force
  // surface (pair attempts / code creation) stays on the strict authPair budget.
  authRead: { limit: 600, windowMs: 60_000 },
  evidenceCapture: { limit: 20, windowMs: 60_000 },
  processSpawn: { limit: 30, windowMs: 60_000 },
  processControl: { limit: 60, windowMs: 60_000 },
  cleanup: { limit: 12, windowMs: 60_000 },
  agentLease: { limit: 60, windowMs: 60_000 },
  stream: { limit: 30, windowMs: 60_000 },
  privateAccess: { limit: 60, windowMs: 60_000 },
  mcpMutation: { limit: 60, windowMs: 60_000 },
  defaultMutation: { limit: 180, windowMs: 60_000 },
  defaultRead: { limit: 900, windowMs: 60_000 },
};

function envNumber(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function policyFromEnv(policyName) {
  const upper = policyName.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase();
  const base = DEFAULT_LIMITS[policyName] || DEFAULT_LIMITS.defaultMutation;
  return {
    limit: envNumber(`ORCA_RATE_LIMIT_${upper}_LIMIT`, base.limit),
    windowMs: envNumber(`ORCA_RATE_LIMIT_${upper}_WINDOW_MS`, base.windowMs),
  };
}

function hashToken(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function headerValue(headers, key) {
  const value = headers?.[key] || headers?.[key.toLowerCase()] || headers?.[key.toUpperCase()];
  if (Array.isArray(value)) return value[0] || '';
  return String(value || '');
}

function requestActorKey(req) {
  const authHeader = headerValue(req.headers, 'authorization');
  const commandToken = headerValue(req.headers, 'x-orca-token');
  const workerToken = headerValue(req.headers, 'x-orca-worker-token');
  const cookie = headerValue(req.headers, 'cookie');
  const forwardedFor = headerValue(req.headers, 'x-forwarded-for').split(',')[0].trim();
  const remote = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  if (authHeader.startsWith('Bearer ')) return `bearer:${hashToken(authHeader.slice(7))}`;
  if (commandToken) return `token:${hashToken(commandToken)}`;
  if (workerToken) return `worker:${hashToken(workerToken)}`;
  if (cookie) {
    // Key on the session cookie value only — not the whole header — so unrelated
    // cookies (or attacker-rotated throwaway cookies) can't reset/evade the bucket.
    const match = /(?:^|;\s*)orca_session=([^;]*)/.exec(cookie);
    const sessionValue = match ? match[1] : '';
    if (sessionValue) return `cookie:${hashToken(sessionValue)}`;
  }
  // Only trust X-Forwarded-For when the connection itself is from loopback (a
  // local reverse proxy like Tailscale Serve set it). A DIRECT client can spoof
  // XFF to rotate its key and evade the brute-force budget, so for non-loopback
  // remotes key on the real socket address.
  const isLoopbackRemote = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  const clientIp = (isLoopbackRemote && forwardedFor) ? forwardedFor : remote;
  return `ip:${hashToken(clientIp || remote)}`;
}

function classifyRoute(method, parts) {
  const verb = String(method || 'GET').toUpperCase();
  const p1 = parts[1] || '';
  const p2 = parts[2] || '';
  const p3 = parts[3] || '';
  const p4 = parts[4] || '';

  if (p1 === 'auth') {
    if (['pair', 'pairing-codes', 'logout'].includes(p2)) return 'authPair';
    // status + sessions are frequently-polled, auth-gated reads — generous budget.
    if (verb === 'GET') return 'authRead';
    return 'auth';
  }
  if (p1 === 'lanes') {
    if (p3 === 'evidence' && verb === 'POST') return 'evidenceCapture';
    if (['stop', 'retry', 'heartbeat', 'integrate'].includes(p3)) return 'processControl';
    if (p3 === 'worktree' && (p4 === 'remove' || p4 === 'discard')) return 'cleanup';
  }
  if (p1 === 'sessions') {
    if (p3 === 'lanes' && verb === 'POST') return 'processSpawn';
    if (p3 === 'capacity' || p3 === 'audit-done-lanes') return 'processControl';
  }
  // The cleanup SCHEDULE is read (GET) on every dashboard refresh; only the
  // destructive cleanup runs (POST run-now / cleanup) belong on the strict
  // `cleanup` mutation budget. Keeping the GET on `cleanup` 429'd it at the
  // no-SSE/live-console poll cadence (same class as the auth-read bug).
  if (p1 === 'artifacts' && p2 === 'cleanup') return verb === 'GET' ? 'defaultRead' : 'cleanup';
  if (p1 === 'agent-tools' && p2 === 'leases') return 'agentLease';
  if (p1 === 'streams') return 'stream';
  if (p1 === 'private-access') return verb === 'GET' ? 'defaultRead' : 'privateAccess';
  if (p1 === 'settings') return verb === 'GET' ? 'defaultRead' : 'defaultMutation';
  if (p1 === 'mcp' && verb !== 'GET') return 'mcpMutation';
  if (verb !== 'GET') return 'defaultMutation';
  return 'defaultRead';
}

class MemoryRateLimiter {
  constructor({ now = () => Date.now(), disabled = false } = {}) {
    this.now = now;
    this.disabled = disabled;
    this.buckets = new Map();
    this._checksSincePrune = 0;
  }

  policy(policyName) {
    return policyFromEnv(policyName);
  }

  check({ key, policyName }) {
    const policy = this.policy(policyName);
    if (this.disabled || policy.limit <= 0) {
      return {
        allowed: true,
        policyName,
        limit: policy.limit,
        remaining: policy.limit,
        resetAt: new Date(this.now()).toISOString(),
        retryAfterSeconds: 0,
      };
    }
    const now = this.now();
    // Opportunistically evict expired buckets so the map can't grow without
    // bound across many distinct actors/IPs (no external scheduler required).
    if ((this._checksSincePrune += 1) >= 500) {
      this._checksSincePrune = 0;
      this.prune();
    }
    const bucketKey = `${policyName}:${key}`;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || now >= bucket.resetAtMs) {
      bucket = {
        count: 0,
        resetAtMs: now + policy.windowMs,
      };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, policy.limit - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000));
    return {
      allowed: bucket.count <= policy.limit,
      policyName,
      limit: policy.limit,
      remaining,
      resetAt: new Date(bucket.resetAtMs).toISOString(),
      retryAfterSeconds,
    };
  }

  prune() {
    const now = this.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAtMs) this.buckets.delete(key);
    }
  }
}

function createRateLimiter(options = {}) {
  return new MemoryRateLimiter(options);
}

function classifyRequestForRateLimit(req, method, parts) {
  return {
    policyName: classifyRoute(method, parts),
    key: requestActorKey(req),
  };
}

export {
  MemoryRateLimiter,
  classifyRequestForRateLimit,
  classifyRoute,
  createRateLimiter,
};
