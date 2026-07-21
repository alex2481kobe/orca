import fsSync from 'node:fs';
import path from 'node:path';
import { toolLeaseMethods } from './registry-tool-leases.js';
import { notificationMethods } from './registry-notification-methods.js';
import { agentQueueMethods } from './registry-agent-queue.js';
import { defaultPolicy } from './registry-policy.js';
import { executorCapabilityMethods } from './registry-executor-caps.js';
import { settingsMethods } from './registry-settings.js';
import { auditMethods } from './registry-audit.js';
import { projectMethods } from './registry-projects.js';
import { mcpToolMethods } from './registry-mcp-tools.js';
import { sessionMethods } from './registry-sessions.js';
import { orchestratorMethods } from './registry-orchestrator.js';
import { cleanupMethods } from './registry-cleanup.js';
import { laneOpsMethods } from './registry-lane-ops.js';
import { laneTerminalMethods } from './registry-lane-terminal.js';
import { laneCreateMethods } from './registry-lane-create.js';
import { schedulerMethods } from './registry-scheduler.js';
import { workspaceMethods } from './registry-workspaces.js';
import { auditLogMethods } from './registry-audit-log.js';
import { persistenceMethods } from './registry-persistence.js';
import { artifactMethods } from './registry-artifacts.js';
import { agentMethods } from './registry-agents.js';
import { overviewMethods } from './registry-overview.js';
import { lifecycleMethods } from './registry-lifecycle.js';
import {
  parseBooleanEnv,
  clonePayload,
} from './registry-utils.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
} from './registry-notifications.js';

import {
  createExecutorAdapter,
} from './executor-factory.js';

export class OrcaRegistry {
  constructor({
    heartbeatIntervalMs = 2000,
    autoCompleteMs = 12000,
    heartbeatTimeoutMs = 15000,
    credentialStore = null,
    providerProfileStore = null,
    autoAudit,
  } = {}) {
    this.projects = [];
    this.sessions = [];
    this.orchestrators = [];
    this.lanes = [];
    this.auditEvents = [];
    this.mcpTools = [];
    this.toolLeases = [];
    this.notifications = [];
    this.agentQueue = [];
    this.notificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };
    this.artifactRoot = path.join(process.cwd(), 'artifacts');
    this.workspacesRoot = path.join(process.cwd(), '.orca', 'workspaces');
    this.storageDir = path.join(process.cwd(), '.orca');
    this.stateFile = path.join(this.storageDir, 'state.json');

    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.autoCompleteMs = autoCompleteMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    // Auto-audit: when a lane finishes under require-audit-pass (or the
    // audit flow template), the scheduler auto-runs the audit — nudging the
    // orchestrator, or spawning a dedicated auditor lane (per the Auditor
    // setting). On by default; ORCA_AUTO_AUDIT=false (or {autoAudit:false})
    // disables it. Tests run with it off so they drive lanes deterministically.
    this.autoAuditEnabled = autoAudit ?? (process.env.ORCA_AUTO_AUDIT !== 'false');
    this.credentialStore = credentialStore;
    this.providerProfileStore = providerProfileStore;
    this.policies = { ...defaultPolicy };
    this.cleanupSchedule = {
      enabled: false,
      intervalHours: 24,
      olderThanDays: null,
      sessionId: null,
      dryRun: false,
      lastRunAt: null,
      nextRunAt: null,
    };

    this._persistTimer = null;
    this._schedulerRunning = false;
    this._storageReady = false;
    this.stateLoadStatus = null;
    this._starting = true;
    this._pendingWrites = new Set();
    this.laneRuntimeEnv = new Map();
    // CLI executors may run a lane in the session's vetted repoRoot (an approved
    // ORCA_REPO_ROOTS path) or in a per-lane git worktree under workspacesRoot —
    // both must be allowed EXECUTION roots, not just process.cwd().
    const extraWorkdirRoots = [
      this.workspacesRoot,
      ...(typeof this.getApprovedRepoRoots === 'function' ? this.getApprovedRepoRoots() : []),
    ].filter(Boolean);
    const baseExecutorCallbacks = {
      extraWorkdirRoots,
      onLog: (lane, message) => this.appendLaneLog(lane, message, { persist: false }),
      onAgentEvent: (lane, agentEvent) => this.appendLaneAgentEvent(lane, agentEvent, { persist: false }),
      onComplete: async (lane) => this.markLaneCompleted(lane),
      onFail: async (lane, reason) => this.markLaneFailed(lane, reason, 'scheduler'),
      onStop: async (lane, context) => this.markLaneStopped(lane, context),
      credentialStore: this.credentialStore,
      providerProfileStore: this.providerProfileStore,
      runtimeEnvForLane: (lane) => this.laneRuntimeEnv.get(String(lane?.id || '')) || {},
    };
    this.executors = {
      mock: createExecutorAdapter('mock', {
        ...baseExecutorCallbacks,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        defaultAutoCompleteMs: this.autoCompleteMs,
      }),
      codex: createExecutorAdapter('codex', baseExecutorCallbacks),
      claude: createExecutorAdapter('claude', baseExecutorCallbacks),
    };
    this.laneExecutorMap = new Map();
    this.unknownExecutorAdapters = new Map();

