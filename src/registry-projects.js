// Project CRUD + quick-link methods, as a prototype mixin for OrcaRegistry.
//

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload, normalizeSlug, realpathSyncSafe, isRealPathWithinBoundarySync } from './registry-utils.js';
import { directoryExists } from './worktree-manager.js';
import {
  MAX_PROJECT_QUICK_LINKS,
  normalizeQuickLink,
  normalizeQuickLinks,
  tailnetUrlForPort,
} from './registry-quick-links.js';
import { detectTailnetState } from './private-access/tailnet.js';

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
    const link = normalizeQuickLink(this._fillDevServerPreview(payload, existing), existing);
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

  // Resolve the workstation's MagicDNS `.ts.net` name for auto-filling dev-server
  // tailnet previews. Prefers an injected resolver (set by the server wiring or a
  // test, e.g. registry.magicDnsResolver = () => privateAccess.magicDnsName()) and
  // otherwise falls back to a read-only `tailscale status` probe. Never triggers a
  // Serve/network action; returns '' when Tailscale is down (link stays local-only).
  _workstationMagicDnsName() {
    try {
      if (typeof this.magicDnsResolver === 'function') {
        return String(this.magicDnsResolver() || '').trim().replace(/\.$/, '');
      }
      const state = detectTailnetState({});
      return state?.hostname ? String(state.hostname).trim().replace(/\.$/, '') : '';
    } catch {
      return '';
    }
  },

  // Additive enrichment for a quick-link upsert: only when the caller explicitly
  // declares a dev-server `port`, imply a loopback localUrl (so a bare {port,label}
  // normalizes) and auto-fill the tailnet preview URL from the workstation MagicDNS
  // name. Links without an explicit port are returned untouched.
  _fillDevServerPreview(payload = {}, existing = null) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const parsedPort = Number.parseInt(payload.port ?? '', 10);
    const hasExplicitPort = Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
    if (!hasExplicitPort) return payload;
    const next = { ...payload };
    const present = (value) => Boolean(value && String(value).trim());
    if (!present(next.localUrl) && !present(existing?.localUrl)) {
      next.localUrl = `http://127.0.0.1:${parsedPort}`;
    }
    if (!present(next.tailnetHttpUrl) && !present(existing?.tailnetHttpUrl)) {
      const tailnetUrl = tailnetUrlForPort(parsedPort, this._workstationMagicDnsName());
      if (tailnetUrl) next.tailnetHttpUrl = tailnetUrl;
    }
    // A bare {port,label} has no primary `url`. normalizeQuickLink requires one and
    // its `??` chain treats a blank tailnetHttpUrl as satisfying the slot, so seed a
    // concrete primary URL (tailnet preview when known, otherwise the loopback URL).
    if (!present(next.url) && !present(existing?.url)) {
      next.url = next.tailnetHttpUrl || next.localUrl || `http://127.0.0.1:${parsedPort}`;
    }
    return next;
  },

  // (No deleteProjectQuickLink / checkProjectQuickLink: one upsert is the whole
  // preview surface. Health status stays whatever the writer declared.)
};
