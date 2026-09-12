// Dashboard overview projection as a prototype mixin for OrcaRegistry.
//
// `GET /api/overview` is the ONLY endpoint the dashboard fetches, so this
// projection IS the dashboard. It used to be a live-activity view that DELETED
// everything it did not consider current: a terminal executor older than five
// minutes was dropped, an orchestrator with no surviving executor and no
// heartbeat in fifteen minutes was dropped, and a project whose orchestrators
// had all been dropped was dropped too. Over a real state — 3 projects, 11
// orchestrators, 86 lanes, all of them terminal, nothing started in the last
// quarter of an hour — those three filters compose to `projects: []` while
// /api/health truthfully reports the full counts, and the dashboard shows
// nothing. See docs/audits/2026-09-11-overview-empty.md.
//
// So recency no longer decides EXISTENCE, only ORDER and emphasis:
//   - every project is projected, always;
//   - every orchestrator of a project is projected, always, carrying `stale`,
//     `resigned` and `recent` so the UI can rank and dim it;
//   - live executors are always projected; terminal ones fill the rest of a
//     bounded window, newest first, and whatever does not fit is COUNTED, never
//     silently dropped (`executorCount`, `executorsOmitted`);
//   - `counts` repeats the same totals /api/health reports, so a projection
//     that loses rows can be seen losing them instead of looking empty.

import { nowIso } from './registry-utils.js';
import { LANE_STATES } from './worker-contract.js';
import { effectiveQuickLinkUrl } from './registry-quick-links.js';

// Recency windows. These used to gate what existed; they now only mark what is
// current, which is what the dashboard actually wanted them for.
const EXECUTOR_RECENT_MS = 5 * 60 * 1000;
const ORCHESTRATOR_RECENT_MS = 15 * 60 * 1000;
// Upper bound on executors projected per orchestrator, so one orchestrator with
// hundreds of retired lanes cannot dominate every poll. Live lanes are never
// subject to it; what it leaves out is reported as `executorsOmitted`.
const MAX_EXECUTORS_PER_ORCHESTRATOR = 25;

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
      return 'working';
    default:
      return String(state);
  }
};

