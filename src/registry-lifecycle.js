// Lifecycle helpers: interrupted-lane recovery on boot, demo seeding, and
// action-policy (approval-gate) evaluation. Prototype mixin for OrcaRegistry.
// Extracted from registry.js.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isRunningLaneState } from './worker-contract.js';
import { nowIso, buildLaneRoute } from './registry-utils.js';
import { CLI_EXECUTOR_DEFAULTS, FIRST_CLASS_CLI_EXECUTOR_TYPES } from './executor/constants.js';

// Binaries we are willing to SIGKILL when reaping an orphaned lane after a hard
// restart. Derived from the executor table so a newly added CLI is covered
// automatically (the old hardcoded /codex|claude|gemini/ silently skipped
// composer-cli's `cursor-agent`).
//
// Deliberately FIRST-CLASS ONLY: the generic `cli` executor defaults to `node`, and
// matching "node" would let a reused pid take out an unrelated Node process — or the
// daemon itself. A generic-cli orphan is left alone rather than risk that.
const EXECUTOR_BINARY_PATTERN = new RegExp(
  `\\b(${FIRST_CLASS_CLI_EXECUTOR_TYPES
    .map((type) => CLI_EXECUTOR_DEFAULTS[type]?.binary)
    .filter(Boolean)
    .map((binary) => String(binary).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
);

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
    // Only kill something that really is one of our executor binaries — a pid can be
    // reused by an unrelated process between crash and restart. Derive the names from
    // the executor table instead of hardcoding: the old literal list
    // (codex|claude|gemini) silently skipped composer-cli's `cursor-agent`, so those
    // lanes survived a daemon restart forever.
    if (!EXECUTOR_BINARY_PATTERN.test(command)) return false; // reused / not our executor — do NOT kill
    try {
      process.kill(-pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  },

  recoverInterruptedLanes() {
    for (const lane of this.lanes) {
      // v2: the lane's container is its orchestrator record; getSession returns a
      // launchable container view (undefined if the orchestrator is gone).
      const session = this.getSession(lane.sessionId);
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
        if (project && session) {
          lane.route = buildLaneRoute(project.slug, session.id, lane.id);
        }
      }
    }
    this.persistState().catch(() => {});
  },

  // v2 demo seed (ORCA_SEED only): there are no session records, so seed just
  // creates a demo project. Orchestrators + lanes are created by agents on
  // connect (register -> executor.spawn), which is the real flow.
  seed() {
    this.createProject({
      name: 'Example Project',
      slug: 'example-project',
      quickLinks: [
        { label: 'Local dev server', url: 'http://localhost:4173', localUrl: 'http://localhost:4173', port: 4173, kind: 'vite', favorite: true },
        { label: 'Artifacts', url: '/projects/example-project/overview?section=artifacts', kind: 'dashboard' },
      ],
      owner: 'seed',
    }, {
      actor: 'seed',
      approved: true,
    });
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
