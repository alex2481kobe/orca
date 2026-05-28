import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AuthSessionStore,
  SESSION_COOKIE_NAME,
} from '../src/auth-sessions.js';

test('pairing codes create HttpOnly-session-compatible browser sessions without storing raw secrets', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-auth-'));
  const stateFile = path.join(tempDir, 'auth.json');
  try {
    const store = new AuthSessionStore({
      stateFile,
      pairingTtlMs: 60000,
      sessionTtlMs: 60000,
    });
    const pairing = store.createPairingCode({ actor: 'test', label: 'phone' });
    assert.match(pairing.code, /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
    assert.equal(JSON.stringify(store.state).includes(pairing.code), false);

    const paired = store.consumePairingCode(pairing.code, {
      label: 'Alex phone',
      userAgent: 'test-agent',
    });
    assert.equal(paired.session.active, true);
    assert.equal(JSON.stringify(store.state).includes(paired.sessionToken), false);

    const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(paired.sessionToken)}`;
    const session = store.sessionFromCookieHeader(cookieHeader);
    assert.equal(session.id, paired.session.id);

    assert.throws(() => store.consumePairingCode(pairing.code), (error) => error.status === 401);
    const revoked = store.revokeSessionToken(paired.sessionToken, { actor: 'test' });
    assert.equal(revoked.revoked, true);
    assert.equal(store.sessionFromCookieHeader(cookieHeader), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('pairing codes expire and reject malformed values', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-auth-expiry-'));
  try {
    const store = new AuthSessionStore({
      stateFile: path.join(tempDir, 'auth.json'),
      pairingTtlMs: 1,
      sessionTtlMs: 60000,
    });
    assert.throws(() => store.consumePairingCode('not-a-code'), (error) => error.status === 422);
    const pairing = store.createPairingCode({ ttlMs: 60000 });
    store.state.pairingCodes[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.throws(() => store.consumePairingCode(pairing.code), (error) => error.status === 401);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