export const overviewMethods = {
  buildOverview() {
    const now = Date.now();
    const lanes = this.lanes || [];
    const allOrchestrators = this.orchestrators || [];
    let shownOrchestrators = 0;
    let shownExecutors = 0;

    // The ONE deliberate exclusion, and it is explicit: a project a person
    // archived is meant to be out of the way (registry-projects.js listProjects
    // does the same). Everything else is shown, and `counts.projects` below still
    // reports the total so an archived project is a visible difference, not a
    // disappearance. Note the old projection hid these only by accident — as
    // projects that happened to have no surviving orchestrator.
    const active = (this.projects || []).filter((project) => project.state !== 'archived');

    const projects = active
      .map((project) => {
        let projectExecutorCount = 0;
        let projectLiveExecutorCount = 0;

        const orchestrators = allOrchestrators
          .filter((orchestrator) => orchestrator.projectId === project.id)
          .map((orchestrator) => {
            const stale = this._orchestratorStale(orchestrator);
            const resigned = Boolean(orchestrator.resignedAt);
            const recent = now - timestamp(
              orchestrator.resignedAt || orchestrator.lastSeenAt || 0,
            ) < ORCHESTRATOR_RECENT_MS;

            const all = lanes
              .filter((lane) => lane.orchestratorId === orchestrator.id)
              .map((lane) => {
                const terminal = isTerminalState(lane.state);
                return {
                  id: lane.id,
                  title: lane.title,
                  executorType: lane.executorType,
                  state: lane.state,
                  statusTag: lane.statusTag || statusTagForState(lane.state),
                  statusText: lane.statusText || null,
                  terminal,
                  recent: !terminal
                    || now - timestamp(lane.completedAt || lane.updatedAt || 0) < EXECUTOR_RECENT_MS,
                  startedAt: lane.startedAt || null,
                  completedAt: lane.completedAt || null,
                  updatedAt: lane.updatedAt || null,
                };
              })
              .sort((left, right) => {
                if (left.terminal !== right.terminal) return left.terminal ? 1 : -1;
                return timestamp(right.updatedAt) - timestamp(left.updatedAt);
              });

            // Live lanes are never omitted; the window only bounds retired ones.
            const liveCount = all.filter((lane) => !lane.terminal).length;
            const limit = Math.max(liveCount, MAX_EXECUTORS_PER_ORCHESTRATOR);
            const executors = all.slice(0, limit);

            projectExecutorCount += all.length;
            projectLiveExecutorCount += liveCount;
            shownOrchestrators += 1;
            shownExecutors += executors.length;

            return {
              id: orchestrator.id,
              actor: orchestrator.actor,
              title: orchestrator.title,
              focus: orchestrator.focus,
              stale,
              resigned,
              recent,
              // `inactive` is what the old projection deleted on; it is now a
              // display hint the UI can dim, never a reason to hide a row.
              inactive: resigned || stale,
              registeredAt: orchestrator.registeredAt,
              lastSeenAt: orchestrator.lastSeenAt,
              resignedAt: orchestrator.resignedAt || null,
              executors,
              executorCount: all.length,
              liveExecutorCount: liveCount,
              executorsOmitted: all.length - executors.length,
            };
          })
          .sort((left, right) => {
            if (left.liveExecutorCount !== right.liveExecutorCount) {
              return right.liveExecutorCount - left.liveExecutorCount;
            }
            if (left.inactive !== right.inactive) return left.inactive ? 1 : -1;
            return timestamp(right.lastSeenAt) - timestamp(left.lastSeenAt);
          });

        // Port previews: read-only, secret-free projection of the project's
        // dev-server quick links so a phone/laptop can open the tailnet URL from
        // the dashboard. Hidden links are omitted; no leaseId/internal fields leak.
        const previews = (project.quickLinks || [])
          .filter((link) => link && !link.hidden)
          .map((link) => ({
            id: link.id,
            label: link.label,
            port: link.port ?? null,
            kind: link.kind,
            url: effectiveQuickLinkUrl(link, { prefer: 'tailnet' }),
            localUrl: link.localUrl || '',
            tailnetUrl: link.tailnetHttpUrl || '',
            healthStatus: link.healthStatus || 'configured_unchecked',
          }));
        return {
          id: project.id,
          name: project.name,
          parentName: project.parentName,
          cwd: project.cwd,
          lastActivityAt: project.lastActivityAt,
          orchestrators,
          orchestratorCount: orchestrators.length,
          executorCount: projectExecutorCount,
          liveExecutorCount: projectLiveExecutorCount,
          previews,
        };
      })
      .sort((left, right) => {
        if (left.liveExecutorCount !== right.liveExecutorCount) {
          return right.liveExecutorCount - left.liveExecutorCount;
        }
        return timestamp(right.lastActivityAt) - timestamp(left.lastActivityAt);
      });

    return {
      revision: typeof this.getStreamRevision === 'function' ? this.getStreamRevision() : 0,
      generatedAt: nowIso(),
      projects,
      // The same totals /api/health reports, beside what this projection
      // actually shows. They must agree; when they cannot (an orchestrator whose
      // project is gone, a lane whose orchestrator is gone, executors past the
      // per-orchestrator window) the difference is visible here instead of the
      // dashboard just looking empty.
      counts: {
        projects: (this.projects || []).length,
        archivedProjects: (this.projects || []).length - active.length,
        orchestrators: allOrchestrators.length,
        lanes: lanes.length,
        shownProjects: projects.length,
        shownOrchestrators,
        shownExecutors,
      },
      // Setup-required, invalid and whole-home fences are shown on the dashboard.
      fence: typeof this.describeFence === 'function' ? this.describeFence() : null,
    };
  },
};
