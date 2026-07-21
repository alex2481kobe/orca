// Policy map + effective-settings resolution/override methods, as a prototype
// mixin for OrcaRegistry. Extracted from registry.js. (evaluateActionPolicy stays
// in the core class — it is called by nearly every mutating method.)

import { nowIso, clonePayload } from './registry-utils.js';
import { buildEffectiveSettings, sanitizeSettingsOverrides } from './effective-settings.js';

export const settingsMethods = {
  getPolicyMap() {
    return clonePayload(this.policies);
  },

  getEffectiveSettings({
    projectId,
    sessionId,
    laneId,
    actionOverride,
  } = {}) {
    const lane = laneId ? this.getLane(laneId) : null;
    const session = sessionId
      ? this.getSession(sessionId)
      : lane
        ? this.getSession(lane.sessionId)
        : null;
    const project = projectId
      ? this.getProject(projectId)
      : session
        ? this.projects.find((candidate) => candidate.id === session.projectId)
        : lane
          ? this.projects.find((candidate) => candidate.id === lane.projectId)
          : null;

    if (projectId && !project) throw { status: 404, message: 'Project not found.' };
    if (sessionId && !session) throw { status: 404, message: 'Session not found.' };
    if (laneId && !lane) throw { status: 404, message: 'Lane not found.' };
    if (project && session && session.projectId !== project.id) {
      throw { status: 422, message: 'Session does not belong to the requested project.' };
    }
    if (session && lane && lane.sessionId !== session.id) {
      throw { status: 422, message: 'Lane does not belong to the requested session.' };
    }
    if (project && lane && lane.projectId !== project.id) {
      throw { status: 422, message: 'Lane does not belong to the requested project.' };
    }

    return buildEffectiveSettings({
      project,
      session,
      lane,
      actionOverride,
    });
  },

  updateSettingsOverrides({
    scope,
    locator,
    settingsOverrides = {},
    actor = 'dashboard',
    approved,
  } = {}) {
    const normalizedScope = String(scope || '').trim().toLowerCase();
    const policyCheck = this.evaluateActionPolicy('updateProject', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const sanitized = sanitizeSettingsOverrides(settingsOverrides);
    let target = null;
    if (normalizedScope === 'project') {
      target = this.getProject(locator);
    } else if (normalizedScope === 'session') {
      target = this.getSession(locator);
    } else if (normalizedScope === 'lane') {
      target = this.getLane(locator);
    } else {
      throw { status: 422, message: 'Settings scope must be project, session, or lane.' };
    }
    if (!target) throw { status: 404, message: `${normalizedScope} not found.` };

    target.settingsOverrides = sanitized;
    target.updatedAt = nowIso();
    this.recordAudit({
      type: 'settings_overrides_updated',
      actor: String(actor || 'dashboard').slice(0, 120),
      projectId: target.projectId || target.id || null,
      sessionId: normalizedScope === 'session' ? target.id : target.sessionId || null,
      laneId: normalizedScope === 'lane' ? target.id : null,
      summary: `Updated ${normalizedScope} effective settings overrides`,
      evidence: {
        scope: normalizedScope,
        targetId: target.id,
        settingsGroups: Object.keys(sanitized),
      },
      status: 'passed',
    });
    this.persistState();

    return this.getEffectiveSettings({
      projectId: normalizedScope === 'project' ? target.id : target.projectId,
      sessionId: normalizedScope === 'session' ? target.id : target.sessionId,
      laneId: normalizedScope === 'lane' ? target.id : null,
    });
  },
};
