// Session CRUD + plan/attachment methods, as a prototype mixin for OrcaRegistry.
// Extracted from registry.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload, isPathWithinBoundary, ensureDirectorySync, parsePositiveInteger } from './registry-utils.js';
import {
  DEFAULT_APPROVED_CAPACITY,
  normalizeSpawnPolicy,
  normalizeApprovedCapacity,
  normalizeIdleShutdownMode,
  normalizeCritiqueMode,
} from './registry-lane-config.js';
import { sanitizeSettingsOverrides } from './effective-settings.js';
import { directoryExists, readRepoGitInfo } from './worktree-manager.js';

export const sessionMethods = {
  updateSession(locator, patch = {}, context = {}) {
    const session = this.getSession(locator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('updateSession', {
      actor,
      approved: context.approved,
    });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    if (patch.name && !String(patch.name).trim()) {
      throw { status: 422, message: 'Session name cannot be empty.' };
    }

    if (patch.state !== undefined) {
      const nextState = String(patch.state || '').trim();
      if (!['active', 'archived'].includes(nextState)) {
        throw { status: 422, message: 'Session state must be active or archived.' };
      }
      session.state = nextState;
    }

    if (patch.name) {
      session.name = String(patch.name).trim();
    }

    if (patch.laneConcurrencyLimit !== undefined) {
      const parsed = parsePositiveInteger(patch.laneConcurrencyLimit, null);
      if (parsed === null) {
        throw { status: 422, message: 'laneConcurrencyLimit must be a positive integer.' };
      }
      session.laneConcurrencyLimit = parsed;
      if (!session.approvedCapacity || session.approvedCapacity < parsed) {
        session.approvedCapacity = parsed;
      }
    }

    if (patch.approvedCapacity !== undefined) {
      const parsed = parsePositiveInteger(patch.approvedCapacity, null);
      if (parsed === null) {
        throw { status: 422, message: 'approvedCapacity must be a positive integer.' };
      }
      session.approvedCapacity = parsed;
    }

    if (patch.spawnPolicy !== undefined) {
      session.spawnPolicy = normalizeSpawnPolicy(patch.spawnPolicy);
    }

    if (patch.soloMode !== undefined) {
      session.soloMode = Boolean(patch.soloMode);
    }

    if (patch.idleShutdownMode !== undefined) {
      session.idleShutdownMode = normalizeIdleShutdownMode(patch.idleShutdownMode);
    }

    if (patch.critiqueMode !== undefined) {
      session.critiqueMode = normalizeCritiqueMode(patch.critiqueMode);
    }

    if (patch.artifactRetentionDays !== undefined) {
      const parsed = parsePositiveInteger(patch.artifactRetentionDays, null);
      if (parsed === null && patch.artifactRetentionDays !== null) {
        throw { status: 422, message: 'artifactRetentionDays must be a positive integer when provided.' };
      }
      session.artifactRetentionDays = parsed || 14;
    }

    if (patch.settingsOverrides !== undefined) {
      session.settingsOverrides = sanitizeSettingsOverrides(patch.settingsOverrides);
    }

    if (patch.leader !== undefined) {
      const nextLeader = String(patch.leader || '').trim();
      if (!nextLeader) {
        throw { status: 422, message: 'Session leader cannot be empty.' };
      }
      session.leader = nextLeader;
    }

    if (patch.defaultModel !== undefined) {
      session.defaultModel = String(patch.defaultModel || '').trim().slice(0, 120);
    }

    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'session_updated',
      actor,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Session "${session.name}" updated`,
      evidence: { session },
      status: 'passed',
    });
    this.persistState();

    return clonePayload(session);
  },

  // Store a chat attachment (screenshot/document) under the session's artifacts.
  // dataBase64 is the file contents; the returned ref includes an absolute path
  // the agent can read and a /artifacts URL the dashboard can display.
  async saveSessionAttachment(sessionLocator, { name = '', contentType = '', dataBase64 = '', actor = 'dashboard' } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const data = String(dataBase64 || '');
    if (!data) throw { status: 422, message: 'Attachment data is required.' };
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) throw { status: 422, message: 'Attachment is empty or not valid base64.' };
    if (buffer.length > 12 * 1024 * 1024) throw { status: 413, message: 'Attachment exceeds the 12MB limit.' };
    const base = (String(name || 'attachment').split(/[\\/]/).pop() || 'attachment').slice(-120);
    const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'attachment';
    const sessionSeg = /^[A-Za-z0-9._-]{1,128}$/.test(String(session.id)) ? String(session.id) : 'session';
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`;
    const dir = path.join(process.cwd(), 'artifacts', sessionSeg, 'attachments');
    await fs.mkdir(dir, { recursive: true });
    const abs = path.join(dir, filename);
    // filename is fully server-constructed from a sanitized base, but keep a real
    // boundary check (not a tautology) as defense in depth.
    if (!isPathWithinBoundary(abs, dir)) {
      throw { status: 400, message: 'Invalid attachment path.' };
    }
    await fs.writeFile(abs, buffer);
    const ref = {
      id: randomUUID(),
      name: base,
      filename,
      contentType: String(contentType || '').slice(0, 120),
      bytes: buffer.length,
      path: abs,
      url: `/artifacts/${sessionSeg}/attachments/${filename}`,
    };
    this.recordAudit({
      type: 'session_attachment_uploaded',
      actor: String(actor || 'dashboard').slice(0, 120),
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Attachment "${base}" (${buffer.length}B) uploaded`,
      status: 'passed',
      evidence: { filename, bytes: buffer.length, contentType: ref.contentType },
    });
    this.persistState();
    return ref;
  },

  // Orchestrator-owned session goal + plan (the durable "what are we doing").
  updateSessionPlan(sessionLocator, { goal, plan, actor = 'orchestrator' } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    if (goal === undefined && plan === undefined) {
      throw { status: 422, message: 'Provide a goal and/or plan to update.' };
    }
    if (goal !== undefined) session.goal = String(goal).slice(0, 4000);
    if (plan !== undefined) session.plan = String(plan).slice(0, 20000);
    session.planUpdatedAt = nowIso();
    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'session_plan_updated',
      actor: String(actor || 'orchestrator').slice(0, 120),
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Session "${session.name}" plan updated`,
      status: 'passed',
      evidence: { goal: session.goal || '', planChars: (session.plan || '').length },
    });
    this.persistState();
    return clonePayload(session);
  },

  createSession(projectLocator, {
    name,
    leader = 'codex',
    laneConcurrencyLimit = DEFAULT_APPROVED_CAPACITY,
    approvedCapacity = laneConcurrencyLimit,
    spawnPolicy = 'within_capacity',
    soloMode = true,
    idleShutdownMode = 'immediate',
    critiqueMode = 'suggested',
    artifactRetentionDays = 14,
    settingsOverrides = {},
    defaultModel = '',
    actor = 'dashboard',
    repoRoot = '',
  } = {}, context = {}) {
    const resolvedActor = context.actor || actor;
    const policyCheck = this.evaluateActionPolicy('createSession', {
      actor: resolvedActor,
      approved: context.approved,
    });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const project = this.getProject(projectLocator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }

    if (!name || !String(name).trim()) {
      throw { status: 422, message: 'Session name is required.' };
    }

    const now = nowIso();
    const concurrencyLimit = Math.max(1, Number.parseInt(laneConcurrencyLimit, 10) || DEFAULT_APPROVED_CAPACITY);
    const normalizedApprovedCapacity = normalizeApprovedCapacity(approvedCapacity, concurrencyLimit);
    const retention = Number.parseInt(artifactRetentionDays, 10) || 14;
    const sessionId = randomUUID();
    // Inherit the project's folder when the session doesn't specify one — the
    // user picks the working directory once when creating the project.
    if ((!repoRoot || !String(repoRoot).trim()) && project.repoRoot) {
      repoRoot = project.repoRoot;
    }
    let validatedRepoRoot = '';
    if (typeof repoRoot === 'string' && repoRoot.trim()) {
      const candidate = path.resolve(repoRoot.trim());
      // Any existing directory works — agents spawn in the folder (git not required).
      if (!directoryExists(candidate)) {
        throw { status: 422, message: `Session repoRoot does not exist: ${candidate}` };
      }
      // Repo root must live under an approved boundary so we can never auto-worktree
      // into a directory the operator did not bless.
      const approved = this.getApprovedRepoRoots();
      const within = approved.some((root) => candidate === root || candidate.startsWith(root + path.sep));
      if (!within) {
        throw {
          status: 422,
          message: `Session repoRoot ${candidate} is outside the approved repo roots. Add it to ORCA_REPO_ROOTS or run the server from its parent.`,
        };
      }
      validatedRepoRoot = candidate;
    }
    const session = {
      id: sessionId,
      projectId: project.id,
      name: String(name).trim(),
      leader,
      laneConcurrencyLimit: concurrencyLimit,
      approvedCapacity: normalizedApprovedCapacity,
      spawnPolicy: normalizeSpawnPolicy(spawnPolicy),
      soloMode: soloMode !== false,
      idleShutdownMode: normalizeIdleShutdownMode(idleShutdownMode),
      critiqueMode: normalizeCritiqueMode(critiqueMode),
      capacityRequests: [],
      artifactRetentionDays: retention,
      settingsOverrides: sanitizeSettingsOverrides(settingsOverrides),
      // Per-session default model; '' inherits project.defaultModel, then the
      // executor's built-in default (resolved in the composer).
      defaultModel: String(defaultModel || '').trim().slice(0, 120),
      route: `/projects/${project.slug}/sessions/${sessionId}`,
      createdAt: now,
      updatedAt: now,
      state: 'active',
      artifactsRoot: path.join(this.artifactRoot, sessionId),
      worktreeRoot: path.join(this.workspacesRoot, sessionId),
      repoRoot: validatedRepoRoot,
      notes: [],
      orchestratorThread: {
        id: randomUUID(),
        messages: [],
        laneIds: [],
        activeLaneId: null,
        executorType: null,
        updatedAt: now,
      },
    };
    ensureDirectorySync(session.artifactsRoot);
    ensureDirectorySync(session.worktreeRoot);

    this.sessions.push(session);
    this.recordAudit({
      type: 'session_created',
      actor: resolvedActor,
      projectId: project.id,
      sessionId: session.id,
      summary: `Session "${session.name}" created for project ${project.name}`,
      evidence: { session },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(session);
  },

  listSessions(projectLocator) {
    const project = this.getProject(projectLocator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }
    // Exclude archived sessions from the default list so they don't show in the
    // sidebar; archived items are surfaced separately via listArchived().
    return clonePayload(this.sessions.filter((session) => session.projectId === project.id && session.state !== 'archived'));
  },

  // Archived projects + sessions for the Settings -> Archive view (restore).
  listArchived() {
    const projects = this.projects
      .filter((project) => project.state === 'archived')
      .map((project) => clonePayload(project));
    const sessions = this.sessions
      .filter((session) => session.state === 'archived')
      .map((session) => {
        const project = this.projects.find((candidate) => candidate.id === session.projectId);
        return { ...clonePayload(session), projectName: project?.name || 'Unknown project', projectSlug: project?.slug || '' };
      });
    return { projects, sessions };
  },

  getSession(locator) {
    return this.sessions.find((session) => session.id === locator);
  },

  // Permanently delete an ARCHIVED session: drop its lanes (best-effort worktree
  // cleanup), remove its on-disk workspace, and erase the record. Refuses to touch
  // a non-archived session so an active chat can't be nuked by accident.
  async deleteSession(sessionLocator, { actor = 'dashboard' } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    if (session.state !== 'archived') {
      throw { status: 422, message: 'Archive the session before permanently deleting it.' };
    }
    const laneIds = (this.lanes || []).filter((lane) => lane.sessionId === session.id).map((lane) => lane.id);
    for (const laneId of laneIds) {
      if (typeof this.removeLaneWorktree === 'function') {
        try { await this.removeLaneWorktree(laneId, { actor, approved: true, removeBranch: false }); } catch { /* best effort */ }
      }
    }
    this.lanes = (this.lanes || []).filter((lane) => lane.sessionId !== session.id);
    // Backlog tasks are top-level state keyed by sessionId — drop this session's
    // so they don't orphan in state.json after the session is gone.
    this.tasks = (this.tasks || []).filter((task) => task.sessionId !== session.id);
    if (session.worktreeRoot) {
      try { await fs.rm(session.worktreeRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    this.sessions = this.sessions.filter((entry) => entry.id !== session.id);
    this.recordAudit({
      type: 'session_deleted',
      actor,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Permanently deleted session "${session.name}"`,
      evidence: { sessionId: session.id, lanesRemoved: laneIds.length },
      status: 'passed',
    });
    this.persistState();
    return { deleted: true, id: session.id };
  },

  // Permanently delete an ARCHIVED project and everything under it.
  async deleteProject(projectLocator, { actor = 'dashboard' } = {}) {
    const project = this.projects.find((entry) => entry.id === projectLocator || entry.slug === projectLocator);
    if (!project) throw { status: 404, message: 'Project not found.' };
    if (project.state !== 'archived') {
      throw { status: 422, message: 'Archive the project before permanently deleting it.' };
    }
    const sessionIds = this.sessions.filter((session) => session.projectId === project.id).map((session) => session.id);
    for (const sessionId of sessionIds) {
      const session = this.getSession(sessionId);
      if (session && session.state !== 'archived') session.state = 'archived';
      try { await this.deleteSession(sessionId, { actor }); } catch { /* best effort per session */ }
    }
    this.projects = this.projects.filter((entry) => entry.id !== project.id);
    this.recordAudit({
      type: 'project_deleted',
      actor,
      projectId: project.id,
      summary: `Permanently deleted project "${project.name}"`,
      evidence: { projectId: project.id, sessionsRemoved: sessionIds.length },
      status: 'passed',
    });
    this.persistState();
    return { deleted: true, id: project.id };
  },

  // Branch + worktree state for a session's repoRoot, for the composer git picker.
  // Non-git (or no) repoRoot returns { isGit:false } — the agent still runs there.
  getSessionGitInfo(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    if (!session.repoRoot) return { isGit: false, reason: 'No folder configured for this session.' };
    return readRepoGitInfo(session.repoRoot);
  },
};
