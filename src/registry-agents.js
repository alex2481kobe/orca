// Agent and orchestrator registration, ownership, and liveness behavior as a
// prototype mixin for OrcaRegistry.

import { OUTSIDE_FENCE_CODE } from './fence.js';
import { fixCommands } from './mcp-connection.js';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathWithinBoundary, nowIso, clonePayload } from './registry-utils.js';
import { safeRmRecursive } from './safe-fs.js';
import { buildNextActionEnvelope } from './agent-tools/next-action.js';
import { findTool } from './agent-tools/tool-definitions.js';
import { renderLaneTree } from './render-lane-tree.js';
import {
  DEFAULT_APPROVED_CAPACITY,
  normalizeApprovedCapacity,
  normalizeSpawnPolicy,
  resolveOrchestratorCapacity,
} from './registry-lane-config.js';

const ORCHESTRATOR_STALE_MS = 15 * 60 * 1000;
// v2: the orchestrator RECORD is the only container. Capacity the legacy
// session-container bridge used to fabricate now lives on the record itself.
//
// Mutating orchestrator tools that stay callable regardless of ownership: you
// register/update/resign to change ownership, and spawn executors under the
// orchestrator you own.
const OWNERSHIP_EXEMPT_TOOLS = new Set([
  'orchestrator.resign',
  'orchestrator.register',
  'executor.spawn',
]);

function requestedCapacity({ approvedCapacity, laneConcurrencyLimit } = {}, fallback = DEFAULT_APPROVED_CAPACITY) {
  const supplied = [approvedCapacity, laneConcurrencyLimit]
    .filter((value) => value !== undefined)
    .map((value) => normalizeApprovedCapacity(value, fallback));
  if (!supplied.length) return fallback;
  if (new Set(supplied).size > 1) {
    throw { status: 422, message: 'approvedCapacity and laneConcurrencyLimit must match when both are supplied.' };
  }
  return supplied[0];
}

function setOrchestratorCapacity(orchestrator, capacity) {
  orchestrator.approvedCapacity = capacity;
  orchestrator.laneConcurrencyLimit = capacity;
}

// What a re-registration on the same lease actually CHANGED. An agent is told to
// re-register with the same cwd to refresh its title/focus line, so most refreshes
// change nothing; auditing those would evict real history from the 200-entry ring.
function describeRegistrationChange(orchestrator, { title, focus, capacity }) {
  const changed = [];
  if (title !== null && orchestrator.title !== title) changed.push('title');
  if (focus !== null && orchestrator.focus !== focus) changed.push('focus');
  if (capacity !== undefined && resolveOrchestratorCapacity(orchestrator) !== capacity) changed.push('capacity');
  return changed;
}

