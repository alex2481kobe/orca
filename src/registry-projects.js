// Project CRUD + quick-link methods, as a prototype mixin for OrcaRegistry.
// Extracted from registry.js.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload, normalizeSlug, realpathSyncSafe, isRealPathWithinBoundarySync } from './registry-utils.js';
import { sanitizeSettingsOverrides } from './effective-settings.js';
import { directoryExists } from './worktree-manager.js';
import {
  MAX_PROJECT_QUICK_LINKS,
  sanitizeQuickLinkText,
  normalizeQuickLink,
  normalizeQuickLinks,
  boundedQuickLinkHealthCheck,
} from './registry-quick-links.js';

export const projectMethods = {
  createProject({
    name,
    slug,
    quickLinks = [],
    policyProfile = 'default',
    owner = 'dashboard',
    settingsOverrides = {},
    repoRoot = '',
    leader = '',
    defaultModel = '',
  } = {}, context = {}) {
    const actor = context.actor || owner;
    const policyCheck = this.evaluateActionPolicy('createProject', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    if (!name || !String(name).trim()) {
      throw { status: 422, message: 'Project name is required.' };
    }

    const finalSlug = normalizeSlug(slug || name);
    if (!finalSlug) {
      throw { status: 422, message: 'Project slug is required.' };
    }

    const duplicate = this.projects.find((project) => project.slug === finalSlug);
    if (duplicate) {
      throw { status: 409, message: `Project slug "${finalSlug}" already exists.` };
    }

    // Optional working directory (the project's folder). Validated as a git
    // working tree inside an approved repo root, exactly like a session repoRoot;
    // sessions default to it so the user picks the folder once at project create.
    let validatedRepoRoot = '';
    if (typeof repoRoot === 'string' && repoRoot.trim()) {
      const candidate = path.resolve(repoRoot.trim());
      // Any existing directory works — agents spawn in the folder (git not required).
      if (!directoryExists(candidate)) {
        throw { status: 422, message: `Project folder does not exist: ${candidate}` };
      }
      const approved = this.getApprovedRepoRoots();
      const within = approved.some((root) => isRealPathWithinBoundarySync(candidate, root));
      if (!within) {
        throw { status: 422, message: `Project folder ${candidate} is outside the approved repo roots. Add it to ORCA_REPO_ROOTS or run the server from its parent.` };
      }
      validatedRepoRoot = realpathSyncSafe(candidate) || candidate;
    }

    const now = nowIso();
    const project = {
      id: randomUUID(),
      name: String(name).trim(),
      slug: finalSlug,
      route: `/projects/${finalSlug}`,
      quickLinks: normalizeQuickLinks(quickLinks),
      policyProfile,
      repoRoot: validatedRepoRoot,
      settingsOverrides: sanitizeSettingsOverrides(settingsOverrides),
      // Per-project agent defaults: new sessions inherit `leader` (default
      // executor), and the composer falls back to `defaultModel` when a lane
      // hasn't pinned one. Both optional ('' = no project-level default).
      leader: String(leader || '').trim().slice(0, 120),
      defaultModel: String(defaultModel || '').trim().slice(0, 120),
      owner: actor,
      createdAt: now,
      updatedAt: now,
      state: 'active',
      notes: [],
    };

    this.projects.push(project);
    this.recordAudit({
      type: 'project_created',
      actor,
      projectId: project.id,
      summary: `Project "${project.name}" created`,
      evidence: { project },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(project);
  },

  listProjects() {
    return clonePayload(this.projects.filter((project) => project.state !== 'archived'));
  },

  getProject(locator) {
    return this.projects.find((project) => project.id === locator || project.slug === locator);
  },

  updateProject(locator, patch = {}, context = {}) {
    const project = this.getProject(locator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('updateProject', {
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
      throw { status: 422, message: 'Project name cannot be empty.' };
    }

    if (patch.slug) {
      const normalized = normalizeSlug(patch.slug);
      const duplicate = this.projects.find((candidate) => candidate.slug === normalized && candidate.id !== project.id);
      if (duplicate) {
        throw { status: 409, message: `Project slug "${normalized}" already exists.` };
      }
      project.slug = normalized;
      project.route = `/projects/${normalized}`;
    }

    if (patch.name) {
      project.name = String(patch.name).trim();
    }

    if (Array.isArray(patch.quickLinks)) {
      project.quickLinks = normalizeQuickLinks(patch.quickLinks);
    }

    if (patch.policyProfile) {
      project.policyProfile = patch.policyProfile;
    }

    if (patch.state !== undefined) {
      const nextState = String(patch.state || '').trim();
      if (!['active', 'archived'].includes(nextState)) {
        throw { status: 422, message: 'Project state must be active or archived.' };
      }
      project.state = nextState;
    }

    if (patch.settingsOverrides !== undefined) {
      project.settingsOverrides = sanitizeSettingsOverrides(patch.settingsOverrides);
    }

    if (patch.leader !== undefined) {
      project.leader = String(patch.leader || '').trim().slice(0, 120);
    }

    if (patch.defaultModel !== undefined) {
      project.defaultModel = String(patch.defaultModel || '').trim().slice(0, 120);
    }

    project.updatedAt = nowIso();
    this.recordAudit({
      type: 'project_updated',
      actor,
      projectId: project.id,
      summary: `Project "${project.name}" updated`,
      evidence: { project },
      status: 'passed',
    });
    this.persistState();

    return clonePayload(project);
  },

  upsertProjectQuickLink(locator, payload = {}, context = {}) {
    const project = this.getProject(locator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }
    const actor = context.actor || payload.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('updateProject', {
      actor,
      approved: context.approved ?? payload.approved,
    });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    const existingIndex = (project.quickLinks || []).findIndex((link) =>
      link.id === payload.id || (
        payload.label && link.label === payload.label
      )
    );
    const existing = existingIndex >= 0 ? project.quickLinks[existingIndex] : null;
    const link = normalizeQuickLink(payload, existing);
    if (existingIndex >= 0) {
      project.quickLinks[existingIndex] = link;
    } else {
      project.quickLinks = [...(project.quickLinks || []), link].slice(0, MAX_PROJECT_QUICK_LINKS);
    }
    project.updatedAt = nowIso();
    this.recordAudit({
      type: 'project_quick_link_upserted',
      actor,
      projectId: project.id,
      summary: `Quick link "${link.label}" saved for ${project.name}`,
      evidence: { link: { ...link, checkedUrl: undefined } },
      status: 'passed',
    });
    this.persistState();
    return clonePayload({ project, link });
  },

  deleteProjectQuickLink(locator, linkId, context = {}) {
    const project = this.getProject(locator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('updateProject', {
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
    const before = project.quickLinks || [];
    const next = before.filter((link) => link.id !== linkId);
    if (before.length === next.length) {
      throw { status: 404, message: 'Quick link not found.' };
    }
    project.quickLinks = next;
    project.updatedAt = nowIso();
    this.recordAudit({
      type: 'project_quick_link_deleted',
      actor,
      projectId: project.id,
      summary: `Quick link removed from ${project.name}`,
      evidence: { linkId },
      status: 'passed',
    });
    this.persistState();
    return clonePayload({ project, removed: true, linkId });
  },

  async checkProjectQuickLink(locator, linkId, { actor = 'dashboard', prefer = 'auto' } = {}) {
    const project = this.getProject(locator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }
    const link = (project.quickLinks || []).find((item) => item.id === linkId);
    if (!link) {
      throw { status: 404, message: 'Quick link not found.' };
    }
    const result = await boundedQuickLinkHealthCheck(link, { prefer });
    link.healthStatus = result.status;
    link.lastCheckedAt = nowIso();
    link.lastStatusCode = result.httpStatus;
    link.lastHealthDetail = sanitizeQuickLinkText(result.detail, '', 180);
    link.updatedAt = nowIso();
    project.updatedAt = nowIso();
    this.recordAudit({
      type: 'project_quick_link_health_checked',
      actor,
      projectId: project.id,
      summary: `Quick link "${link.label}" health checked: ${result.status}`,
      evidence: {
        linkId: link.id,
        status: result.status,
        httpStatus: result.httpStatus,
        detail: result.detail,
      },
      status: result.status === 'reachable' || result.status === 'not_checkable' ? 'passed' : 'failed',
    });
    this.persistState();
    return clonePayload({ project, link, result });
  },
};