    try { fsSync.mkdirSync(this.artifactRoot, { recursive: true }); } catch { /* best-effort startup path */ }
    try { fsSync.mkdirSync(this.workspacesRoot, { recursive: true }); } catch { /* best-effort startup path */ }
    this.restoreFromDisk();
    if (!this.projects.length && parseBooleanEnv(process.env.ORCA_SEED, false)) {
      this.seed();
    }
    this.startScheduler();
  }

  getLane(locator) {
    return this.lanes.find((lane) => lane.id === locator);
  }

  listLanes(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    return clonePayload(this.lanes.filter((lane) => lane.sessionId === session.id));
  }

  // Lightweight lane list for the dashboard poll: drops `logs` entirely (no list
  // view shows them) and keeps only the last LANE_LIST_EVENT_TAIL agentEvents
  // (enough for the side-panel previews), plus total counts. The full lane —
  // including all logs + agentEvents — is fetched per-lane via GET /api/lanes/:id
  // only when that lane is opened. This avoids deep-cloning up to 2000 logs +
  // 3000 agentEvents per lane on every 1-3s poll. Excludes the heavy arrays
  // BEFORE cloning so the clone itself stays cheap.
  listLanesCompact(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const TAIL = 20;
    return this.lanes
      .filter((lane) => lane.sessionId === session.id)
      .map((lane) => {
        const { logs, agentEvents, ...rest } = lane;
        const events = Array.isArray(agentEvents) ? agentEvents : [];
        return clonePayload({
          ...rest,
          agentEvents: events.slice(-TAIL),
          agentEventCount: events.length,
          logCount: Array.isArray(logs) ? logs.length : 0,
        });
      });
  }

}

// Tool-lease lifecycle + tool-state gating live in a focused module and are
// merged onto the prototype here, preserving the public API (registry.create
// ToolLease(...), registry.validateToolLease(...), etc.).
Object.assign(OrcaRegistry.prototype, toolLeaseMethods);
Object.assign(OrcaRegistry.prototype, notificationMethods);
Object.assign(OrcaRegistry.prototype, agentQueueMethods);
Object.assign(OrcaRegistry.prototype, executorCapabilityMethods);
Object.assign(OrcaRegistry.prototype, settingsMethods);
Object.assign(OrcaRegistry.prototype, auditMethods);
Object.assign(OrcaRegistry.prototype, projectMethods);
Object.assign(OrcaRegistry.prototype, mcpToolMethods);
Object.assign(OrcaRegistry.prototype, sessionMethods);
// v2 agent/overview mixins are assigned BEFORE orchestratorMethods so the old
// session-based resignOrchestrator (still live until Lane 2 step 5 removes it)
// wins the one method-name collision. The new register/update/touch/stale
// methods do not collide and remain available for the v2 register route.
Object.assign(OrcaRegistry.prototype, agentMethods);
Object.assign(OrcaRegistry.prototype, overviewMethods);
Object.assign(OrcaRegistry.prototype, orchestratorMethods);
Object.assign(OrcaRegistry.prototype, cleanupMethods);
Object.assign(OrcaRegistry.prototype, laneOpsMethods);
Object.assign(OrcaRegistry.prototype, laneTerminalMethods);
Object.assign(OrcaRegistry.prototype, laneCreateMethods);
Object.assign(OrcaRegistry.prototype, schedulerMethods);
Object.assign(OrcaRegistry.prototype, workspaceMethods);
Object.assign(OrcaRegistry.prototype, auditLogMethods);
Object.assign(OrcaRegistry.prototype, persistenceMethods);
Object.assign(OrcaRegistry.prototype, artifactMethods);
Object.assign(OrcaRegistry.prototype, lifecycleMethods);
