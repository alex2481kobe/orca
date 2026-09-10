// Agent tool-lease lifecycle + tool-state gating, as a prototype mixin for
// OrcaRegistry.
// These are methods (they use `this`) collected into one object and merged onto
// OrcaRegistry.prototype via Object.assign, so the public API is unchanged
// (registry.createToolLease(...) etc.) and they call sibling methods via `this`.

import { createHash, randomUUID } from 'node:crypto';
import { safeArray } from './registry-utils.js';
import { availableToolIdsForRole } from './agent-tools/roles.js';
import { buildNextActionEnvelope } from './agent-tools/next-action.js';
import { ROLES } from './agent-tools/contract.js';
import { buildOrchestratorMcpConfigs, resolveMcpLauncher } from './mcp-orchestrator-bootstrap.js';

const LANE_SCOPED_LEASE_ROLES = new Set(['executor']);
const SESSION_SCOPED_LEASE_ROLES = new Set(['auditor']);

// Refresh credentials: the narrow credential a client config carries instead of
// a lease (the OAuth2 refresh-token pattern). Kept in toolLeases with kind
// 'refresh', so persistence, listing, revocation and audit are shared with
// leases, but validateToolLease never accepts one.
const REFRESH_KIND = 'refresh';
// A credential nobody uses for 90 days lapses; any use slides it forward.
const REFRESH_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_LEASE_TTL_MS = 30 * 1000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

const isRefreshCredential = (item) => item?.kind === REFRESH_KIND;

function clampLeaseTtl(ttlMs) {
  return Math.max(MIN_LEASE_TTL_MS, Math.min(MAX_LEASE_TTL_MS, Number.parseInt(ttlMs, 10) || DEFAULT_LEASE_TTL_MS));
}

// A lease's own window. Leases record ttlMs from Stage 5 on; older ones carry
// only createdAt and expiresAt, which say the same thing.
function leaseWindowMs(item) {
  const recorded = Number(item.ttlMs);
  if (recorded > 0) return recorded;
  return Date.parse(item.expiresAt) - Date.parse(item.createdAt);
}

// Authoritative workflow gates: lane states in which each agent tool is legal.
// Enforced only on the agent (tool-lease) path so out-of-order/skipped/stale
// calls are refused with a nextAction envelope. Only the core lifecycle is gated;
// flexible ops (stop/retry/controls/evidence) stay ungated.
const LANE_TOOL_STATE_GATES = {
  'lane.submit': ['starting', 'running'],
  'audit.queue_one': ['ready_for_audit', 'done'],
  'audit.findings.record': ['ready_for_audit', 'auditing', 'done'],
  'audit.accept': ['ready_for_audit', 'auditing', 'done'],
  'audit.request_fix': ['ready_for_audit', 'auditing', 'done'],
  'audit.block': ['ready_for_audit', 'auditing', 'done'],
};

