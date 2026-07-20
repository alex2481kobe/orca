// Agent and orchestrator registration, ownership, and liveness behavior as a
// prototype mixin for OrcaRegistry.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathWithinBoundary, nowIso } from './registry-utils.js';

const ORCHESTRATOR_STALE_MS = 15 * 60 * 1000;

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
    };
    this.orchestrators.push(orchestrator);
    project.lastActivityAt = now;
    return orchestrator;
  },

  updateOrchestrator(orchestratorId, { title, focus } = {}, { leaseId } = {}) {
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
};