export const agentMethods = {
  async _findOrCreateProject(cwd) {
    if (!Array.isArray(this.projects)) this.projects = [];
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw { status: 400, message: 'cwd is required.' };
    }

    // Not set up: refuse before looking at the directory, and say how to set up.
    const { roots } = this.assertFenceConfigured();

    let realCwd;
    try {
      realCwd = await fs.realpath(cwd);
    } catch {
      throw { status: 422, message: 'cwd must be an existing directory.' };
    }

    if (!roots.some((root) => realCwd === root || isPathWithinBoundary(realCwd, root))) {
      const fix = fixCommands.setup([...roots, realCwd]);
      throw {
        status: 422,
        code: OUTSIDE_FENCE_CODE,
        fix,
        message: `cwd is outside the approved repo roots: ${realCwd} is not under ${roots.join(', ')}. Agents cannot widen the fence. An operator adds it on the Orca workstation with: ${fix} — and then restarts Orca.`,
      };
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

  // THE ONE EXIT from registerOrchestrator. Every path that returns an
  // orchestrator goes through it, because every one of them mutated state that
  // has to reach disk.
  //
  // Before 2026-09-12 none of them did: registerOrchestrator created the project
  // record and the orchestrator record, pushed both onto the in-memory arrays,
  // and returned — never calling persistState. /api/health then truthfully
  // reported {"projects":1,"orchestrators":1} while state.json still said zero,
  // and the registration was gone at the next restart. It was INTERMITTENT, not
  // total: persistState is debounced and snapshots at FLUSH time, so a write some
  // other call had already scheduled would happen to carry the new record along.
  // On a quiet daemon (the shape the owner hit — connect, then register) there
  // was no such write, and the record was simply lost.
  //
  // The write also bumps the SSE stream revision, which is what makes a title or
  // a new agent appear on the dashboard without a restart.
  _commitOrchestratorRegistration(orchestrator, project, { actor, outcome, changed = [] } = {}) {
    // A container's own storage. ensureSessionWorkspaces() does this for the
    // whole store on restore, which meant a brand-new container had no
    // directories until the next restart — and it never survived one.
    this.ensureOrchestratorStorage(orchestrator);
    // No audit event for a refresh that changed nothing: an agent is told to
    // re-register to keep its title current, and auditing every one of those
    // would push real history out of the 200-entry ring.
    if (outcome) {
      const summaries = {
        registered: `Orchestrator "${orchestrator.title || orchestrator.actor}" registered for ${project.name}`,
        refreshed: `Orchestrator "${orchestrator.title || orchestrator.actor}" updated ${changed.join(', ')}`,
        reclaimed: `Orchestrator "${orchestrator.title || orchestrator.actor}" reclaimed a stale container in ${project.name}`,
        takeover: `Orchestrator "${orchestrator.title || orchestrator.actor}" taken over in ${project.name}`,
      };
      this.recordAudit({
        type: 'orchestrator_registered',
        actor: actor || orchestrator.actor || 'orchestrator',
        projectId: project.id,
        sessionId: orchestrator.id,
        summary: summaries[outcome] || summaries.registered,
        // leaseId is an identifier, never the lease TOKEN — the token is only
        // ever held as a hash (registry-tool-leases.js) and never audited.
        evidence: {
          orchestratorId: orchestrator.id,
          projectId: project.id,
          cwd: project.cwd,
          outcome,
          source: orchestrator.source || 'mcp',
          leaseId: orchestrator.leaseId,
          ...(changed.length ? { changed } : {}),
        },
        status: 'passed',
      });
    }
    // recordAudit persists too, but this is the guarantee the caller is owed and
    // it must not depend on whether an audit event was worth writing.
    this.persistState();
    return orchestrator;
  },

  async registerOrchestrator({
    cwd,
    actor,
    title = null,
    focus = null,
    takeoverOrchestratorId = null,
    approvedCapacity,
    laneConcurrencyLimit,
  } = {}, { leaseId, source = 'mcp' } = {}) {
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
      if (approvedCapacity !== undefined || laneConcurrencyLimit !== undefined) {
        setOrchestratorCapacity(orchestrator, requestedCapacity({ approvedCapacity, laneConcurrencyLimit }));
      }
      project.lastActivityAt = now;
      return this._commitOrchestratorRegistration(orchestrator, project, { actor, outcome: 'takeover' });
    }

    // Folded-in orchestrator.update: re-registering with the same cwd on a lease
    // that ALREADY owns a live orchestrator here is an idempotent refresh of the
    // self-authored title/focus line, not a second container. (The standalone
    // orchestrator.update tool and its PATCH route are gone.)
    //
    // 'dashboard' is NOT a real lease — it is the shared pseudo-id every
    // token/operator-authed caller gets — so it must never collapse two distinct
    // dashboard registrations into one container.
    const owned = leaseId === 'dashboard' ? null : this.orchestrators.find((item) => item.projectId === project.id
      && item.leaseId === leaseId
      && !item.resignedAt);
    if (owned) {
      const now = nowIso();
      const refreshCapacity = (approvedCapacity !== undefined || laneConcurrencyLimit !== undefined)
        ? requestedCapacity({ approvedCapacity, laneConcurrencyLimit })
        : undefined;
      const changed = describeRegistrationChange(owned, { title, focus, capacity: refreshCapacity });
      if (title !== null && owned.title !== title) owned.titleUpdatedAt = now;
      if (title !== null) owned.title = title;
      if (focus !== null) owned.focus = focus;
      if (refreshCapacity !== undefined) {
        setOrchestratorCapacity(owned, refreshCapacity);
      }
      owned.lastSeenAt = now;
      project.lastActivityAt = now;
      // A no-op refresh still has to WRITE (lastSeenAt is liveness) but earns no
      // audit event — hence outcome only when something actually changed.
      return this._commitOrchestratorRegistration(owned, project, {
        actor,
        outcome: changed.length ? 'refreshed' : null,
        changed,
      });
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
      if (approvedCapacity !== undefined || laneConcurrencyLimit !== undefined) {
        setOrchestratorCapacity(reusable, requestedCapacity({ approvedCapacity, laneConcurrencyLimit }));
      }
      project.lastActivityAt = reusable.lastSeenAt;
      return this._commitOrchestratorRegistration(reusable, project, { actor, outcome: 'reclaimed' });
    }

    const now = nowIso();
    const capacity = requestedCapacity({ approvedCapacity, laneConcurrencyLimit });
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
      // session bridge).
      approvedCapacity: capacity,
      laneConcurrencyLimit: capacity,
      spawnPolicy: 'auto',
    };
    this.orchestrators.push(orchestrator);
    project.lastActivityAt = now;
    return this._commitOrchestratorRegistration(orchestrator, project, { actor, outcome: 'registered' });
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
    if (laneConcurrencyLimit !== undefined || approvedCapacity !== undefined) {
      setOrchestratorCapacity(
        orchestrator,
        requestedCapacity(
          { approvedCapacity, laneConcurrencyLimit },
          resolveOrchestratorCapacity(orchestrator),
        ),
      );
    }
    if (spawnPolicy !== undefined) {
      orchestrator.spawnPolicy = normalizeSpawnPolicy(spawnPolicy, 'auto');
    }
    orchestrator.lastSeenAt = now;
    const project = this.projects.find((item) => item.id === orchestrator.projectId);
    if (project) project.lastActivityAt = now;
    // Same rule as the register path: a title/focus/capacity change that only
    // lives in memory is lost at the next restart, and never reaches the SSE
    // revision the dashboard diffs.
    this.persistState();
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
    // A resignation that does not reach disk brings the orchestrator back owning
    // work it walked away from, and blocks the takeover that was the point of it.
    this.persistState();
    return orchestrator;
  },

  // NOT persisted, deliberately. lastSeenAt is pure liveness and this is the
  // hottest orchestrator path there is: orchestrator.status polls it, and so does
  // the ownership check on every mutating tool call. Writing the whole state file
  // on each would be the write amplification appendLaneLog's `persist: false`
  // default already avoids. The cost of leaving it out is bounded and self-
  // healing: after a restart a live agent reads stale for at most one poll, then
  // its next register/update/mutation writes a fresh lastSeenAt. Every change
  // that is not liveness — register, update, resign — does persist.
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
      && ['queued', 'starting', 'running', 'ready_for_audit', 'auditing', 'fix_requested'].includes(lane.state));
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
    const capacity = resolveOrchestratorCapacity(orch);
    return {
      id: orch.id,
      projectId: orch.projectId,
      orchestratorId: orch.id,
      name: orch.title || orch.actor || orch.id,
      repoRoot: project?.cwd || '',
      // No forced worktree mode: omit it (undefined) so createLane's default
      // per-lane isolation for git repos stays in effect and the effective-settings
      // resolver treats it as "no override" rather than a fake mode.
      worktreeMode: undefined,
      spawnPolicy: normalizeSpawnPolicy(orch.spawnPolicy, 'auto'),
      approvedCapacity: capacity,
      laneConcurrencyLimit: capacity,
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
    // orch.leaseId records the owning identity: a lease id, or for a lease issued
    // by a refresh credential, the credential's id (publicToolLease ownerId). So
    // a lease that replaced a lapsed one still owns what the lapsed one owned.
    const ownerId = lease.ownerId || lease.id;
    if (orch.leaseId === ownerId && !orch.resignedAt && !this._orchestratorStale(orch)) {
      // Caller owns it; keep it fresh so it doesn't go stale mid-run.
      orch.lastSeenAt = nowIso();
      return;
    }
    const nextAction = buildNextActionEnvelope(this, {
      role: 'orchestrator',
      projectId: orch.projectId,
      sessionId: orch.id,
    });
    if (orch.leaseId && orch.leaseId !== ownerId && !orch.resignedAt && !this._orchestratorStale(orch)) {
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
  // ownership + the lane tree + flow + next required tool.
  //
  // Also absorbs the deleted orchestrator.heartbeat tool: when the CALLER's lease
  // owns this orchestrator, reading status refreshes lastSeenAt. Without that, a
  // read-only monitoring loop would let its own ownership go stale in ~15 min and
  // the container would be handed to a takeover.
  orchestratorStatus(orchestratorLocator, { leaseId = null } = {}) {
    const orch = (this.orchestrators || []).find((item) => item.id === orchestratorLocator);
    if (!orch) throw { status: 404, message: 'Orchestrator not found.' };
    if (leaseId && orch.leaseId === leaseId && !orch.resignedAt) {
      this.touchOrchestrator(orch.id, { leaseId });
    }
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
      // The project this orchestrator is bound to. Without it, an agent that polls
      // status but no longer holds its `orchestrator.register` response cannot call
      // project-scoped tools at all — `project.preview.set` (the live preview URLs
      // the README advertises) needs a projectId and there is no other way to get one.
      projectId: orch.projectId || null,
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
      // Every OTHER live orchestrator bound to this same project. A project can
      // carry more than one orchestrator record (one per lease), and each one's
      // lane tree shows only its own lanes — so without this an agent polling
      // status is told it owns the work while a second session holds the same
      // working tree. A writer lane is sole-writer across the PROJECT, so these
      // are the records whose writers can refuse your next direct lane, and the
      // stale ones are the records you may take over.
      coOrchestrators: (this.orchestrators || [])
        .filter((item) => item.projectId === orch.projectId
          && item.id !== orch.id
          && !item.resignedAt)
        .map((item) => ({
          orchestratorId: item.id,
          actor: item.actor || null,
          title: item.title || null,
          registeredAt: item.registeredAt || null,
          lastSeenAt: item.lastSeenAt || null,
          stale: this._orchestratorStale(item),
        })),
      flow: envelope.flow,
      capacity: envelope.capacity,
      nextRequiredTool: envelope.nextRequiredTool,
      lanes,
      // Lanes of this orchestrator retired to the archive: not in `lanes`, still
      // readable one by one with lane.get.
      archivedLanes: (this.archivedLanes || []).filter((entry) => entry.sessionId === orch.id).length,
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
