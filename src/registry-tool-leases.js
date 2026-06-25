// Agent tool-lease lifecycle + tool-state gating, as a prototype mixin for
// OrcaRegistry. Extracted from registry.js to keep the core class focused.
//
// These are methods (they use `this`) collected into one object and merged onto
// OrcaRegistry.prototype via Object.assign, so the public API is unchanged
// (registry.createToolLease(...) etc.) and they call sibling methods via `this`.

import { createHash, randomUUID } from 'node:crypto';
import { safeArray } from './registry-utils.js';
import { availableToolIdsForRole, buildNextActionEnvelope } from './agent-tools.js';
import { ROLES } from './agent-tools/contract.js';
import { buildOrchestratorMcpConfigs } from './mcp-orchestrator-bootstrap.js';

// Authoritative workflow gates: lane states in which each agent tool is legal.
// Enforced only on the agent (tool-lease) path so out-of-order/skipped/stale
// calls are refused with a nextAction envelope. Only the core lifecycle is gated;
// flexible ops (stop/retry/controls/evidence) stay ungated.
export const LANE_TOOL_STATE_GATES = {
  'lane.submit': ['starting', 'running', 'needs_critique'],
  'critique.bundle.create': ['needs_critique'],
  'critique.findings.record': ['needs_critique'],
  'audit.queue_one': ['ready_for_audit', 'done'],
  'audit.findings.record': ['ready_for_audit', 'auditing', 'done'],
  'audit.accept': ['ready_for_audit', 'auditing', 'done'],
  'audit.request_fix': ['ready_for_audit', 'auditing', 'done'],
  'audit.block': ['ready_for_audit', 'auditing', 'done'],
};

export const toolLeaseMethods = {
  createToolLease({
    role = 'orchestrator',
    projectId = null,
    sessionId = null,
    laneId = null,
    allowedTools = [],
    ttlMs = 15 * 60 * 1000,
    actor = 'dashboard',
    replaceActiveForActor = false,
  } = {}) {
    const normalizedRole = String(role || 'orchestrator').trim().toLowerCase() || 'orchestrator';
    if (!ROLES.has(normalizedRole)) {
      throw { status: 422, message: 'Tool lease role must be supervisor, orchestrator, executor, auditor, critique, or dashboard.' };
    }
    const project = projectId ? this.getProject(projectId) : null;
    if (projectId && !project) {
      throw { status: 404, message: 'Project not found for tool lease.' };
    }
    const session = sessionId ? this.getSession(sessionId) : null;
    if (sessionId && !session) {
      throw { status: 404, message: 'Session not found for tool lease.' };
    }
    const lane = laneId ? this.getLane(laneId) : null;
    if (laneId && !lane) {
      throw { status: 404, message: 'Lane not found for tool lease.' };
    }
    const laneSession = lane ? this.getSession(lane.sessionId) : null;
    if (session && project && session.projectId !== project.id) {
      throw { status: 422, message: 'Tool lease session does not belong to the requested project.' };
    }
    if (lane && session && lane.sessionId !== session.id) {
      throw { status: 422, message: 'Tool lease lane does not belong to the requested session.' };
    }
    if (lane && project && lane.projectId !== project.id) {
      throw { status: 422, message: 'Tool lease lane does not belong to the requested project.' };
    }
    if (lane && !laneSession) {
      throw { status: 422, message: 'Tool lease lane session is missing.' };
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
    const ttl = Math.max(30 * 1000, Math.min(24 * 60 * 60 * 1000, Number.parseInt(ttlMs, 10) || 15 * 60 * 1000));
    const leaseToken = `${randomUUID()}-${randomUUID()}`;
    const tokenHash = createHash('sha256').update(leaseToken).digest('hex');
    const now = Date.now();
    const normalizedActor = String(actor || 'dashboard').slice(0, 120);
    if (replaceActiveForActor) {
      const revokedAt = new Date(now).toISOString();
      for (const existing of this.toolLeases || []) {
        if (existing.revokedAt) continue;
        if (Date.parse(existing.expiresAt) <= now) continue;
        if (existing.role !== normalizedRole) continue;
        if (existing.actor !== normalizedActor) continue;
        if ((existing.projectId || null) !== (project?.id || null)) continue;
        if ((existing.sessionId || null) !== (session?.id || null)) continue;
        if ((existing.laneId || null) !== (lane?.id || null)) continue;
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
      projectId: project?.id || null,
      sessionId: session?.id || null,
      laneId: lane?.id || null,
      allowedTools: normalizedAllowedTools,
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
      expiresAt: new Date(now + ttl).toISOString(),
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
    return {
      id: lease.id,
      role: lease.role,
      actor: lease.actor,
      projectId: lease.projectId,
      sessionId: lease.sessionId,
      laneId: lease.laneId,
      allowedTools: safeArray(lease.allowedTools),
      createdAt: lease.createdAt,
      lastUsedAt: lease.lastUsedAt || null,
      expiresAt: lease.expiresAt,
      revokedAt: lease.revokedAt || null,
      active: !lease.revokedAt && Date.parse(lease.expiresAt) > Date.now(),
    };
  },

  listToolLeases({ activeOnly = true } = {}) {
    const leases = this.toolLeases.map((lease) => this.publicToolLease(lease));
    return activeOnly ? leases.filter((lease) => lease.active) : leases;
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
    if (!lease) {
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
    if (toolId === 'project.create' && (lease.projectId || lease.sessionId || lease.laneId)) {
      throw { status: 403, message: 'Project creation requires an unscoped tool lease.' };
    }
    if (projectId && lease.projectId && lease.projectId !== projectId) {
      throw { status: 403, message: 'Tool lease project mismatch.' };
    }
    if (sessionId && lease.sessionId && lease.sessionId !== sessionId) {
      throw { status: 403, message: 'Tool lease session mismatch.' };
    }
    if (laneId && lease.laneId && lease.laneId !== laneId) {
      throw { status: 403, message: 'Tool lease lane mismatch.' };
    }
    lease.lastUsedAt = new Date().toISOString();
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
    const port = process.env.PORT || '3000';
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
    if (!['orchestrator', 'supervisor'].includes(normalizedRole)) {
      throw { status: 422, message: 'MCP bootstrap role must be orchestrator or supervisor.' };
    }
    const allowedTools = availableToolIdsForRole(normalizedRole);
    if (!allowedTools.length) {
      throw { status: 500, message: `No ${normalizedRole} tools are available to lease.` };
    }
    // createToolLease validates project/session existence + relationship.
    const { lease, leaseToken } = this.createToolLease({
      role: normalizedRole,
      projectId,
      sessionId,
      allowedTools,
      ttlMs,
      actor,
      replaceActiveForActor: true,
    });
    const baseUrl = this.serverBaseUrl();
    const bootstrap = buildOrchestratorMcpConfigs({
      baseUrl,
      leaseToken,
      role: normalizedRole,
      projectId: lease.projectId,
      sessionId: lease.sessionId,
      dashboardUrl: baseUrl,
      nodePath: nodePath || process.execPath,
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
        toolCount: allowedTools.length,
        expiresAt: lease.expiresAt,
        scopedProject: Boolean(lease.projectId),
        scopedSession: Boolean(lease.sessionId),
      },
    });
    return {
      lease,
      // leaseToken is returned ONCE here (never persisted in plaintext) so the
      // operator can paste it into the desktop app's config.
      leaseToken,
      bootstrap,
    };
  },
};
