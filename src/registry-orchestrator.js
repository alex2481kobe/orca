// Orchestrator chat thread + message-send methods, as a prototype mixin for
// OrcaRegistry. Extracted from registry.js.

import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload } from './registry-utils.js';
import { LANE_STATES } from './worker-contract.js';
import { buildNextActionEnvelope, findTool } from './agent-tools.js';
import { renderLaneTree } from './render-lane-tree.js';

const MAX_ORCHESTRATOR_THREAD_MESSAGES = 500;
const { RUNNING: RUNNING_STATE } = LANE_STATES;
// An active orchestrator that hasn't called a tool in this long is considered
// stale, so a fresh chat can take over without forcing an explicit takeover.
const ORCHESTRATOR_STALE_MS = 15 * 60 * 1000;
// Mutating orchestrator tools that must stay callable regardless of ownership:
// you call enroll/resign to change ownership, and create a session before one
// can have an owner.
const OWNERSHIP_EXEMPT_TOOLS = new Set([
  'orchestrator.enroll',
  'orchestrator.resign',
  'orchestrator.register',
  'orchestrator.update',
  'executor.spawn',
]);

export const orchestratorMethods = {
  ensureOrchestratorThread(session) {
    if (!session.orchestratorThread || typeof session.orchestratorThread !== 'object') {
      session.orchestratorThread = {
        id: randomUUID(),
        messages: [],
        laneIds: [],
        activeLaneId: null,
        executorType: null,
        updatedAt: nowIso(),
      };
    }
    if (!Array.isArray(session.orchestratorThread.messages)) {
      session.orchestratorThread.messages = [];
    }
    if (session.orchestratorThread.messages.length > MAX_ORCHESTRATOR_THREAD_MESSAGES) {
      session.orchestratorThread.messages = session.orchestratorThread.messages.slice(-MAX_ORCHESTRATOR_THREAD_MESSAGES);
    }
    if (!Array.isArray(session.orchestratorThread.laneIds)) {
      session.orchestratorThread.laneIds = [];
    }
    return session.orchestratorThread;
  },

  appendOrchestratorThreadMessage(thread, message) {
    if (!thread || !message) return;
    if (!Array.isArray(thread.messages)) {
      thread.messages = [];
    }
    thread.messages.push(message);
    if (thread.messages.length > MAX_ORCHESTRATOR_THREAD_MESSAGES) {
      thread.messages = thread.messages.slice(-MAX_ORCHESTRATOR_THREAD_MESSAGES);
    }
  },

  // --- Active-orchestrator ownership (enroll / resign / status) -------------
  // A chat driving Orca over MCP binds its already-issued orchestrator lease to a
  // session and claims the active-orchestrator marker, so a single owner is
  // visible and handoff (resign/takeover) is coordinated. enroll does NOT mint or
  // re-scope a lease — the lease is the identity; this only records ownership.

  _leaseActiveById(leaseId) {
    if (!leaseId || leaseId === 'dashboard') return null;
    const lease = (this.toolLeases || []).find((item) => item.id === leaseId);
    if (!lease) return { found: false, active: false };
    const active = !lease.revokedAt && Date.parse(lease.expiresAt) > Date.now();
    return { found: true, active, lease };
  },

  // Can an orchestrator actually act on an audit nudge for this session? Used to
  // reconcile orchestrator-tier audits stuck in 'auditing'. This deliberately does
  // NOT use _activeOrchestratorStale's idle-time check: a lane stuck in 'auditing'
  // itself counts as session activity there, which would circularly keep a dead
  // orchestrator looking "live". A dashboard orchestrator is treated as able to act
  // (the local operator can accept via the UI); an MCP orchestrator can act only
  // while its lease is alive.
  _orchestratorCanAudit(session) {
    const active = session?.orchestratorThread?.activeOrchestrator;
    if (!active) return false;
    if (active.leaseId === 'dashboard' || !active.leaseId) return true;
    const status = this._leaseActiveById(active.leaseId);
    return Boolean(status && status.active);
  },

  _activeOrchestratorStale(marker, session = null) {
    if (!marker) return true;
    // A dead/revoked/expired lease is always stale.
    if (marker.leaseId && marker.leaseId !== 'dashboard') {
      const status = this._leaseActiveById(marker.leaseId);
      if (!status || !status.active) return true;
    }
    const last = Date.parse(marker.lastSeenAt || marker.enrolledAt || 0);
    const idleTooLong = Number.isFinite(last) && (Date.now() - last) > ORCHESTRATOR_STALE_MS;
    if (!idleTooLong) return false;
    // Idle on Orca tools for a while — but a live owner whose lanes are still
    // running shouldn't lose the lock (a long build legitimately keeps the
    // orchestrator off the tool surface). Only a quiet, lane-less session is stale.
    if (session && (this.lanes || []).some((lane) => lane.sessionId === session.id
      && ['queued', 'starting', 'running', 'needs_critique', 'ready_for_audit', 'auditing', 'fix_requested'].includes(lane.state))) {
      return false;
    }
    return true;
  },

  publicActiveOrchestrator(marker, session = null) {
    if (!marker) return { active: false };
    return {
      active: true,
      actor: marker.actor || null,
      leaseId: marker.leaseId || null,
      role: marker.role || 'orchestrator',
      source: marker.source || 'mcp',
      enrolledAt: marker.enrolledAt || null,
      lastSeenAt: marker.lastSeenAt || null,
      stale: this._activeOrchestratorStale(marker, session),
    };
  },

  enrollOrchestrator(sessionLocator, { leaseId = 'dashboard', actor = 'orchestrator', source = 'mcp', takeover = false } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const thread = this.ensureOrchestratorThread(session);
    const current = thread.activeOrchestrator || null;
    if (current && current.leaseId !== leaseId && !this._activeOrchestratorStale(current, session)) {
      if (!takeover) {
        throw {
          status: 409,
          message: 'Session already has an active orchestrator. Pass takeover:true to take over.',
          current: this.publicActiveOrchestrator(current),
        };
      }
      this.recordAudit({
        type: 'orchestrator_resigned',
        actor: String(actor || 'orchestrator').slice(0, 120),
        projectId: session.projectId,
        sessionId: session.id,
        summary: `Orchestrator ${current.actor || current.leaseId} replaced by takeover`,
        status: 'passed',
        evidence: { reason: 'takeover', previousLeaseId: current.leaseId },
      });
    }
    const now = nowIso();
    thread.activeOrchestrator = {
      leaseId: leaseId || 'dashboard',
      actor: String(actor || 'orchestrator').slice(0, 120),
      role: 'orchestrator',
      source: String(source || 'mcp').slice(0, 24),
      enrolledAt: now,
      lastSeenAt: now,
    };
    thread.updatedAt = now;
    this.recordAudit({
      type: 'orchestrator_enrolled',
      actor: thread.activeOrchestrator.actor,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Orchestrator enrolled for session "${session.name}"`,
      status: 'passed',
      evidence: { leaseId: thread.activeOrchestrator.leaseId, source: thread.activeOrchestrator.source },
    });
    this.persistState();
    return {
      enrolled: true,
      activeOrchestrator: this.publicActiveOrchestrator(thread.activeOrchestrator),
      sessionId: session.id,
    };
  },

  resignOrchestrator(sessionLocator, { leaseId = 'dashboard', reason = 'resigned' } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const thread = this.ensureOrchestratorThread(session);
    const current = thread.activeOrchestrator || null;
    if (!current) return { released: false, sessionId: session.id };
    if (current.leaseId !== leaseId && leaseId !== 'dashboard') {
      throw { status: 403, message: 'Only the active orchestrator (or a dashboard operator) may resign this session.' };
    }
    thread.activeOrchestrator = null;
    thread.updatedAt = nowIso();
    this.recordAudit({
      type: 'orchestrator_resigned',
      actor: String(current.actor || 'orchestrator').slice(0, 120),
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Orchestrator resigned from session "${session.name}"`,
      status: 'passed',
      evidence: { reason: String(reason || 'resigned').slice(0, 200), leaseId: current.leaseId },
    });
    this.persistState();
    return { released: true, sessionId: session.id };
  },

  getActiveOrchestrator(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const thread = this.ensureOrchestratorThread(session);
    return this.publicActiveOrchestrator(thread.activeOrchestrator || null, session);
  },

  // Exclusive ownership enforcement: an external orchestrator lease must enroll
  // with the session before it can mutate session state. A different live owner
  // is refused, and a stale/missing owner must be refreshed through
  // orchestrator.enroll before work continues. Called from the server's
  // agent-tool gate for every lease-authed mutating call.
  assertOrchestratorOwnership({ toolId, sessionId, lease } = {}) {
    if (!toolId || !sessionId || !lease) return;
    if (String(lease.role) !== 'orchestrator') return; // executor/auditor are lane-scoped
    if (OWNERSHIP_EXEMPT_TOOLS.has(toolId)) return;
    const tool = findTool(toolId);
    if (!tool || !tool.mutating) return; // reads are always allowed
    const session = this.getSession(sessionId);
    if (!session) return;
    const thread = this.ensureOrchestratorThread(session);
    const marker = thread.activeOrchestrator;
    const nextAction = buildNextActionEnvelope(this, {
      role: 'orchestrator',
      projectId: session.projectId,
      sessionId: session.id,
    });
    if (!marker) {
      throw {
        status: 409,
        message: `No active orchestrator is registered for session "${session.name}". Call orchestrator.enroll before mutating it.`,
        nextAction,
      };
    }
    if (marker.leaseId === lease.id) {
      // Caller is the owner; keep it fresh so it doesn't go stale mid-run.
      marker.lastSeenAt = nowIso();
      return;
    }
    if (this._activeOrchestratorStale(marker, session)) {
      throw {
        status: 409,
        message: `The active orchestrator for session "${session.name}" is stale. Call orchestrator.enroll with takeover:true before mutating it.`,
        nextAction,
      };
    }
    throw {
      status: 409,
      message: `You are not the active orchestrator for session "${session.name}" (held by ${marker.actor || marker.leaseId}). Call orchestrator.enroll with takeover:true to take over before mutating it.`,
      nextAction,
    };
  },

  // The canonical "what is happening" view: ownership + the lane tree + flow and
  // the next required tool. Composes existing read helpers; read-only.
  orchestratorStatus(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const lanes = this.listLanesCompact(session.id);
    let backlog = null;
    try { backlog = this.sessionBacklogStatus(session.id); } catch { backlog = null; }
    const envelope = buildNextActionEnvelope(this, {
      role: 'orchestrator',
      projectId: session.projectId,
      sessionId: session.id,
      lean: true, // status is polled; skip the heavy capability matrix
    });
    const tree = renderLaneTree({ name: session.name }, lanes, { backlog: backlog || undefined });
    return clonePayload({
      sessionId: session.id,
      sessionName: session.name,
      activeOrchestrator: this.getActiveOrchestrator(session.id),
      supervisorReview: session.supervisorReview || null,
      backlog,
      flow: envelope.flow,
      capacity: envelope.capacity,
      nextRequiredTool: envelope.nextRequiredTool,
      lanes,
      tree,
    });
  },

};
