// Browser auth session + pairing-code store. Extracted from auth-sessions.js;
// pure crypto/encoding helpers live in crypto.js.

import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readJsonFileWithRecoverySync,
  writeJsonFileAtomicSync,
} from '../state-store.js';
import {
  SESSION_COOKIE_NAME,
  DEFAULT_PAIRING_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  nowIso,
  hashSecret,
  hashesEqual,
  parsePositiveMs,
  safeLabel,
  generatePairingCode,
  generateSessionToken,
  parseCookies,
} from './crypto.js';

// Caps on retained records. pruneExpired runs before each add, so these only
// ever truncate when there are genuinely that many live records.
const MAX_PAIRING_CODES = 50;
const MAX_SESSIONS = 100;

// Expiry checks must fail CLOSED on a malformed/missing timestamp. Date.parse()
// returns NaN for an unparseable string, and `NaN > now` / `NaN <= now` are both
// false — so a naive `Date.parse(x) <= now` would treat a corrupted expiry as
// "not expired" and accept it. These helpers treat any non-finite timestamp as
// already expired.
function notExpired(expiresAt, now = Date.now()) {
  const ts = Date.parse(expiresAt);
  return Number.isFinite(ts) && ts > now;
}
function isExpired(expiresAt, now = Date.now()) {
  return !notExpired(expiresAt, now);
}

