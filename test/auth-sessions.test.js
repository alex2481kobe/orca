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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-auth-'));
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

test('expiry checks fail closed on a corrupted (non-ISO) timestamp', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-auth-nan-'));
  try {
    const store = new AuthSessionStore({
      stateFile: path.join(tempDir, 'auth.json'),
      pairingTtlMs: 60000,
      sessionTtlMs: 60000,
    });
    const pairing = store.createPairingCode({ actor: 'test', label: 'phone' });
    const paired = store.consumePairingCode(pairing.code, { label: 'p', userAgent: 'ua' });
    const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(paired.sessionToken)}`;
    assert.ok(store.sessionFromCookieHeader(cookieHeader)); // valid baseline

    // Corrupt the stored expiry to a string Date.parse() can't read -> NaN.
    // A naive `Date.parse(x) <= now` would treat NaN as "not expired" and accept it.
    for (const session of store.state.sessions) session.expiresAt = 'not-a-real-date';
    assert.equal(store.sessionFromCookieHeader(cookieHeader), null, 'malformed expiry must be rejected, not accepted');

    // Same for pairing codes.
    const p2 = store.createPairingCode({ actor: 'test', label: 'phone2' });
    for (const code of store.state.pairingCodes) code.expiresAt = 'garbage';
    assert.throws(() => store.consumePairingCode(p2.code), (error) => error.status === 401);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('pairing codes expire and reject malformed values', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-auth-expiry-'));
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

test('workstation (trusted) sessions never pile up: only the newest is kept, paired devices preserved', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-auth-trust-'));
  const stateFile = path.join(tempDir, 'auth.json');
  try {
    const store = new AuthSessionStore({ stateFile, pairingTtlMs: 60000, sessionTtlMs: 60000 });
    // A real paired remote device.
    const pairing = store.createPairingCode({ actor: 'test', label: 'phone' });
    store.consumePairingCode(pairing.code, { label: 'Alex phone', userAgent: 'ua' });
    // Many cookie-less workstation loads each mint a trusted session.
    for (let i = 0; i < 8; i += 1) store.createTrustedSession({ label: 'Workstation browser', userAgent: 'hc' });
    const sessions = store.listSessions();
    const workstation = sessions.filter((s) => s.kind === 'workstation');
    const paired = sessions.filter((s) => s.paired);
    assert.equal(workstation.length, 1, 'only one workstation session retained');
    assert.equal(paired.length, 1, 'the paired remote device is preserved');

    // A reload prunes any pre-existing pile down to one workstation session.
    store.state.sessions.unshift(...Array.from({ length: 5 }, (_, i) => ({
      id: `legacy-${i}`, tokenHash: `h${i}`, label: 'Workstation browser',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
      revokedAt: null, pairedFromId: null, userAgent: 'hc', remoteAddress: '',
    })));
    store.pruneTrustedSessions({ persist: false });
    assert.equal(store.listSessions().filter((s) => s.kind === 'workstation').length, 1, 'prune collapses the pile');
    assert.equal(store.listSessions().filter((s) => s.paired).length, 1, 'paired still preserved after prune');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
