import fsSync from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  readJsonFileWithRecoverySync,
  writeJsonFileAtomicSync,
} from './state-store.js';

const nowIso = () => new Date().toISOString();
const SESSION_COOKIE_NAME = 'command_deck_session';
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function hashSecret(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function parsePositiveMs(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function safeLabel(value, fallback = '') {
  return String(value || fallback).trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
}

function generatePairingCode() {
  const raw = randomBytes(6).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function generateSessionToken() {
  return `${randomUUID()}-${randomBytes(24).toString('base64url')}`;
}

function parseCookies(cookieHeader) {
  const out = {};
  String(cookieHeader || '').split(';').forEach((part) => {
    const [rawKey, ...rawValue] = part.split('=');
    const key = rawKey?.trim();
    if (!key) return;
    out[key] = decodeURIComponent(rawValue.join('=').trim());
  });
  return out;
}

class AuthSessionStore {
  constructor({
    stateFile = path.join(process.cwd(), '.command-deck', 'auth-sessions.json'),
    pairingTtlMs = parsePositiveMs(process.env.COMMAND_DECK_PAIRING_CODE_TTL_MS, DEFAULT_PAIRING_TTL_MS),
    sessionTtlMs = parsePositiveMs(process.env.COMMAND_DECK_BROWSER_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
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
      item && !item.usedAt && Date.parse(item.expiresAt) > now
    );
    this.state.sessions = this.state.sessions.filter((item) =>
      item && !item.revokedAt && Date.parse(item.expiresAt) > now
    );
    if (persist && (beforePairings !== this.state.pairingCodes.length || beforeSessions !== this.state.sessions.length)) {
      this.persist();
    }
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
    this.state.pairingCodes = this.state.pairingCodes.slice(0, 50);
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
    const record = this.state.pairingCodes.find((item) => item.codeHash === codeHash);
    if (!record) {
      throw { status: 401, message: 'Pairing code is invalid or expired.' };
    }
    if (record.usedAt || Date.parse(record.expiresAt) <= Date.now()) {
      throw { status: 401, message: 'Pairing code is invalid or expired.' };
    }
    const sessionToken = generateSessionToken();
    const session = {
      id: randomUUID(),
      tokenHash: hashSecret(sessionToken),
      label: safeLabel(label, 'Paired browser'),
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      revokedAt: null,
      pairedFromId: record.id,
      userAgent: safeLabel(userAgent, ''),
      remoteAddress: safeLabel(remoteAddress, ''),
    };
    record.usedAt = nowIso();
    this.state.sessions.unshift(session);
    this.state.sessions = this.state.sessions.slice(0, 100);
    this.audit({
      type: 'auth_session_created',
      actor: 'pairing',
      status: 'passed',
      summary: `Created browser session ${session.label}`,
      evidence: {
        sessionId: session.id,
        pairedFromId: record.id,
        expiresAt: session.expiresAt,
        tokenHashPrefix: session.tokenHash.slice(0, 12),
      },
    });
    this.persist();
    return {
      session: this.publicSession(session),
      sessionToken,
      maxAgeSeconds: Math.floor(this.sessionTtlMs / 1000),
    };
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
      userAgent: session.userAgent || '',
      active: !session.revokedAt && Date.parse(session.expiresAt) > Date.now(),
    };
  }

  validateSessionToken(token) {
    const normalized = String(token || '').trim();
    if (!normalized) return null;
    this.pruneExpired();
    const tokenHash = hashSecret(normalized);
    const session = this.state.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) return null;
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
    const tokenHash = hashSecret(String(token || '').trim());
    const session = this.state.sessions.find((item) => item.tokenHash === tokenHash);
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

export {
  AuthSessionStore,
  SESSION_COOKIE_NAME,
  parseCookies,
};