export class AuthSessionStore {
  constructor({
    stateFile = path.join(process.cwd(), '.orca', 'auth-sessions.json'),
    pairingTtlMs = parsePositiveMs(process.env.ORCA_PAIRING_CODE_TTL_MS, DEFAULT_PAIRING_TTL_MS),
    sessionTtlMs = parsePositiveMs(process.env.ORCA_BROWSER_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
  } = {}) {
    this.stateFile = stateFile;
    this.pairingTtlMs = pairingTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.loadStatus = null;
    this.state = {
      schemaVersion: 1,
      pairingCodes: [],
      sessions: [],
      auditEvents: [],
    };
    this.load();
  }

  load() {
    const fallback = {
      schemaVersion: 1,
      pairingCodes: [],
      sessions: [],
      auditEvents: [],
    };
    try {
      const recovered = readJsonFileWithRecoverySync(this.stateFile, { fallback });
      this.loadStatus = recovered.status;
      const parsed = recovered.data || fallback;
      const shouldAuditRecovery = this.loadStatus?.recovered || this.loadStatus?.ok === false;
      this.state = {
        schemaVersion: 1,
        pairingCodes: Array.isArray(parsed.pairingCodes) ? parsed.pairingCodes : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents.slice(0, 300) : [],
      };
      this.pruneExpired({ persist: false });
      this.pruneTrustedSessions({ persist: false });
      if (shouldAuditRecovery) {
        this.audit({
          type: 'auth_state_recovered',
          actor: 'system',
          status: this.loadStatus.ok ? 'passed' : 'failed',
          summary: `Auth session state loaded from ${this.loadStatus.source}`,
          evidence: {
            source: this.loadStatus.source,
            recovered: this.loadStatus.recovered,
            filePath: this.loadStatus.filePath,
            backupPath: this.loadStatus.backupPath,
            corruptPath: this.loadStatus.corruptPath,
            reason: this.loadStatus.reason,
            backupReason: this.loadStatus.backupReason,
          },
        });
        this.persist();
      }
    } catch {
      this.state = fallback;
    }
  }

  persist() {
    fsSync.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    writeJsonFileAtomicSync(this.stateFile, { ...this.state, savedAt: nowIso() });
  }

  audit(event) {
    this.state.auditEvents.unshift({
      id: randomUUID(),
      createdAt: nowIso(),
      ...event,
    });
    this.state.auditEvents = this.state.auditEvents.slice(0, 300);
  }

  pruneExpired({ persist = true } = {}) {
    const now = Date.now();
    const beforePairings = this.state.pairingCodes.length;
    const beforeSessions = this.state.sessions.length;
    this.state.pairingCodes = this.state.pairingCodes.filter((item) =>
      item && !item.usedAt && notExpired(item.expiresAt, now)
    );
    this.state.sessions = this.state.sessions.filter((item) =>
      item && !item.revokedAt && notExpired(item.expiresAt, now)
    );
    if (persist && (beforePairings !== this.state.pairingCodes.length || beforeSessions !== this.state.sessions.length)) {
      this.persist();
    }
  }

  // Collapse workstation (token-bootstrap, pairedFromId === null) sessions down to
  // the single newest one. Real paired devices (pairedFromId set) are untouched.
  // Cleans up phantom piles created before the createTrustedSession dedup landed.
  pruneTrustedSessions({ persist = true } = {}) {
    const trusted = this.state.sessions.filter((record) => record && !record.pairedFromId && !record.revokedAt);
    if (trusted.length <= 1) return;
    const keepId = trusted[0].id; // sessions are unshifted newest-first
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter(
      (record) => record.pairedFromId || record.revokedAt || record.id === keepId,
    );
    if (persist && this.state.sessions.length !== before) this.persist();
  }

  createPairingCode({
    actor = 'dashboard',
    label = 'Phone/browser pairing',
    ttlMs = this.pairingTtlMs,
  } = {}) {
    this.pruneExpired();
    const ttl = Math.max(30 * 1000, Math.min(30 * 60 * 1000, Number.parseInt(ttlMs, 10) || this.pairingTtlMs));
    const code = generatePairingCode();
    const record = {
      id: randomUUID(),
      codeHash: hashSecret(code),
      label: safeLabel(label, 'Phone/browser pairing'),
      actor: safeLabel(actor, 'dashboard'),
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      usedAt: null,
    };
    this.state.pairingCodes.unshift(record);
    this.state.pairingCodes = this.state.pairingCodes.slice(0, MAX_PAIRING_CODES);
    this.audit({
      type: 'auth_pairing_code_created',
      actor: record.actor,
      status: 'passed',
      summary: `Created browser pairing code for ${record.label}`,
      evidence: {
        pairingId: record.id,
        expiresAt: record.expiresAt,
        codeHashPrefix: record.codeHash.slice(0, 12),
      },
    });
    this.persist();
    return {
      id: record.id,
      code,
      label: record.label,
      expiresAt: record.expiresAt,
      ttlSeconds: Math.floor(ttl / 1000),
    };
  }

  consumePairingCode(code, {
    label = 'Paired browser',
    userAgent = '',
    remoteAddress = '',
  } = {}) {
    this.pruneExpired();
    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(normalizedCode)) {
      throw { status: 422, message: 'Pairing code format is invalid.' };
    }
    const codeHash = hashSecret(normalizedCode);
    const record = this.state.pairingCodes.find((item) => hashesEqual(item.codeHash, codeHash));
    if (!record) {
      throw { status: 401, message: 'Pairing code is invalid or expired.' };
    }
    if (record.usedAt || isExpired(record.expiresAt)) {
      throw { status: 401, message: 'Pairing code is invalid or expired.' };
    }
    const session = this._appendSession({
      label: safeLabel(label, 'Paired browser'),
      pairedFromId: record.id,
      userAgent,
      remoteAddress,
    });
    record.usedAt = nowIso();
    this.audit({
      type: 'auth_session_created',
      actor: 'pairing',
      status: 'passed',
      summary: `Created browser session ${session.record.label}`,
      evidence: {
        sessionId: session.record.id,
        pairedFromId: record.id,
        expiresAt: session.record.expiresAt,
        tokenHashPrefix: session.record.tokenHash.slice(0, 12),
      },
    });
    this.persist();
    return {
      session: this.publicSession(session.record),
      sessionToken: session.token,
      maxAgeSeconds: Math.floor(this.sessionTtlMs / 1000),
    };
  }