export const toolLeaseMethods = {
  // Is a tool lease currently live (not revoked, not expired)? Used by the
  // orchestrator staleness check. Lives here (not in agentMethods) so a test mock
  // that provides its own _leaseActiveById is not clobbered by the agent mixin.
  _leaseActiveById(leaseId) {
    if (!leaseId || leaseId === 'dashboard') return null;
    const lease = (this.toolLeases || []).find((item) => item.id === leaseId);
    if (!lease) return { found: false, active: false };
    const active = !lease.revokedAt && Date.parse(lease.expiresAt) > Date.now();
    return { found: true, active, lease };
  },

  _resolveToolLeaseScope({ projectId = null, sessionId = null, laneId = null } = {}, { allowMissing = false } = {}) {
    const requestedProjectId = projectId ? String(projectId) : null;
    const requestedSessionId = sessionId ? String(sessionId) : null;
    const requestedLaneId = laneId ? String(laneId) : null;
    const project = requestedProjectId ? this.getProject(requestedProjectId) : null;
    if (requestedProjectId && !project && !allowMissing) {
      throw { status: 404, message: 'Project not found for tool lease.' };
    }
    const requestedSession = requestedSessionId ? this.getSession(requestedSessionId) : null;
    if (requestedSessionId && !requestedSession && !allowMissing) {
      throw { status: 404, message: 'Session not found for tool lease.' };
    }
    const lane = requestedLaneId ? this.getLane(requestedLaneId) : null;
    if (requestedLaneId && !lane && !allowMissing) {
      throw { status: 404, message: 'Lane not found for tool lease.' };
    }
    const laneSession = lane ? this.getSession(lane.sessionId) : null;
    if (lane && !laneSession && !allowMissing) {
      throw { status: 422, message: 'Tool lease lane session is missing.' };
    }
    const effectiveSession = laneSession || requestedSession || null;
    const effectiveProjectId = project?.id || lane?.projectId || effectiveSession?.projectId || requestedProjectId || null;
    const effectiveProject = effectiveProjectId ? this.getProject(effectiveProjectId) : null;
    if (effectiveProjectId && !effectiveProject && !allowMissing) {
      throw { status: 422, message: 'Tool lease project is missing.' };
    }
    if (requestedSession && project && requestedSession.projectId !== project.id) {
      throw { status: 422, message: 'Tool lease session does not belong to the requested project.' };
    }
    if (lane && requestedSession && lane.sessionId !== requestedSession.id) {
      throw { status: 422, message: 'Tool lease lane does not belong to the requested session.' };
    }
    if (lane && project && lane.projectId !== project.id) {
      throw { status: 422, message: 'Tool lease lane does not belong to the requested project.' };
    }
    if (lane && laneSession && lane.projectId !== laneSession.projectId) {
      throw { status: 422, message: 'Tool lease lane project does not match its session project.' };
    }
    return {
      project: effectiveProject || project || null,
      session: effectiveSession,
      lane,
      projectId: effectiveProjectId,
      sessionId: effectiveSession?.id || requestedSessionId || null,
      laneId: lane?.id || requestedLaneId || null,
    };
  },

  createToolLease({
    role = 'orchestrator',
    projectId = null,
    sessionId = null,
    laneId = null,
    allowedTools = [],
    ttlMs = 15 * 60 * 1000,
    actor = 'dashboard',
    replaceActiveForActor = false,
    // The refresh credential this lease was obtained with, if any. The lease then
    // acts as that credential (publicToolLease ownerId).
    parentId = null,
  } = {}) {
    const normalizedRole = String(role || 'orchestrator').trim().toLowerCase() || 'orchestrator';
    if (!ROLES.has(normalizedRole)) {
      throw { status: 422, message: 'Tool lease role must be orchestrator, executor, auditor, or dashboard.' };
    }
    const scope = this._resolveToolLeaseScope({ projectId, sessionId, laneId });
    if (LANE_SCOPED_LEASE_ROLES.has(normalizedRole) && !scope.laneId) {
      throw { status: 422, message: `${normalizedRole} tool leases must be scoped to a lane.` };
    }
    if (SESSION_SCOPED_LEASE_ROLES.has(normalizedRole) && !scope.sessionId) {
      throw { status: 422, message: `${normalizedRole} tool leases must be scoped to a session or lane.` };
    }
    const roleTools = new Set(availableToolIdsForRole(normalizedRole));
    const normalizedAllowedTools = safeArray(allowedTools)
      .map((toolId) => String(toolId || '').trim())
      .filter(Boolean)
      .filter((toolId, index, all) => all.indexOf(toolId) === index)
      .slice(0, 100);
    const disallowedTools = normalizedAllowedTools.filter((toolId) => !roleTools.has(toolId));
    if (disallowedTools.length) {
      throw {
        status: 422,
        message: `Tool lease role "${normalizedRole}" cannot grant tool(s): ${disallowedTools.join(', ')}.`,
      };
    }
    const ttl = clampLeaseTtl(ttlMs);
    const leaseToken = `${randomUUID()}-${randomUUID()}`;
    const tokenHash = createHash('sha256').update(leaseToken).digest('hex');
    const now = Date.now();
    const normalizedActor = String(actor || 'dashboard').slice(0, 120);
    if (replaceActiveForActor) {
      const revokedAt = new Date(now).toISOString();
      for (const existing of this.toolLeases || []) {
        if (isRefreshCredential(existing)) continue;
        if (existing.revokedAt) continue;
        if (Date.parse(existing.expiresAt) <= now) continue;
        if (existing.role !== normalizedRole) continue;
        if (existing.actor !== normalizedActor) continue;
        const existingScope = this._resolveToolLeaseScope(existing, { allowMissing: true });
        if ((existingScope.projectId || null) !== (scope.projectId || null)) continue;
        if ((existingScope.sessionId || null) !== (scope.sessionId || null)) continue;
        if ((existingScope.laneId || null) !== (scope.laneId || null)) continue;
        existing.revokedAt = revokedAt;
        this.recordAudit({
          type: 'agent_tool_lease_revoked',
          actor: normalizedActor,
          projectId: existing.projectId,
          sessionId: existing.sessionId,
          laneId: existing.laneId,
          summary: `Replaced duplicate active ${existing.role} tool lease`,
          status: 'passed',
          evidence: {
            leaseId: existing.id,
            role: existing.role,
            reason: 'replace_active_for_actor',
            tokenHashPrefix: String(existing.tokenHash || '').slice(0, 12),
          },
        });
      }
    }
    const lease = {
      id: randomUUID(),
      tokenHash,
      role: normalizedRole,
      actor: normalizedActor,
      projectId: scope.projectId || null,
      sessionId: scope.sessionId || null,
      laneId: scope.laneId || null,
      parentId: parentId ? String(parentId) : null,
      allowedTools: normalizedAllowedTools,
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
      expiresAt: new Date(now + ttl).toISOString(),
      ttlMs: ttl,
      revokedAt: null,
    };
    this.toolLeases.unshift(lease);
    // Drop revoked/expired leases FIRST, so the 500 cap never evicts a still-valid
    // in-flight lease purely by volume (which would 401 a live agent).
    if (this.toolLeases.length > 500) {
      const now = Date.now();
      const isActive = (l) => !l.revokedAt && Date.parse(l.expiresAt) > now;
      this.toolLeases = this.toolLeases.filter(isActive).slice(0, 500);
    }
    this.recordAudit({
      type: 'agent_tool_lease_created',
      actor: lease.actor,
      projectId: lease.projectId,
      sessionId: lease.sessionId,
      laneId: lease.laneId,
      summary: `Created ${lease.role} tool lease`,
      status: 'passed',
      evidence: {
        leaseId: lease.id,
        role: lease.role,
        allowedTools: lease.allowedTools,
        expiresAt: lease.expiresAt,
        parentId: lease.parentId,
        tokenHashPrefix: tokenHash.slice(0, 12),
      },
    });
    this.persistState();
    return {
      lease: this.publicToolLease(lease),
      leaseToken,
    };
  },

  publicToolLease(lease) {
    if (!lease) return null;
    const scope = this._resolveToolLeaseScope(lease, { allowMissing: true });
    return {
      id: lease.id,
      kind: lease.kind || 'lease',
      // Who this lease acts as. A lease obtained with a refresh credential acts as
      // that credential, so every lease one client config obtains owns the same
      // orchestrator; any other lease acts as itself.
      ownerId: lease.parentId || lease.id,
      parentId: lease.parentId || null,
      role: lease.role,
      actor: lease.actor,
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      laneId: scope.laneId,
      allowedTools: safeArray(lease.allowedTools),
      createdAt: lease.createdAt,
      lastUsedAt: lease.lastUsedAt || null,
      expiresAt: lease.expiresAt,
      revokedAt: lease.revokedAt || null,
      ...(isRefreshCredential(lease) ? { leaseTtlMs: lease.leaseTtlMs } : {}),
      active: !lease.revokedAt && Date.parse(lease.expiresAt) > Date.now(),
    };
  },

  listToolLeases({ activeOnly = true } = {}) {
    const leases = this.toolLeases.map((lease) => this.publicToolLease(lease));
    return activeOnly ? leases.filter((lease) => lease.active) : leases;
  },

  // Sliding renewal, the way etcd, Consul and Kubernetes keep a lease alive while
  // its holder is active: a lease (or credential) accepted in the second half of
  // its window is pushed out to a full window again. A holder that keeps using it
  // never reaches expiry; one that stops lapses a window later. It writes at most
  // once per half-window, and never revives anything revoked or already expired.
  _renewIfDue(item, now = Date.now()) {
    if (!item || item.revokedAt) return false;
    const expiresAt = Date.parse(item.expiresAt);
    if (!(expiresAt > now)) return false;
    const window = leaseWindowMs(item);
    if (!(window > 0) || expiresAt - now >= window / 2) return false;
    item.expiresAt = new Date(now + window).toISOString();
    return true;
  },

  // Revoke a refresh credential and every lease it issued. Returns what it
  // revoked, the credential included when it was not already revoked.
  _revokeCredentialTree(credential, { actor = 'dashboard', reason = 'revoked' } = {}) {
    const revokedAt = new Date().toISOString();
    const revoked = [];
    for (const item of this.toolLeases || []) {
      if (item.revokedAt) continue;
      if (item.id !== credential.id && item.parentId !== credential.id) continue;
      item.revokedAt = revokedAt;
      revoked.push(item);
      this.recordAudit({
        type: 'agent_tool_lease_revoked',
        actor: String(actor || 'dashboard').slice(0, 120),
        projectId: item.projectId,
        sessionId: item.sessionId,
        laneId: item.laneId,
        summary: isRefreshCredential(item)
          ? `Revoked ${item.role} refresh credential`
          : `Revoked ${item.role} tool lease issued by a revoked refresh credential`,
        status: 'passed',
        evidence: {
          leaseId: item.id,
          kind: item.kind || 'lease',
          role: item.role,
          parentId: item.parentId || null,
          reason: String(reason || 'revoked').slice(0, 120),
          tokenHashPrefix: String(item.tokenHash || '').slice(0, 12),
        },
      });
    }
    return revoked;
  },

  // Issue the credential a client config carries. It can do one thing: obtain a
  // lease for its own role, actor and scope (exchangeRefreshCredential). It is
  // never a tool lease itself, lapses after 90 days unused, and revoking it
  // revokes every lease it issued. One live credential per actor and scope:
  // issuing another (running setup again) replaces the previous one and
  // everything it issued.
  _issueRefreshCredential({ role, projectId = null, sessionId = null, actor, leaseTtlMs } = {}) {
    const scope = this._resolveToolLeaseScope({ projectId, sessionId });
    const normalizedActor = String(actor || 'desktop-app').slice(0, 120);
    const now = Date.now();
    for (const existing of this.toolLeases || []) {
      if (!isRefreshCredential(existing) || existing.revokedAt || !(Date.parse(existing.expiresAt) > now)) continue;
      if (existing.role !== role || existing.actor !== normalizedActor) continue;
      if ((existing.projectId || null) !== (scope.projectId || null)) continue;
      if ((existing.sessionId || null) !== (scope.sessionId || null)) continue;
      this._revokeCredentialTree(existing, { actor: normalizedActor, reason: 'replaced_by_new_setup' });
    }
    const refreshToken = `orca_rt_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const credential = {
      id: randomUUID(),
      kind: REFRESH_KIND,
      tokenHash,
      role,
      actor: normalizedActor,
      projectId: scope.projectId || null,
      sessionId: scope.sessionId || null,
      laneId: null,
      parentId: null,
      allowedTools: [],
      leaseTtlMs: clampLeaseTtl(leaseTtlMs),
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
      expiresAt: new Date(now + REFRESH_IDLE_MS).toISOString(),
      ttlMs: REFRESH_IDLE_MS,
      revokedAt: null,
    };
    this.toolLeases.unshift(credential);
    this.recordAudit({
      type: 'agent_refresh_credential_created',
      actor: normalizedActor,
      projectId: credential.projectId,
      sessionId: credential.sessionId,
      summary: `Issued ${role} refresh credential`,
      status: 'passed',
      evidence: {
        leaseId: credential.id,
        kind: REFRESH_KIND,
        role,
        leaseTtlMs: credential.leaseTtlMs,
        expiresAt: credential.expiresAt,
        tokenHashPrefix: tokenHash.slice(0, 12),
      },
    });
    this.persistState();
    return { credential, refreshToken };
  },

  _findRefreshCredential(refreshToken) {
    const token = String(refreshToken || '').trim();
    if (!token) throw { status: 401, message: 'Refresh credential is required.' };
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const credential = (this.toolLeases || []).find((item) => item.tokenHash === tokenHash && isRefreshCredential(item));
    if (!credential) throw { status: 401, message: 'Refresh credential not found.' };
    if (credential.revokedAt) throw { status: 401, message: 'Refresh credential has been revoked.' };
    if (!(Date.parse(credential.expiresAt) > Date.now())) throw { status: 401, message: 'Refresh credential has expired.' };
    return credential;
  },

  // The only thing a refresh credential can do. The caller chooses nothing: role,
  // actor, scope, tools and lease window all come from the credential. Obtaining
  // a lease never revokes another, so every session sharing one client config
  // keeps its own lease.
  exchangeRefreshCredential(refreshToken) {
    const credential = this._findRefreshCredential(refreshToken);
    const now = Date.now();
    credential.lastUsedAt = new Date(now).toISOString();
    this._renewIfDue(credential, now);
    return this.createToolLease({
      role: credential.role,
      projectId: credential.projectId,
      sessionId: credential.sessionId,
      allowedTools: availableToolIdsForRole(credential.role),
      ttlMs: credential.leaseTtlMs,
      actor: credential.actor,
      parentId: credential.id,
    });
  },

  // Read-only, for `orca doctor`: which credential is this, and is it live? It
  // never renews and never stamps lastUsedAt, so diagnosing changes nothing. A
  // dead credential is refused with the reason a real call would get.
  inspectAgentCredential(token) {
    const value = String(token || '').trim();
    if (!value) throw { status: 401, message: 'A refresh credential or tool lease is required.' };
    const tokenHash = createHash('sha256').update(value).digest('hex');
    const item = (this.toolLeases || []).find((entry) => entry.tokenHash === tokenHash);
    if (!item) throw { status: 401, message: 'Credential not found.' };
    const noun = isRefreshCredential(item) ? 'Refresh credential' : 'Tool lease';
    if (item.revokedAt) throw { status: 401, message: `${noun} has been revoked.` };
    if (!(Date.parse(item.expiresAt) > Date.now())) throw { status: 401, message: `${noun} has expired.` };
    return this.publicToolLease(item);
  },

  revokeToolLeasesForLane(laneLocator, {
    actor = 'system',
    reason = 'lane_terminal',
    persist = true,
  } = {}) {
    const laneId = String(typeof laneLocator === 'object' ? laneLocator?.id || '' : laneLocator || '').trim();
    if (!laneId) return [];
    const revokedAt = new Date().toISOString();
    const revoked = [];
    for (const lease of this.toolLeases || []) {
      if (lease.laneId !== laneId) continue;
      if (lease.revokedAt) continue;
      if (Date.parse(lease.expiresAt) <= Date.now()) continue;
      lease.revokedAt = revokedAt;
      revoked.push(lease);
      this.recordAudit({
        type: 'agent_tool_lease_revoked',
        actor: String(actor || 'system').slice(0, 120),
        projectId: lease.projectId,
        sessionId: lease.sessionId,
        laneId: lease.laneId,
        summary: `Revoked lane-scoped ${lease.role} tool lease`,
        status: 'passed',
        evidence: {
          leaseId: lease.id,
          role: lease.role,
          reason: String(reason || 'lane_terminal').slice(0, 120),
          tokenHashPrefix: String(lease.tokenHash || '').slice(0, 12),
        },
      });
    }
    if (revoked.length && persist) this.persistState();
    return revoked.map((lease) => this.publicToolLease(lease));
  },

  // Admin-only revocation by lease id (the operator lists leases and revokes one;
  // they never hold the raw token). Idempotent on an already-revoked lease; the
  // hashed token is left in place so any in-flight agent call fails closed at
  // validateToolLease ("Tool lease has been revoked."). Audit item H2.
  revokeToolLease(leaseId, { actor = 'dashboard' } = {}) {
    const id = String(leaseId || '').trim();
    if (!id) {
      throw { status: 422, message: 'Tool lease id is required.' };
    }
    const lease = this.toolLeases.find((item) => item.id === id);
    if (!lease) {
      throw { status: 404, message: 'Tool lease not found.' };
    }
    if (isRefreshCredential(lease)) {
      // Revoking a credential revokes everything it issued, at once.
      if (this._revokeCredentialTree(lease, { actor, reason: 'revoked' }).length) this.persistState();
      return this.publicToolLease(lease);
    }
    if (!lease.revokedAt) {
      lease.revokedAt = new Date().toISOString();
      this.recordAudit({
        type: 'agent_tool_lease_revoked',
        actor: String(actor || 'dashboard').slice(0, 120),
        projectId: lease.projectId,
        sessionId: lease.sessionId,
        laneId: lease.laneId,
        summary: `Revoked ${lease.role} tool lease`,
        status: 'passed',
        evidence: {
          leaseId: lease.id,
          role: lease.role,
          tokenHashPrefix: String(lease.tokenHash || '').slice(0, 12),
        },
      });
      this.persistState();
    }
    return this.publicToolLease(lease);
  },

  validateToolLease(leaseToken, {
    toolId = null,
    projectId = null,
    sessionId = null,
    laneId = null,
    role = null,
  } = {}) {
    const token = String(leaseToken || '').trim();
    if (!token) {
      throw { status: 401, message: 'Tool lease token is required.' };
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const lease = this.toolLeases.find((item) => item.tokenHash === tokenHash);
    // A refresh credential is never a tool lease: it can only be exchanged for one.
    if (!lease || isRefreshCredential(lease)) {
      throw { status: 401, message: 'Tool lease not found.' };
    }
    if (lease.revokedAt) {
      throw { status: 401, message: 'Tool lease has been revoked.' };
    }
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      throw { status: 401, message: 'Tool lease has expired.' };
    }
    if (role && lease.role !== String(role).trim().toLowerCase()) {
      throw { status: 403, message: 'Tool lease role mismatch.' };
    }
    if (toolId && !safeArray(lease.allowedTools).includes(toolId)) {
      throw { status: 403, message: 'Tool lease does not grant this tool.' };
    }
    const leaseScope = this._resolveToolLeaseScope(lease, { allowMissing: true });
    const requestedScope = this._resolveToolLeaseScope({ projectId, sessionId, laneId }, { allowMissing: true });
    if (requestedScope.projectId && leaseScope.projectId && leaseScope.projectId !== requestedScope.projectId) {
      throw { status: 403, message: 'Tool lease project mismatch.' };
    }
    if (requestedScope.sessionId && leaseScope.sessionId && leaseScope.sessionId !== requestedScope.sessionId) {
      throw { status: 403, message: 'Tool lease session mismatch.' };
    }
    if (requestedScope.laneId && leaseScope.laneId && leaseScope.laneId !== requestedScope.laneId) {
      throw { status: 403, message: 'Tool lease lane mismatch.' };
    }
    const now = Date.now();
    lease.lastUsedAt = new Date(now).toISOString();
    if (this._renewIfDue(lease, now)) {
      // Using a lease also keeps the credential it came from alive.
      const parent = lease.parentId ? this.toolLeases.find((item) => item.id === lease.parentId) : null;
      if (parent) this._renewIfDue(parent, now);
      this.persistState();
    }
    return this.publicToolLease(lease);
  },

  assertAgentToolAllowed(toolId, { laneId } = {}) {
    const legal = LANE_TOOL_STATE_GATES[toolId];
    if (!legal) return true;
    const lane = laneId ? this.getLane(laneId) : null;
    if (!lane) throw { status: 404, message: 'Lane not found for tool call.' };
    if (legal.includes(lane.state)) return true;
    const nextAction = buildNextActionEnvelope(this, {
      role: 'executor',
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
    });
    throw {
      status: 409,
      message: `Tool "${toolId}" is not allowed while lane is "${lane.state}". Expected lane state in: ${legal.join(', ')}.`,
      nextAction,
    };
  },

  serverBaseUrl() {
    const host = process.env.ORCA_HOST && process.env.ORCA_HOST !== '0.0.0.0'
      ? process.env.ORCA_HOST
      : '127.0.0.1';
    // The port we actually bound (set by startServer) beats the configured one:
    // PORT=0 means "pick a free port", so echoing it hands agents a dead URL.
    const port = this.boundPort || process.env.PORT || '3000';
    return `http://${host}:${port}`;
  },

  // Ensure a lane has a scoped tool lease + runtime env so the built-in Orca
  // MCP server (auto-injected into the lane's MCP config) can call workflow
  // tools on the agent's behalf. Orchestrator lanes are already leased.
  ensureLaneToolLease(lane) {
    const key = String(lane.id);
    const existing = this.laneRuntimeEnv.get(key) || {};
    const role = lane.owner === 'orchestrator' ? 'orchestrator'
      : lane.owner === 'auditor' ? 'auditor'
        : 'executor';
    if (existing.ORCA_TOOL_LEASE_TOKEN) {
      try {
        this.validateToolLease(existing.ORCA_TOOL_LEASE_TOKEN, {
          role,
          projectId: lane.projectId,
          sessionId: lane.sessionId,
          laneId: lane.id,
        });
        return existing;
      } catch {
        this.laneRuntimeEnv.delete(key);
      }
    }
    const allowedTools = availableToolIdsForRole(role);
    if (!allowedTools.length) return existing;
    const lease = this.createToolLease({
      role,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      allowedTools,
      ttlMs: 24 * 60 * 60 * 1000,
      actor: 'lane-bootstrap',
    });
    const next = {
      ...existing,
      ORCA_TOOL_LEASE_TOKEN: lease.leaseToken,
      ORCA_AGENT_TOOLS_BASE_URL: this.serverBaseUrl(),
      ORCA_ROLE: role,
    };
    this.laneRuntimeEnv.set(key, next);
    return next;
  },

  // Mint an orchestrator-scoped tool lease and emit ready-to-paste MCP config so
  // an external desktop app (Codex app, Claude Desktop) can drive Orca as the
  // orchestrator — full orchestrator toolset, never the raw API token. The lease
  // is unbound by lane (an external orchestrator works session/project-wide) and
  // optionally scoped to one project/session. Privileged: callers must hold full
  // API auth (this hands out a powerful credential).
  createOrchestratorMcpBootstrap({
    role = 'orchestrator',
    projectId = null,
    sessionId = null,
    ttlMs = 12 * 60 * 60 * 1000,
    actor = 'desktop-app',
    nodePath = null,
  } = {}) {
    const normalizedRole = String(role || 'orchestrator').trim().toLowerCase();
    // v2 mints only orchestrator MCP bootstraps. The `role` param + this
    // list-shaped validator are the re-add seam: to reintroduce a read-only tier
    // later, add it to ROLES and widen this list.
    if (!['orchestrator'].includes(normalizedRole)) {
      throw { status: 422, message: 'MCP bootstrap role must be orchestrator.' };
    }
    const allowedTools = availableToolIdsForRole(normalizedRole);
    if (!allowedTools.length) {
      throw { status: 500, message: `No ${normalizedRole} tools are available to lease.` };
    }
    // Check everything the config needs BEFORE any credential changes. Minting
    // replaces this actor's live lease for the same scope (replaceActiveForActor),
    // so a bootstrap that failed after minting would revoke a working client's
    // lease and strand a new one whose token nobody received. resolveMcpLauncher
    // checks the Node and bridge on disk; the dry build proves the rest of the
    // config formats, with a placeholder where the token will go.
    const launcher = resolveMcpLauncher({ nodePath });
    const baseUrl = this.serverBaseUrl();
    const buildConfig = (fields) => buildOrchestratorMcpConfigs({
      baseUrl,
      role: normalizedRole,
      dashboardUrl: baseUrl,
      nodePath: launcher.runtime.nodePath,
      serverPath: launcher.serverPath,
      runtime: launcher.runtime,
      ...fields,
    });
    buildConfig({ refreshToken: 'not-yet-issued', projectId, sessionId });

    const isLive = (item) => !item.revokedAt && Date.parse(item.expiresAt) > Date.now();
    const liveBefore = new Set((this.toolLeases || []).filter(isLive).map((item) => item.id));
    // The client config carries a refresh credential, never a lease: the bridge
    // exchanges it for leases as it needs them, so a lapsed lease heals itself.
    // Issuing it replaces this actor's previous credential for the same scope.
    const { credential, refreshToken } = this._issueRefreshCredential({
      role: normalizedRole,
      projectId,
      sessionId,
      actor,
      leaseTtlMs: ttlMs,
    });
    // One lease is issued with it for direct HTTP use (scripts, curl). Client
    // configs do not carry it. replaceActiveForActor also retires this actor's
    // leases from before refresh credentials existed.
    const { lease, leaseToken } = this.createToolLease({
      role: normalizedRole,
      projectId: credential.projectId,
      sessionId: credential.sessionId,
      allowedTools,
      ttlMs: credential.leaseTtlMs,
      actor: credential.actor,
      replaceActiveForActor: true,
      parentId: credential.id,
    });
    // Reported, not decided here: which live leases and credentials this revoked.
    const revokedNow = (this.toolLeases || []).filter((item) => liveBefore.has(item.id) && item.revokedAt);
    const replacedLeaseIds = revokedNow.filter((item) => !isRefreshCredential(item)).map((item) => item.id);
    const replacedCredentialIds = revokedNow.filter(isRefreshCredential).map((item) => item.id);
    const bootstrap = buildConfig({
      refreshToken,
      projectId: credential.projectId,
      sessionId: credential.sessionId,
      lease: { id: lease.id, actor: lease.actor, expiresAt: lease.expiresAt, replacedLeaseIds },
      credential: {
        id: credential.id,
        actor: credential.actor,
        leaseTtlMs: credential.leaseTtlMs,
        expiresAt: credential.expiresAt,
        replacedCredentialIds,
      },
    });
    this.recordAudit({
      type: `${normalizedRole}_mcp_bootstrap_created`,
      actor: String(actor || 'desktop-app').slice(0, 120),
      projectId: lease.projectId,
      sessionId: lease.sessionId,
      summary: `Issued external ${normalizedRole} MCP bootstrap`,
      status: 'passed',
      evidence: {
        leaseId: lease.id,
        credentialId: credential.id,
        toolCount: allowedTools.length,
        expiresAt: lease.expiresAt,
        leaseTtlMs: credential.leaseTtlMs,
        scopedProject: Boolean(lease.projectId),
        scopedSession: Boolean(lease.sessionId),
        replacedLeaseIds,
        replacedCredentialIds,
        nodeSource: launcher.runtime.source,
      },
    });
    return {
      lease,
      // Both tokens are returned ONCE here and never persisted in plaintext. The
      // refresh credential is what the client configs below carry.
      leaseToken,
      credential: this.publicToolLease(credential),
      refreshToken,
      bootstrap,
    };
  },
};
