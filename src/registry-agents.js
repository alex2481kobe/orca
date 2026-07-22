// Agent and orchestrator registration, ownership, and liveness behavior as a
// prototype mixin for OrcaRegistry.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathWithinBoundary, nowIso, clonePayload } from './registry-utils.js';
import { safeRmRecursive } from './safe-fs.js';
import { buildNextActionEnvelope, findTool } from './agent-tools.js';
import { renderLaneTree } from './render-lane-tree.js';
import { normalizeApprovedCapacity, normalizeSpawnPolicy } from './registry-lane-config.js';

const ORCHESTRATOR_STALE_MS = 15 * 60 * 1000;
// v2: the orchestrator RECORD is the only container. Capacity the legacy
// session-container bridge used to fabricate now lives on the record itself.
const DEFAULT_ORCHESTRATOR_CAPACITY = 4;
// Mutating orchestrator tools that stay callable regardless of ownership: you
// register/update/resign to change ownership, and spawn executors under the
// orchestrator you own.
const OWNERSHIP_EXEMPT_TOOLS = new Set([
  'orchestrator.enroll',
  'orchestrator.resign',
  'orchestrator.register',
  'orchestrator.update',
  'executor.spawn',
]);

export const agentMethods = {
  async _findOrCreateProject(cwd) {
    if (!Array.isArray(this.projects)) this.projects = [];
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw { status: 400, message: 'cwd is required.' };
    }

    let realCwd;
    try {
      realCwd = await fs.realpath(cwd);
    } catch {
      throw { status: 422, message: 'cwd must be an existing directory.' };
    }

    const roots = this.getApprovedRepoRoots();
    if (!roots.some((root) => realCwd === root || isPathWithinBoundary(realCwd, root))) {
      throw { status: 422, message: 'cwd is outside the approved repo roots.' };
    }

    const existing = this.projects.find((project) => project.cwd === realCwd);
    if (existing) return existing;

    const now = nowIso();
    const project = {
      id: `prj_${createHash('sha256').update(realCwd).digest('hex').slice(0, 12)}`,
      cwd: realCwd,
      name: path.basename(realCwd),
      parentName: path.basename(path.dirname(realCwd)),
      createdAt: now,
      lastActivityAt: now,
    };
    this.projects.push(project);
    return project;
  },

  async registerOrchestrator({ cwd, actor, title = null, focus = null, takeoverOrchestratorId = null } = {}, { leaseId, source = 'mcp' } = {}) {
    if (!Array.isArray(this.orchestrators)) this.orchestrators = [];
    if (!Array.isArray(this.projects)) this.projects = [];
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw { status: 400, message: 'cwd is required.' };
    }
    if (typeof actor !== 'string' || !actor.trim()) {
      throw { status: 400, message: 'actor is required.' };
    }
    if (typeof leaseId !== 'string' || !leaseId.trim()) {
      throw { status: 400, message: 'leaseId is required.' };
    }

    const project = await this._findOrCreateProject(cwd);

    if (takeoverOrchestratorId) {
      const orchestrator = this.orchestrators.find((item) => item.id === takeoverOrchestratorId);
      if (
        !orchestrator
        || orchestrator.projectId !== project.id
        || (!this._orchestratorStale(orchestrator) && !orchestrator.resignedAt)
      ) {
        throw { status: 409, message: 'Orchestrator is not eligible for takeover.' };
      }
      const now = nowIso();
      orchestrator.leaseId = leaseId;
      orchestrator.resignedAt = null;
      orchestrator.lastSeenAt = now;
      project.lastActivityAt = now;
      return orchestrator;
    }

    const reusable = this.orchestrators
      .map((orchestrator, index) => ({ orchestrator, index }))
      .filter(({ orchestrator }) => orchestrator.projectId === project.id
        && orchestrator.actor === actor
        && this._orchestratorStale(orchestrator))
      .sort((left, right) => {
        const leftTime = Date.parse(left.orchestrator.registeredAt || 0);
        const rightTime = Date.parse(right.orchestrator.registeredAt || 0);
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return rightTime - leftTime;
        }
        if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
          return Number.isFinite(rightTime) ? 1 : -1;
        }
        return right.index - left.index;
      })[0]?.orchestrator;
    if (reusable) {
      reusable.leaseId = leaseId;
      reusable.resignedAt = null;
      reusable.lastSeenAt = nowIso();
      if (title !== null) reusable.title = title;
      if (focus !== null) reusable.focus = focus;
      return reusable;
    }

    const now = nowIso();
    const orchestrator = {
      id: `orc_${randomUUID()}`,
      projectId: project.id,
      leaseId,
      actor,
      title,
      focus,
      source,
      registeredAt: now,
      lastSeenAt: now,
      titleUpdatedAt: title !== null ? now : null,
      resignedAt: null,
      // Container capacity lives on the record now (was fabricated by the old
      // session bridge). Settable via orchestrator.update.
      approvedCapacity: DEFAULT_ORCHESTRATOR_CAPACITY,
      laneConcurrencyLimit: DEFAULT_ORCHESTRATOR_CAPACITY,
      spawnPolicy: 'auto',
    };
    this.orchestrators.push(orchestrator);
    project.lastActivityAt = now;
    return orchestrator;
  },

  updateOrchestrator(orchestratorId, { title, focus, approvedCapacity, laneConcurrencyLimit, spawnPolicy } = {}, { leaseId } = {}) {
    if (!Array.isArray(this.orchestrators)) this.orchestrators = [];
    if (!Array.isArray(this.projects)) this.projects = [];
    const orchestrator = this.orchestrators.find((item) => item.id === orchestratorId);
    if (!orchestrator) {
      throw { status: 404, message: 'Orchestrator not found.' };
    }
    if (orchestrator.leaseId !== leaseId) {
      throw { status: 403, message: 'Lease does not own this orchestrator.' };
    }

    const now = nowIso();
    if (title !== undefined) {
      if (orchestrator.title !== title) orchestrator.titleUpdatedAt = now;
      orchestrator.title = title;
    }
    if (focus !== undefined) orchestrator.focus = focus;
    // Container capacity is settable on the record (replaces the old session
    // updateSession capacity fields).
    if (laneConcurrencyLimit !== undefined) {
      orchestrator.laneConcurrencyLimit = normalizeApprovedCapacity(laneConcurrencyLimit, DEFAULT_ORCHESTRATOR_CAPACITY);
      if (!orchestrator.approvedCapacity || orchestrator.approvedCapacity < orchestrator.laneConcurrencyLimit) {
        orchestrator.approvedCapacity = orchestrator.laneConcurrencyLimit;
      }
    }
    if (approvedCapacity !== undefined) {
      orchestrator.approvedCapacity = normalizeApprovedCapacity(approvedCapacity, DEFAULT_ORCHESTRATOR_CAPACITY);
    }
    if (spawnPolicy !== undefined) {
      orchestrator.spawnPolicy = normalizeSpawnPolicy(spawnPolicy, 'auto');
    }
    orchestrator.lastSeenAt = now;
    const project = this.projects.find((item) => item.id === orchestrator.projectId);
    if (project) project.lastActivityAt = now;
    return orchestrator;
  },

  resignOrchestrator(orchestratorId, { reason = 'resigned' } = {}, { leaseId } = {}) {
    if (!Array.isArray(this.orchestrators)) this.orchestrators = [];
    const orchestrator = this.orchestrators.find((item) => item.id === orchestratorId);
    if (!orchestrator) {
      throw { status: 404, message: 'Orchestrator not found.' };
    }
    if (orchestrator.leaseId !== leaseId) {
      throw { status: 403, message: 'Lease does not own this orchestrator.' };
    }

    orchestrator.resignedAt = nowIso();
    return orchestrator;
  },

  touchOrchestrator(orchestratorId, { leaseId } = {}) {
    if (!Array.isArray(this.orchestrators)) this.orchestrators = [];
    if (!Array.isArray(this.projects)) this.projects = [];
    const orchestrator = this.orchestrators.find((item) => item.id === orchestratorId);
    if (!orchestrator) {
      throw { status: 404, message: 'Orchestrator not found.' };
    }
    if (orchestrator.leaseId !== leaseId) {
      throw { status: 403, message: 'Lease does not own this orchestrator.' };
    }

    const now = nowIso();
    orchestrator.lastSeenAt = now;
    const project = this.projects.find((item) => item.id === orchestrator.projectId);
    if (project) project.lastActivityAt = now;
    return orchestrator;
  },

  _orchestratorStale(orchestrator) {
    if (!orchestrator || orchestrator.resignedAt) return true;
    if (orchestrator.leaseId && orchestrator.leaseId !== 'dashboard') {
      const status = this._leaseActiveById(orchestrator.leaseId);
      if (!status || !status.active) return true;
    }

    const idleTooLong = Date.now() - Date.parse(orchestrator.lastSeenAt) > ORCHESTRATOR_STALE_MS;
    if (!idleTooLong) return false;
    const hasLiveLane = (this.lanes || []).some((lane) => lane.orchestratorId === orchestrator.id
      && ['queued', 'starting', 'running', 'needs_critique', 'ready_for_audit', 'auditing', 'fix_requested'].includes(lane.state));
    return !hasLiveLane;
  },

  // THE load-bearing seam. v2 has no session records: an executor lane's
  // container IS the orchestrator record (workdir = its project's cwd). Return a
  // session-shaped, launchable container view for an orchestrator id so the
  // shared lane lifecycle (scheduler, audit, settings, tool-lease scoping, agent
  // events) keeps working without a backing session. Orchestrator ids are
  // prefixed (orc_) and never collide with anything else. Unknown id -> undefined.
  getSession(locator) {
    const orch = (this.orchestrators || []).find((item) => item.id === locator);
    if (!orch) return undefined;
    const project = (this.projects || []).find((item) => item.id === orch.projectId);
    return {
      id: orch.id,
      projectId: orch.projectId,
      orchestratorId: orch.id,
      name: orch.title || orch.actor || orch.id,
      repoRoot: project?.cwd || '',
      critiqueMode: 'none',
      // 'off' keeps createLane's default per-lane isolation for git repos
      // (isolated worktrees) while never forcing shared mode.
      worktreeMode: 'off',
      spawnPolicy: normalizeSpawnPolicy(orch.spawnPolicy, 'auto'),
      approvedCapacity: normalizeApprovedCapacity(orch.approvedCapacity, DEFAULT_ORCHESTRATOR_CAPACITY),
      laneConcurrencyLimit: normalizeApprovedCapacity(orch.laneConcurrencyLimit, DEFAULT_ORCHESTRATOR_CAPACITY),
      artifactRetentionDays: null,
      _orchestratorContainer: true,
    };
  },

  // Exclusive-ownership enforcement for lease-authed mutating calls, invoked from
  // the server's agent-tool gate. v2 model: the orchestrator RECORD is the owner.
  // Grant iff the calling lease owns the orchestrator container (sessionId is the
  // orc_ id) and it hasn't resigned or gone stale. Reads + the exempt tools are
  // always allowed; a lease that doesn't own it is refused with a 409 + nextAction.
  assertOrchestratorOwnership({ toolId, sessionId, lease } = {}) {
    if (!toolId || !sessionId || !lease) return;
    if (String(lease.role) !== 'orchestrator') return; // executor/auditor are lane-scoped
    if (OWNERSHIP_EXEMPT_TOOLS.has(toolId)) return;
    const tool = findTool(toolId);
    if (!tool || !tool.mutating) return; // reads are always allowed
    const orch = (this.orchestrators || []).find((item) => item.id === sessionId);
    if (!orch) return; // no orchestrator container -> nothing to own
    if (orch.leaseId === lease.id && !orch.resignedAt && !this._orchestratorStale(orch)) {
      // Caller owns it; keep it fresh so it doesn't go stale mid-run.
      orch.lastSeenAt = nowIso();
      return;
    }
    const nextAction = buildNextActionEnvelope(this, {
      role: 'orchestrator',
      projectId: orch.projectId,
      sessionId: orch.id,
    });
    if (orch.leaseId && orch.leaseId !== lease.id && !orch.resignedAt && !this._orchestratorStale(orch)) {
      throw {
        status: 409,
        message: `You are not the active orchestrator for this work (held by ${orch.actor || orch.leaseId}). Register (orchestrator.register with takeoverOrchestratorId) before mutating it.`,
        nextAction,
      };
    }
    throw {
      status: 409,
      message: 'No active orchestrator is registered for this work. Call orchestrator.register before mutating it.',
      nextAction,
    };
  },

  // The canonical "what is happening" view for an orchestrator container:
  // ownership + the lane tree + flow + next required tool. Read-only.
  orchestratorStatus(orchestratorLocator) {
    const orch = (this.orchestrators || []).find((item) => item.id === orchestratorLocator);
    if (!orch) throw { status: 404, message: 'Orchestrator not found.' };
    const lanes = this.listLanesCompact(orch.id);
    const envelope = buildNextActionEnvelope(this, {
      role: 'orchestrator',
      projectId: orch.projectId,
      sessionId: orch.id,
      lean: true,
    });
    const name = orch.title || orch.actor || orch.id;
    const tree = renderLaneTree({ name }, lanes);
    const stale = this._orchestratorStale(orch);
    return clonePayload({
      orchestratorId: orch.id,
      sessionId: orch.id,
      sessionName: name,
      activeOrchestrator: {
        active: !orch.resignedAt && !stale,
        actor: orch.actor || null,
        leaseId: orch.leaseId || null,
        role: 'orchestrator',
        source: orch.source || 'mcp',
        registeredAt: orch.registeredAt || null,
        lastSeenAt: orch.lastSeenAt || null,
        stale,
      },
      flow: envelope.flow,
      capacity: envelope.capacity,
      nextRequiredTool: envelope.nextRequiredTool,
      lanes,
      tree,
    });
  },

  // Best-effort teardown of one orchestrator container's lane: kill any live
  // child first, then drop the lane record + reclaim its managed git worktree.
  async _cleanupContainerLane(laneId, { actor = 'dashboard' } = {}) {
    if (typeof this.stopLane === 'function') {
      try { await this.stopLane(laneId, { actor, approved: true }); } catch { /* best effort */ }
    }
    if (typeof this.clearLaneExecutor === 'function') this.clearLaneExecutor(laneId);
    this.laneRuntimeEnv?.delete(String(laneId));
    if (typeof this.removeLaneWorktree === 'function') {
      try { await this.removeLaneWorktree(laneId, { actor, approved: true, removeBranch: false }); } catch { /* best effort */ }
    }
  },

  // Permanently delete an ARCHIVED project and every orchestrator container under
  // it (with their lanes + managed worktrees). Orchestrator-native replacement for
  // the deleted session-based deleteProject; keeps the safe-fs worktree-root guard.
  async deleteProject(projectLocator, { actor = 'dashboard', approved = false } = {}) {
    const project = this.projects.find((entry) => entry.id === projectLocator || entry.slug === projectLocator);
    if (!project) throw { status: 404, message: 'Project not found.' };
    const policyCheck = this.evaluateActionPolicy('deleteProject', { approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    if (project.state !== 'archived') {
      throw { status: 422, message: 'Archive the project before permanently deleting it.' };
    }
    const orchestrators = (this.orchestrators || []).filter((orch) => orch.projectId === project.id);
    let lanesRemoved = 0;
    for (const orch of orchestrators) {
      const laneIds = (this.lanes || []).filter((lane) => lane.sessionId === orch.id).map((lane) => lane.id);
      for (const laneId of laneIds) {
        await this._cleanupContainerLane(laneId, { actor });
      }
      lanesRemoved += laneIds.length;
      this.lanes = (this.lanes || []).filter((lane) => lane.sessionId !== orch.id);
      // Guarded: only removes a path strictly inside workspacesRoot and never a
      // git repo root — so a bad workspace path can never delete a working tree.
      const workspace = path.join(this.workspacesRoot, orch.id);
      try { await safeRmRecursive(workspace, this.workspacesRoot); } catch { /* best effort */ }
    }
    this.orchestrators = (this.orchestrators || []).filter((orch) => orch.projectId !== project.id);
    this.projects = this.projects.filter((entry) => entry.id !== project.id);
    this.recordAudit({
      type: 'project_deleted',
      actor,
      projectId: project.id,
      summary: `Permanently deleted project "${project.name}"`,
      evidence: { projectId: project.id, orchestratorsRemoved: orchestrators.length, lanesRemoved },
      status: 'passed',
    });
    this.persistState();
    return { deleted: true, id: project.id };
  },
};
