#!/usr/bin/env node
/*
 * Orca auth session smoke.
 *
 * Safe local gate for phone/browser pairing: high-entropy one-time codes,
 * raw-token-at-rest protection, HttpOnly-cookie-compatible session handling,
 * revocation, expiry, and corrupt-state recovery.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthSessionStore } from '../src/auth-sessions/store.js';
import { SESSION_COOKIE_NAME } from '../src/auth-sessions/crypto.js';

const log = (label, info = '') => console.log(`[auth-sessions] ${label}${info ? ' — ' + info : ''}`);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-auth-smoke-'));
try {
  const stateFile = path.join(tempDir, 'auth-sessions.json');
  const store = new AuthSessionStore({
    stateFile,
    pairingTtlMs: 60_000,
    sessionTtlMs: 60_000,
  });

  const pairing = store.createPairingCode({ actor: 'smoke', label: 'phone' });
  assert.match(pairing.code, /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(JSON.stringify(store.state).includes(pairing.code), false, 'raw pairing code must not be stored');

  const paired = store.consumePairingCode(pairing.code, {
    label: 'Smoke phone',
    userAgent: 'auth-smoke',
    remoteAddress: '127.0.0.1',
  });
  assert.equal(paired.session.active, true);
  assert.equal(JSON.stringify(store.state).includes(paired.sessionToken), false, 'raw session token must not be stored');

  const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(paired.sessionToken)}`;
  assert.equal(store.sessionFromCookieHeader(cookieHeader).id, paired.session.id);
  assert.throws(() => store.consumePairingCode(pairing.code), (error) => error.status === 401);

  const revoked = store.revokeSessionToken(paired.sessionToken, { actor: 'smoke' });
  assert.equal(revoked.revoked, true);
  assert.equal(store.sessionFromCookieHeader(cookieHeader), null);
  assert.equal(store.state.auditEvents.some((event) => event.type === 'auth_session_revoked'), true);

  const expiryStore = new AuthSessionStore({
    stateFile: path.join(tempDir, 'expiry.json'),
    pairingTtlMs: 60_000,
    sessionTtlMs: 60_000,
  });
  const expiring = expiryStore.createPairingCode({ actor: 'smoke', label: 'expiring' });
  expiryStore.state.pairingCodes[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.throws(() => expiryStore.consumePairingCode(expiring.code), (error) => error.status === 401);

  await fs.writeFile(stateFile, '{ corrupt auth json');
  const recovered = new AuthSessionStore({
    stateFile,
    pairingTtlMs: 60_000,
    sessionTtlMs: 60_000,
  });
  assert.equal(recovered.loadStatus.source, 'backup');
  assert.equal(recovered.loadStatus.recovered, true);
  assert.equal(recovered.state.auditEvents.some((event) => event.type === 'auth_state_recovered'), true);

  log('done', 'pairing, revocation, expiry, and recovery verified');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}
