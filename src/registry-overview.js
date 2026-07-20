// Dashboard overview projection and linger behavior as a prototype mixin for
// OrcaRegistry.

import { nowIso } from './registry-utils.js';
import { LANE_STATES } from './worker-contract.js';

const EXECUTOR_LINGER_MS = 5 * 60 * 1000;
const ORCHESTRATOR_LINGER_MS = 15 * 60 * 1000;
const TERMINAL = new Set([
  LANE_STATES.ACCEPTED,
  LANE_STATES.BLOCKED,
  LANE_STATES.ARCHIVED,
  LANE_STATES.STOPPED,
  LANE_STATES.DONE,
  LANE_STATES.FAILED,
]);

const isTerminalState = (state) => TERMINAL.has(state);
const timestamp = (value) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const statusTagForState = (state) => {
  switch (state) {
    case LANE_STATES.AUDITING:
      return 'auditing';
    case LANE_STATES.READY_FOR_AUDIT:
    case LANE_STATES.DONE:
    case LANE_STATES.ACCEPTED:
      return 'done — awaiting reply';
    case LANE_STATES.FAILED:
      return 'failed';
    case LANE_STATES.BLOCKED:
      return 'blocked';
    case LANE_STATES.FIX_REQUESTED:
      return 'fix requested';
    case LANE_STATES.QUEUED:
    case LANE_STATES.STARTING:
    case LANE_STATES.RUNNING:
    case LANE_STATES.NEEDS_CRITIQUE:
      return 'working';
    default:
      return String(state);
  }
};

export const overviewMethods = {
  buildOverview() {
    const now = Date.now();
    const projects = (this.projects || [])
      .map((project) => {
        const orchestrators = (this.orchestrators || [])
          .filter((orchestrator) => orchestrator.projectId === project.id)
          .map((orchestrator) => {
            const stale = this._orchestratorStale(orchestrator);
            const executors = (this.lanes || [])
              .filter((lane) => lane.orchestratorId === orchestrator.id)
              .map((lane) => ({ lane, terminal: isTerminalState(lane.state) }))
              .filter(({ lane, terminal }) => !terminal
                || now - timestamp(lane.completedAt || lane.updatedAt || 0) < EXECUTOR_LINGER_MS)
              .map(({ lane, terminal }) => ({
                id: lane.id,
                title: lane.title,
                executorType: lane.executorType,
                state: lane.state,
                statusTag: lane.statusTag || statusTagForState(lane.state),
                statusText: lane.statusText || null,
                terminal,
                startedAt: lane.startedAt || null,
                completedAt: lane.completedAt || null,
                updatedAt: lane.updatedAt || null,
              }))
              .sort((left, right) => {
                if (left.terminal !== right.terminal) return left.terminal ? 1 : -1;
                return timestamp(right.updatedAt) - timestamp(left.updatedAt);
              });

            const inactive = Boolean(orchestrator.resignedAt) || stale;
            const lingering = now - timestamp(
              orchestrator.resignedAt || orchestrator.lastSeenAt || 0,
            ) < ORCHESTRATOR_LINGER_MS;
            if (inactive && !lingering && executors.length === 0) return null;

            return {
              id: orchestrator.id,
              actor: orchestrator.actor,
              title: orchestrator.title,
              focus: orchestrator.focus,
              stale,
              registeredAt: orchestrator.registeredAt,
              lastSeenAt: orchestrator.lastSeenAt,
              executors,
            };
          })
          .filter(Boolean);

        if (orchestrators.length === 0) return null;
        return {
          id: project.id,
          name: project.name,
          parentName: project.parentName,
          cwd: project.cwd,
          lastActivityAt: project.lastActivityAt,
          orchestrators,
        };
      })
      .filter(Boolean)
      .sort((left, right) => timestamp(right.lastActivityAt) - timestamp(left.lastActivityAt));

    return {
      revision: typeof this.getStreamRevision === 'function' ? this.getStreamRevision() : 0,
      generatedAt: nowIso(),
      projects,
    };
  },
};