  // Mint a session WITHOUT a pairing code, for callers the server has already
  // authenticated by a valid API token (or local-host bootstrap). This bridges
  // header/token auth to a cookie so same-origin asset loads (e.g. <img src> for
  // evidence/artifacts, which cannot send the token header) authenticate too.
  createTrustedSession({ label = 'Workstation browser', userAgent = '', remoteAddress = '' } = {}) {
    const session = this._appendSession({
      label: safeLabel(label, 'Workstation browser'),
      pairedFromId: null,
      userAgent,
      remoteAddress,
    });
    // Keep only ONE workstation (token-bootstrap) session. The cookie is re-minted
    // on every cookie-less same-origin admin load, so without this it piles up
    // phantom "Workstation browser" sessions that are NOT real paired devices.
    this.state.sessions = this.state.sessions.filter(
      (record) => record.id === session.record.id || record.pairedFromId !== null,
    );
    this.audit({
      type: 'auth_session_created',
      actor: 'token-bootstrap',
      status: 'passed',
      summary: `Created browser session ${session.record.label} from token auth`,
      evidence: {
        sessionId: session.record.id,
        pairedFromId: null,
        expiresAt: session.record.expiresAt,
        tokenHashPrefix: session.record.tokenHash.slice(0, 12),
      },
    });
    this.persist();
    return {
      session: this.publicSession(session.record),
      sessionToken: session.token,
      maxAgeSeconds: Math.floor(this.sessionTtlMs / 1000),
    };
  }

  // Shared session creation: prune expired, mint a CSPRNG token, cap retained
  // sessions. Returns { record, token } (token is plaintext, returned once).
  _appendSession({ label, pairedFromId, userAgent, remoteAddress }) {
    this.pruneExpired({ persist: false });
    const sessionToken = generateSessionToken();
    const record = {
      id: randomUUID(),
      tokenHash: hashSecret(sessionToken),
      label,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      revokedAt: null,
      pairedFromId: pairedFromId || null,
      userAgent: safeLabel(userAgent, ''),
      remoteAddress: safeLabel(remoteAddress, ''),
    };
    this.state.sessions.unshift(record);
    this.state.sessions = this.state.sessions.slice(0, MAX_SESSIONS);
    return { record, token: sessionToken };
  }

  publicSession(session) {
    if (!session) return null;
    return {
      id: session.id,
      label: session.label,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt || null,
      pairedFromId: session.pairedFromId || null,
      // A real paired REMOTE device vs the local workstation browser (token
      // bootstrap). The UI lists/counts only paired devices.
      paired: Boolean(session.pairedFromId),
      kind: session.pairedFromId ? 'paired' : 'workstation',
      userAgent: session.userAgent || '',
      active: !session.revokedAt && notExpired(session.expiresAt),
    };
  }

  validateSessionToken(token) {
    const normalized = String(token || '').trim();
    if (!normalized) return null;
    this.pruneExpired();
    const tokenHash = hashSecret(normalized);
    const session = this.state.sessions.find((item) => hashesEqual(item.tokenHash, tokenHash));
    if (!session || session.revokedAt || isExpired(session.expiresAt)) return null;
    return this.publicSession(session);
  }

  sessionFromCookieHeader(cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    return this.validateSessionToken(cookies[SESSION_COOKIE_NAME]);
  }

  sessionTokenFromCookieHeader(cookieHeader) {
    return parseCookies(cookieHeader)[SESSION_COOKIE_NAME] || '';
  }

  revokeSessionToken(token, { actor = 'dashboard' } = {}) {
    const normalized = String(token || '').trim();
    if (!normalized) return { revoked: false };
    const tokenHash = hashSecret(normalized);
    const session = this.state.sessions.find((item) => hashesEqual(item.tokenHash, tokenHash));
    if (!session) return { revoked: false };
    session.revokedAt = nowIso();
    this.audit({
      type: 'auth_session_revoked',
      actor: safeLabel(actor, 'dashboard'),
      status: 'passed',
      summary: `Revoked browser session ${session.label}`,
      evidence: { sessionId: session.id },
    });
    this.persist();
    return { revoked: true, session: this.publicSession(session) };
  }

  revokeSessionId(sessionId, { actor = 'dashboard' } = {}) {
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session) throw { status: 404, message: 'Browser session not found.' };
    session.revokedAt = nowIso();
    this.audit({
      type: 'auth_session_revoked',
      actor: safeLabel(actor, 'dashboard'),
      status: 'passed',
      summary: `Revoked browser session ${session.label}`,
      evidence: { sessionId: session.id },
    });
    this.persist();
    return { revoked: true, session: this.publicSession(session) };
  }

  listSessions() {
    this.pruneExpired();
    return this.state.sessions.map((session) => this.publicSession(session));
  }
}
