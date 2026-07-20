// Lifecycle helpers: interrupted-lane recovery on boot, demo seeding, and
// action-policy (approval-gate) evaluation. Prototype mixin for OrcaRegistry.
// Extracted from registry.js.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isRunningLaneState } from './worker-contract.js';
import { nowIso, buildLaneRoute } from './registry-utils.js';

export const lifecycleMethods = {
  // On a HARD restart (SIGKILL — graceful shutdown already stops executors), a
  // lane's detached child process group survives with no supervisor, still
  // running and burning tokens. Kill it. PID-REUSE HAZARD: the persisted pid may
  // now belong to an unrelated process, so verify it still looks like one of our
  // executor CLIs (via ps) before killing the group — a wrong kill is worse than
  // a missed reap. Negative pid targets the whole detached group (matches
  // cli-adapter's own stop()).
  _reapOrphanedLaneProcess(lane) {
    const meta = lane.processMeta || {};
    const pid = Number(meta.pgid || meta.pid);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    let command = '';
    try {
      command = String(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 }) || '').toLowerCase();
    } catch {
      return false; // process is already gone (or ps unavailable) — nothing to reap
    }
    if (!/\b(codex|claude|gemini)\b/.test(command)) return false; // reused / not our executor — do NOT kill
    try {
      process.kill(-pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  },

  recoverInterruptedLanes() {
    for (const lane of this.lanes) {
      const session = this.sessions.find((value) => value.id === lane.sessionId);
      if (!lane.workdir) {
        lane.workdir = session
          ? this.resolveLaneWorkdir(session, null)
          : path.join(process.cwd(), 'artifacts', lane.sessionId || 'orphan', lane.id);
      } else if (session) {
        try {
          lane.workdir = this.resolveLaneWorkdir(session, lane.workdir);
        } catch {
          lane.workdir = this.resolveLaneWorkdir(session, null);
        }
      }
      if (isRunningLaneState(lane.state)) {
        const reaped = this._reapOrphanedLaneProcess(lane);
        this.markLaneFailed(
          lane,
          reaped
            ? 'Controller restarted while lane was active (orphaned executor process reaped)'
            : 'Controller restarted while lane was active',
          'system',
          false,
        );
      }
      if (!lane.id) {
        lane.id = randomUUID();
      }
      if (!lane.artifactPath || lane.artifactPath === '/artifacts') {
        lane.artifactPath = `/artifacts/${lane.sessionId || 'orphan'}/${lane.id}`;
      }
      if (!Array.isArray(lane.logs)) {
        lane.logs = [];
      }
      if (!Array.isArray(lane.agentEvents)) {
        lane.agentEvents = [];
      }
      if (typeof lane.runProfile?.autoCompleteMs !== 'number') {
        lane.runProfile = { ...lane.runProfile, autoCompleteMs: this.autoCompleteMs };
      }
      if (typeof lane.createdAt !== 'string') {
        lane.createdAt = nowIso();
      }

      if (!lane.route) {
        const project = this.projects.find((value) => value.id === lane.projectId);
        const session = this.sessions.find((value) => value.id === lane.sessionId);
        if (project && session) {
          lane.route = buildLaneRoute(project.slug, session.id, lane.id);
        }
      }
    }
    this.persistState().catch(() => {});
  },

  seed() {
    const project = this.createProject({
      name: 'Example Project',
      slug: 'example-project',
      quickLinks: [
        { label: 'Local dev server', url: 'http://localhost:4173', localUrl: 'http://localhost:4173', port: 4173, kind: 'vite', favorite: true },
        { label: 'Artifacts', url: '/projects/example-project/sessions/overview?section=artifacts', kind: 'dashboard' },
      ],
      owner: 'seed',
    }, {
      actor: 'seed',
      approved: true,
    });

    const session = this.createSession(project.id, {
      name: 'Studio coordination',
      leader: 'codex',
      laneConcurrencyLimit: 2,
      actor: 'seed',
    }, {
      actor: 'seed',
      approved: true,
    });

    this.createLane(session.id, {
      title: 'Initialize orca lane',
      taskDescription: 'Validate routing model and action approvals.',
      executorType: 'mock',
      owner: 'seed',
    }, { approved: true });
  },

  evaluateActionPolicy(action, payload = {}) {
    const policy = this.policies[action];
    if (!policy) {
      return {
        allowed: true,
        policy: { requiresApproval: false, risk: 'low', message: 'No policy rule' },
      };
    }

    const actor = String(payload.actor || '').toLowerCase();
    if (actor === 'scheduler') {
      return { allowed: true, policy };
    }

    if (action === 'cleanupArtifacts' && payload.skipApproval === true) {
      return { allowed: true, policy };
    }

    if (payload.approved === true) {
      return { allowed: true, policy };
    }

    if (policy.requiresApproval) {
      return {
        allowed: false,
        policy,
        message: `${action} requires explicit approval before execution.`,
      };
    }

    return { allowed: true, policy };
  },
};
