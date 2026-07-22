// Policy map + effective-settings resolution/override methods, as a prototype
// mixin for OrcaRegistry. Extracted from registry.js. (evaluateActionPolicy stays
// in the core class — it is called by nearly every mutating method.)

import { clonePayload } from './registry-utils.js';
import { buildEffectiveSettings } from './effective-settings.js';

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
};
