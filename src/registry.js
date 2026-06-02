import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { LANE_STATES } from './worker-contract.js';
import {
  planPlaywrightInstall,
  runCaptureInstall,
  describeCaptureStatus,
} from './capture-setup.js';
import { toolLeaseMethods } from './registry-tool-leases.js';
import { notificationMethods } from './registry-notification-methods.js';
import {
  DEFAULT_APPROVED_CAPACITY,
  normalizeSpawnPolicy,
  normalizeIdleShutdownMode,
  normalizeCritiqueMode,
  normalizeApprovedCapacity,
} from './registry-lane-config.js';
import { defaultPolicy } from './registry-policy.js';
import { capacityMethods } from './registry-capacity.js';
import { executorCapabilityMethods } from './registry-executor-caps.js';
import { critiqueMethods } from './registry-critique.js';
import { settingsMethods } from './registry-settings.js';
import { auditMethods } from './registry-audit.js';
import { evidenceMethods } from './registry-evidence.js';
import { projectMethods } from './registry-projects.js';
import { mcpToolMethods } from './registry-mcp-tools.js';
import { sessionMethods } from './registry-sessions.js';
import { orchestratorMethods } from './registry-orchestrator.js';
import { cleanupMethods } from './registry-cleanup.js';
import { laneOpsMethods } from './registry-lane-ops.js';
import { laneTerminalMethods } from './registry-lane-terminal.js';
import { laneCreateMethods } from './registry-lane-create.js';
import {
  nowIso,
  sleep,
  parsePositiveInteger,
  parsePositiveFloat,
  parseBooleanEnv,
  isPathWithinBoundary,
  ensureDirectorySync,
  normalizeExecutorType,
  normalizeSlug,
  firstLine,
  publicBinaryName,
  clonePayload,
  safeArray,
  buildLaneRoute,
} from './registry-utils.js';
import {
  REINSTALL_COMMAND_TIMEOUT_MS,
  getReinstallCommand,
  normalizeReinstallCommand,
  getReinstallSourceCommand,
  getReinstallSourceRepos,
  shouldPreferSourceReinstall,
  commandTargetsExecutorFirstToken,
} from './registry-reinstall.js';
import {
  getCliVersion,
  getCliHelp,
  helpHas,
  parseHelpChoices,
  compactCapabilities,
} from './registry-cli-info.js';
import {
  MAX_PROJECT_QUICK_LINKS,
  sanitizeQuickLinkText,
  normalizeQuickLink,
  normalizeQuickLinks,
  effectiveQuickLinkUrl,
  boundedQuickLinkHealthCheck,
} from './registry-quick-links.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  sanitizeNotificationSettings,
} from './registry-notifications.js';

import {
  createExecutorAdapter,
  FIRST_CLASS_CLI_EXECUTOR_TYPES,
  getApiProviderExecutorTypes,
  getExecutorProfiles as getExecutorProfilesFromFactory,
  getExecutorProfile as getExecutorProfileFromFactory,
  getApiProviderProfile as getApiProviderProfileFromFactory,
} from './executor-factory.js';
import { PlaywrightEvidenceRunner } from './evidence-runner.js';
import {
  describeRepoRoot,
  createLaneWorktree,
  removeLaneWorktree,
  changedFilesIn,
} from './worktree-manager.js';
import {
  buildEffectiveSettings,
  sanitizeSettingsOverrides,
} from './effective-settings.js';
import {
  validateEvidenceUrl,
  validateNetworkUrl,
} from './url-policy.js';
import {
  readJsonFileWithRecoverySync,
  writeJsonFileAtomic,
} from './state-store.js';

const {
  QUEUED: QUEUED_STATE,
  STARTING: STARTING_STATE,
  RUNNING: RUNNING_STATE,
  NEEDS_CRITIQUE: NEEDS_CRITIQUE_STATE,
  READY_FOR_AUDIT: READY_FOR_AUDIT_STATE,
  AUDITING: AUDITING_STATE,
  FIX_REQUESTED: FIX_REQUESTED_STATE,
  ACCEPTED: ACCEPTED_STATE,
  BLOCKED: BLOCKED_STATE,
  STOPPED: STOPPED_STATE,
  DONE: DONE_STATE,
  FAILED: FAILED_STATE,
} = LANE_STATES;


const MAX_WORKDIR_BYTES = 2048;

function sanitizeWorkdirInput(raw) {
  if (raw === undefined || raw === null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  if (text.length > MAX_WORKDIR_BYTES) return '__INVALID_LENGTH__';
  if (/\x00/.test(text)) return '__INVALID_BYTES__';
  return text;
}

const MAX_LANE_LOG_ENTRIES = 2000;
const MAX_AGENT_EVENT_ENTRIES = 3000;

// Prefer the native structured clone (faster, less GC pressure than
// JSON.parse(JSON.stringify(...))); fall back for older runtimes.
function inferEvidenceMode(filename) {
  if (!filename) return null;
  if (filename.endsWith('-shot.png')) return 'screenshot';
  if (filename.endsWith('-trace.zip')) return 'trace';
  if (filename.endsWith('.webm')) return 'video';
  if (filename.endsWith('-log.txt')) return 'log';
  return null;
}

function normalizeEvidenceModeList(mode) {
  if (!mode) return null;
  const normalized = String(mode || '').trim().toLowerCase();
  if (!normalized) return null;
  const mapped = ['screenshot', 'trace', 'video', 'log'].includes(normalized) ? normalized : null;
  return mapped;
}

export class OrcaRegistry {
  constructor({
    heartbeatIntervalMs = 2000,
    autoCompleteMs = 12000,
    heartbeatTimeoutMs = 15000,
    credentialStore = null,
    providerProfileStore = null,
  } = {}) {
    this.projects = [];
    this.sessions = [];
    this.lanes = [];
    this.auditEvents = [];
    this.mcpTools = [];
    this.toolLeases = [];
    this.notifications = [];
    this.notificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };
    this.artifactRoot = path.join(process.cwd(), 'artifacts');
    this.workspacesRoot = path.join(process.cwd(), '.orca', 'workspaces');
    this.storageDir = path.join(process.cwd(), '.orca');
    this.stateFile = path.join(this.storageDir, 'state.json');

    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.autoCompleteMs = autoCompleteMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
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
    const baseExecutorCallbacks = {
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
    this.evidenceRunner = new PlaywrightEvidenceRunner({
      onLog: (lane, message) => this.appendLaneLog(lane, message, { persist: false }),
      onError: (lane, message) => this.recordAudit({
        type: 'lane_evidence_failed',
        actor: 'system',
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Evidence capture failed for lane ${lane.title}`,
        evidence: { lane, message },
        status: 'failed',
      }),
    });
    this.laneExecutorMap = new Map();
    this.unknownExecutorAdapters = new Map();

    fs.mkdir(this.artifactRoot, { recursive: true }).catch(() => {});
    fs.mkdir(this.workspacesRoot, { recursive: true }).catch(() => {});
    this.restoreFromDisk();
    if (!this.projects.length && parseBooleanEnv(process.env.ORCA_SEED, false)) {
      this.seed();
    }
    this.startScheduler();
  }

  restoreFromDisk() {
    const fallback = {
      version: 1,
      projects: [],
      sessions: [],
      lanes: [],
      auditEvents: [],
      mcpTools: [],
      toolLeases: [],
      notifications: [],
      notificationSettings: { ...DEFAULT_NOTIFICATION_SETTINGS },
      policies: {},
      cleanupSchedule: {},
    };
    const recovered = readJsonFileWithRecoverySync(this.stateFile, { fallback });
    this.stateLoadStatus = recovered.status;
    try {
      const parsed = recovered.data || fallback;
      this.projects = safeArray(parsed.projects).map((project) => ({
        ...project,
        quickLinks: normalizeQuickLinks(project.quickLinks || []),
      }));
      this.sessions = safeArray(parsed.sessions);
      this.lanes = safeArray(parsed.lanes);
      this.auditEvents = safeArray(parsed.auditEvents, []).slice(0, 200);
      // Never let persisted (potentially tampered) state weaken an approval
      // gate. Start from the hardcoded defaults; for known actions the default
      // `requiresApproval` and `risk` always win. Disk may only carry custom
      // messages or add entries for actions not present in defaults.
      if (parsed.policies && typeof parsed.policies === 'object') {
        const mergedPolicies = { ...defaultPolicy };
        for (const [action, value] of Object.entries(parsed.policies)) {
          if (!value || typeof value !== 'object') continue;
          const base = defaultPolicy[action];
          if (base) {
            mergedPolicies[action] = {
              ...base,
              message: typeof value.message === 'string' ? value.message : base.message,
            };
          } else {
            mergedPolicies[action] = {
              requiresApproval: value.requiresApproval !== false,
              risk: ['low', 'medium', 'high'].includes(value.risk) ? value.risk : 'high',
              message: typeof value.message === 'string' ? value.message : `${action} requires approval.`,
            };
          }
        }
        this.policies = mergedPolicies;
      }
      if (Array.isArray(parsed.mcpTools)) {
        this.mcpTools = parsed.mcpTools;
      }
      if (Array.isArray(parsed.toolLeases)) {
        this.toolLeases = parsed.toolLeases.filter((lease) => lease && typeof lease.id === 'string').slice(0, 500);
      }
      if (Array.isArray(parsed.notifications)) {
        this.notifications = parsed.notifications
          .filter((item) => item && typeof item.id === 'string')
          .slice(0, 200);
      }
      this.notificationSettings = sanitizeNotificationSettings(
        parsed.notificationSettings || {},
        this.notificationSettings,
      );
      if (parsed.cleanupSchedule && typeof parsed.cleanupSchedule === 'object') {
        this.cleanupSchedule = {
          ...this.cleanupSchedule,
          ...parsed.cleanupSchedule,
        };
      }
      this.ensureSessionWorkspaces();
      this.recoverInterruptedLanes();
      if (this.stateLoadStatus?.recovered || this.stateLoadStatus?.ok === false) {
        this.auditEvents.unshift({
          id: randomUUID(),
          type: 'registry_state_recovered',
          actor: 'system',
          status: this.stateLoadStatus.ok ? 'passed' : 'failed',
          summary: `Registry state loaded from ${this.stateLoadStatus.source}`,
          createdAt: nowIso(),
          evidence: {
            source: this.stateLoadStatus.source,
            recovered: this.stateLoadStatus.recovered,
            filePath: this.stateLoadStatus.filePath,
            backupPath: this.stateLoadStatus.backupPath,
            corruptPath: this.stateLoadStatus.corruptPath,
            reason: this.stateLoadStatus.reason,
            backupReason: this.stateLoadStatus.backupReason,
          },
        });
        this.auditEvents = this.auditEvents.slice(0, 200);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Failed to restore persisted Orca state:', error);
      }
      return;
    } finally {
      this._storageReady = true;
    }
  }

  // Monotonic counter bumped on any state change; SSE clients diff it to know
  // when to refresh (live push instead of fixed-interval polling).
  getStreamRevision() {
    return this._streamRevision || 0;
  }

  async persistState() {
    this._streamRevision = (this._streamRevision || 0) + 1;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      const write = (async () => {
        try {
          await fs.mkdir(this.storageDir, { recursive: true });
          await writeJsonFileAtomic(this.stateFile, this.snapshotState());
        } catch (error) {
          console.error('Persist failed:', error);
        }
      })();
      this._trackAsync(write);
    }, 250);
    this._persistTimer.unref?.();
  }

  snapshotState() {
    return {
      version: 1,
      savedAt: nowIso(),
      policies: this.policies,
      projects: this.projects,
      sessions: this.sessions,
      lanes: this.lanes,
      auditEvents: this.auditEvents,
      cleanupSchedule: this.cleanupSchedule,
      mcpTools: this.mcpTools,
      toolLeases: this.toolLeases,
      notifications: this.notifications,
      notificationSettings: this.notificationSettings,
    };
  }

  ensureSessionWorkspaces() {
    let migrated = false;
    for (const session of this.sessions) {
      if (!session) continue;
      if (!session.id) {
        session.id = randomUUID();
        migrated = true;
      }

      if (!session.artifactsRoot) {
        session.artifactsRoot = path.join(this.artifactRoot, session.id);
        migrated = true;
      }
      if (!session.worktreeRoot) {
        session.worktreeRoot = path.join(this.workspacesRoot, session.id);
        migrated = true;
      }
      if (!Number.isFinite(Number.parseInt(session.approvedCapacity, 10))) {
        session.approvedCapacity = normalizeApprovedCapacity(session.laneConcurrencyLimit, DEFAULT_APPROVED_CAPACITY);
        migrated = true;
      }
      const normalizedSpawn = normalizeSpawnPolicy(session.spawnPolicy);
      if (normalizedSpawn !== session.spawnPolicy) {
        session.spawnPolicy = normalizedSpawn;
        migrated = true;
      }
      if (typeof session.soloMode !== 'boolean') {
        session.soloMode = true;
        migrated = true;
      }
      const normalizedIdle = normalizeIdleShutdownMode(session.idleShutdownMode);
      if (normalizedIdle !== session.idleShutdownMode) {
        session.idleShutdownMode = normalizedIdle;
        migrated = true;
      }
      if (!Array.isArray(session.capacityRequests)) {
        session.capacityRequests = [];
        migrated = true;
      }
      const normalizedCritique = normalizeCritiqueMode(session.critiqueMode);
      if (normalizedCritique !== session.critiqueMode) {
        session.critiqueMode = normalizedCritique;
        migrated = true;
      }
      ensureDirectorySync(session.artifactsRoot);
      ensureDirectorySync(session.worktreeRoot);
    }

    if (migrated) {
      this.persistState().catch(() => {});
    }
  }

  getSessionWorktreeRoot(session) {
    if (!session || !session.id) {
      return path.join(this.workspacesRoot, 'orphan');
    }
    return path.resolve(session.worktreeRoot || path.join(this.workspacesRoot, session.id));
  }

  getApprovedRepoRoots() {
    const env = process.env.ORCA_REPO_ROOTS;
    const fromEnv = String(env || '')
      .split(/[,\n]/)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map((value) => path.resolve(value));
    return [process.cwd(), ...fromEnv];
  }

  resolveLaneWorkdir(session, rawWorkdir) {
    const sessionWorkdir = this.getSessionWorktreeRoot(session);
    const requested = sanitizeWorkdirInput(rawWorkdir);
    if (requested === '__INVALID_LENGTH__') {
      throw {
        status: 422,
        message: 'Lane workdir path is too long.',
      };
    }
    if (requested === '__INVALID_BYTES__') {
      throw {
        status: 422,
        message: 'Lane workdir path contains invalid characters.',
      };
    }
    // Relative workdirs MUST resolve under the session worktreeRoot (no escape).
    // Absolute workdirs may live within the session worktreeRoot OR within an
    // approved repo root (default: process.cwd()).
    let workdir;
    if (!requested) {
      workdir = sessionWorkdir;
    } else if (path.isAbsolute(requested)) {
      workdir = path.resolve(requested);
      const approvedRoots = [sessionWorkdir, ...this.getApprovedRepoRoots()];
      const within = approvedRoots.some((root) => isPathWithinBoundary(workdir, root));
      if (!within) {
        throw {
          status: 422,
          message: 'Lane workdir is outside approved execution roots.',
        };
      }
    } else {
      workdir = path.resolve(sessionWorkdir, requested);
      if (!isPathWithinBoundary(workdir, sessionWorkdir)) {
        throw {
          status: 422,
          message: 'Lane workdir is outside the session workspace boundary.',
        };
      }
    }
    try {
      ensureDirectorySync(workdir);
    } catch {
      throw {
        status: 422,
        message: 'Lane workdir could not be created.',
      };
    }
    return workdir;
  }

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
      if ([RUNNING_STATE, STARTING_STATE].includes(lane.state)) {
        this.markLaneFailed(lane, 'Controller restarted while lane was active', 'system', false);
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
  }

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
  }

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
  }


  getLane(locator) {
    return this.lanes.find((lane) => lane.id === locator);
  }

  async captureLaneEvidence(laneLocator, {
    url,
    presetId,
    modes,
    timeoutMs,
    oneTimeUrlApproved = false,
    allowSensitiveCapture = false,
    approved,
    actor = 'dashboard',
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('captureEvidence', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const presetList = this.getEvidencePresets(lane.id).presets || [];
    const requestedPresetId = sanitizeQuickLinkText(presetId || '', '', 160);
    if (requestedPresetId && url) {
      throw { status: 422, message: 'Use either presetId or url for evidence capture, not both.' };
    }
    const preset = requestedPresetId
      ? presetList.find((item) => item.id === requestedPresetId)
      : null;
    if (requestedPresetId && !preset) {
      throw { status: 404, message: 'Evidence preset not found.' };
    }
    const allowedUrls = presetList.map((item) => item.url).filter(Boolean);
    const requestedUrl = String(preset?.url || url || presetList[0]?.url || lane.targetUrl || '').trim();
    const networkPolicy = validateEvidenceUrl(requestedUrl, {
      allowedUrls,
      oneTimeApproved: oneTimeUrlApproved,
      allowSensitive: allowSensitiveCapture,
    });

    const result = await this.evidenceRunner.capture(lane, {
      url: networkPolicy.url,
      modes,
      timeoutMs,
      actor,
      networkPolicy,
    });
    lane.lastEvidenceCaptureAt = nowIso();
    lane.lastEvidence = result.evidence || null;

    if (result.captured) {
      this.recordAudit({
        type: 'lane_evidence_captured',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Evidence captured for lane ${lane.title}`,
        evidence: result.evidence,
        status: 'passed',
      });
      this.appendLaneLog(lane, `Evidence capture completed for ${networkPolicy.url}.`);
    } else {
      this.recordAudit({
        type: 'lane_evidence_failed',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Evidence capture failed for lane ${lane.title}`,
        evidence: result.evidence || { reason: result.reason || 'Failed to capture evidence.' },
        status: 'failed',
      });
      this.appendLaneLog(lane, `Evidence capture failed: ${result.reason || 'failed'}`);
    }

    this.persistState();
    return result;
  }

  getExecutorForType(executorType = 'mock') {
    const normalized = String(executorType || 'mock').toLowerCase();
    if (this.executors[normalized]) return this.executors[normalized];
    return this.getUnknownExecutor(normalized);
  }

  getUnknownExecutor(executorType = 'mock') {
    const normalized = String(executorType || 'mock').toLowerCase();
    if (this.unknownExecutorAdapters.has(normalized)) {
      return this.unknownExecutorAdapters.get(normalized);
    }

    const callbackBundle = {
      onLog: (lane, message) => this.appendLaneLog(lane, message, { persist: false }),
      onAgentEvent: (lane, agentEvent) => this.appendLaneAgentEvent(lane, agentEvent, { persist: false }),
      onComplete: async (lane) => this.markLaneCompleted(lane),
      onFail: async (lane, reason) => this.markLaneFailed(lane, reason, 'scheduler'),
      onStop: async (lane, context) => this.markLaneStopped(lane, context),
      credentialStore: this.credentialStore,
      providerProfileStore: this.providerProfileStore,
      runtimeEnvForLane: (lane) => this.laneRuntimeEnv.get(String(lane?.id || '')) || {},
    };
    const adapter = createExecutorAdapter(normalized, callbackBundle);
    this.unknownExecutorAdapters.set(normalized, adapter);
    return adapter;
  }

  getExecutorForLane(lane) {
    const mapped = this.laneExecutorMap.get(lane?.id);
    if (mapped) return mapped;
    return this.getExecutorForType(lane?.executorType || 'mock');
  }

  setLaneExecutor(laneId, executor) {
    if (!laneId || !executor) return;
    this.laneExecutorMap.set(String(laneId), executor);
  }

  clearLaneExecutor(laneId) {
    if (!laneId) return;
    this.laneExecutorMap.delete(String(laneId));
  }

  getRunningCountForSession(sessionId) {
    let count = 0;
    for (const executor of Object.values(this.executors)) {
      count += executor.getRunningCountForSession(sessionId);
    }
    for (const executor of this.unknownExecutorAdapters.values()) {
      count += executor.getRunningCountForSession(sessionId);
    }
    return count;
  }

  async tickExecutors() {
    for (const executor of Object.values(this.executors)) {
      await executor.tick();
    }
    for (const executor of this.unknownExecutorAdapters.values()) {
      await executor.tick();
    }
  }


  listLanes(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    return clonePayload(this.lanes.filter((lane) => lane.sessionId === session.id));
  }

  // Executor handoff: marks a running lane ready for audit (or self-verification
  // if critique is required), recording the executor's summary and changed files.
  listAuditEvents({ status, sessionId, laneId } = {}) {
    let events = this.auditEvents;
    if (status) {
      events = events.filter((event) => event.status === status);
    }
    if (sessionId !== undefined) {
      const matchSessionId = String(sessionId);
      events = events.filter((event) => String(event.sessionId) === matchSessionId);
    }
    if (laneId !== undefined) {
      const matchLaneId = String(laneId);
      events = events.filter((event) => String(event.laneId) === matchLaneId);
    }
    return clonePayload(events);
  }

  acknowledgeAuditEvent(eventId, {
    actor = 'dashboard',
    notes,
  } = {}) {
    const event = this.auditEvents.find((item) => item.id === eventId);
    if (!event) {
      throw { status: 404, message: 'Audit event not found.' };
    }
    if (event.status !== 'pending') {
      throw {
        status: 409,
        message: `Audit event already ${event.status}; only pending events can be acknowledged.`,
      };
    }

    event.status = 'passed';
    event.reviewedBy = actor;
    event.reviewedAt = nowIso();
    if (notes) event.reviewNotes = notes;

    this.recordAudit({
      type: 'audit_event_acknowledged',
      actor,
      projectId: event.projectId,
      sessionId: event.sessionId,
      laneId: event.laneId,
      summary: `Audit event acknowledged for ${event.type}`,
      evidence: { sourceEventId: event.id },
      status: 'passed',
    });

    this.persistState();
    return clonePayload(event);
  }


  appendLaneLog(lane, message, { persist = false } = {}) {
    if (!lane || !message) return;
    if (!Array.isArray(lane.logs)) {
      lane.logs = [];
    }
    lane.logs.push({
      at: nowIso(),
      message,
    });
    // Cap per-lane log growth so a chatty/long-running lane can't grow state.json
    // (and every transcript write) without bound.
    if (lane.logs.length > MAX_LANE_LOG_ENTRIES) {
      lane.logs = lane.logs.slice(-MAX_LANE_LOG_ENTRIES);
    }
    lane.updatedAt = nowIso();
    this._streamRevision = (this._streamRevision || 0) + 1;
    if (!this._starting && persist) {
      this.persistState();
    }
  }

  appendLaneAgentEvent(lane, agentEvent, { persist = false } = {}) {
    if (!lane || !agentEvent || typeof agentEvent !== 'object') return;
    if (!Array.isArray(lane.agentEvents)) {
      lane.agentEvents = [];
    }
    const now = nowIso();
    lane.agentEvents.push({
      id: randomUUID(),
      at: now,
      source: String(agentEvent.source || lane.executorType || 'agent').slice(0, 80),
      type: String(agentEvent.type || 'event').slice(0, 120),
      title: agentEvent.title ? String(agentEvent.title).slice(0, 240) : '',
      content: agentEvent.content ? String(agentEvent.content).slice(0, 12000) : '',
      stream: agentEvent.stream ? String(agentEvent.stream).slice(0, 40) : '',
      command: agentEvent.command ? String(agentEvent.command).slice(0, 2000) : '',
      toolName: agentEvent.toolName ? String(agentEvent.toolName).slice(0, 160) : '',
      callId: agentEvent.callId ? String(agentEvent.callId).slice(0, 160) : '',
      externalSessionId: agentEvent.externalSessionId ? String(agentEvent.externalSessionId).slice(0, 200) : '',
      durationMs: Number.isFinite(agentEvent.durationMs) ? agentEvent.durationMs : null,
    });
    if (lane.agentEvents.length > MAX_AGENT_EVENT_ENTRIES) {
      lane.agentEvents = lane.agentEvents.slice(-MAX_AGENT_EVENT_ENTRIES);
    }
    lane.updatedAt = now;
    this._streamRevision = (this._streamRevision || 0) + 1;
    if (!this._starting && persist) {
      this.persistState();
    }
  }

  recordAudit(event) {
    const record = {
      id: randomUUID(),
      createdAt: nowIso(),
      status: event.status || 'pending',
      followUpQueued: event.followUpQueued || false,
      ...event,
    };
    this.auditEvents.unshift(record);
    if (this.auditEvents.length > 200) {
      this.auditEvents.pop();
    }
    this.persistState();
    return record.id;
  }

  async startScheduler() {
    if (this._schedulerRunning) return;
    this._schedulerRunning = true;
    this._starting = false;
    if (this.stateLoadStatus?.recovered || this.stateLoadStatus?.ok === false) {
      this.persistState();
    }
    while (this._schedulerRunning) {
      await sleep(this.heartbeatIntervalMs);
      await this.advanceLanes();
    }
  }

  stopScheduler() {
    this._schedulerRunning = false;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
      // Flush a final persist synchronously so drainPendingWrites can await it.
      const write = (async () => {
        try {
          await fs.mkdir(this.storageDir, { recursive: true });
          await writeJsonFileAtomic(this.stateFile, this.snapshotState());
        } catch {
          // Stop is best-effort; ignore persist failures during teardown.
        }
      })();
      this._trackAsync(write);
    }
  }

  _trackAsync(promise) {
    if (!promise || typeof promise.then !== 'function') return promise;
    this._pendingWrites.add(promise);
    promise.finally(() => this._pendingWrites.delete(promise));
    return promise;
  }

  async drainPendingWrites() {
    if (!this._pendingWrites || this._pendingWrites.size === 0) return;
    await Promise.allSettled([...this._pendingWrites]);
  }

  async advanceLanes() {
    await this.tickExecutors();
    await this.runCleanupSchedulerTick().catch(() => {});

    const sessionById = new Map(this.sessions.map((session) => [session.id, session]));

    for (const session of sessionById.values()) {
      const sessionLanes = this.lanes.filter((lane) => lane.sessionId === session.id);
      const queued = sessionLanes
        .filter((lane) => lane.state === QUEUED_STATE)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const runningCount = this.getRunningCountForSession(session.id);
      const approvedCapacity = normalizeApprovedCapacity(session.approvedCapacity, normalizeApprovedCapacity(session.laneConcurrencyLimit));
      const capacityLimit = normalizeSpawnPolicy(session.spawnPolicy) === 'never' ? 0 : approvedCapacity;
      let availableSlots = Math.max(0, capacityLimit - runningCount);

      // Walk the queued list consuming a slot per actually-started lane, so a lane
      // that is no longer queued (raced to another state) is skipped without
      // burning a free slot.
      for (const lane of queued) {
        if (availableSlots <= 0) break;
        if (lane.state !== QUEUED_STATE) continue;
        availableSlots -= 1;
        const now = nowIso();
        lane.state = STARTING_STATE;
        lane.updatedAt = now;
        lane.startedAt = now;
        lane.completedAt = null;
        lane.exitReason = null;
        lane.heartbeatAt = now;
        this.appendLaneLog(lane, `Lane started by scheduler using ${lane.executorType} executor`, { persist: false });
        this.appendLaneAgentEvent(lane, {
          type: 'agent.started',
          source: lane.executorType,
          title: 'Agent process started',
          content: `Started ${lane.executorType} executor.`,
        });

        this.recordAudit({
          type: 'lane_started',
          actor: 'scheduler',
          projectId: lane.projectId,
          sessionId: session.id,
          laneId: lane.id,
          summary: `Lane ${lane.title} started`,
          evidence: { lane },
          status: 'passed',
        });

        this.ensureLaneToolLease(lane);
        const executor = this.getExecutorForLane(lane);
        try {
          const workerResult = await executor.start(lane);
          if (workerResult && workerResult.accepted) {
            lane.state = RUNNING_STATE;
            this.setLaneExecutor(lane.id, executor);
          } else {
            this.markLaneFailed(lane, workerResult?.reason || 'Failed to launch worker', 'scheduler', false);
          }
        } catch (error) {
          this.markLaneFailed(lane, error?.message || 'Unhandled scheduler error', 'scheduler', false);
        }
        this.persistState();
      }
    }
  }
}

// Tool-lease lifecycle + tool-state gating live in a focused module and are
// merged onto the prototype here, preserving the public API (registry.create
// ToolLease(...), registry.validateToolLease(...), etc.).
Object.assign(OrcaRegistry.prototype, toolLeaseMethods);
Object.assign(OrcaRegistry.prototype, notificationMethods);
Object.assign(OrcaRegistry.prototype, capacityMethods);
Object.assign(OrcaRegistry.prototype, executorCapabilityMethods);
Object.assign(OrcaRegistry.prototype, critiqueMethods);
Object.assign(OrcaRegistry.prototype, settingsMethods);
Object.assign(OrcaRegistry.prototype, auditMethods);
Object.assign(OrcaRegistry.prototype, evidenceMethods);
Object.assign(OrcaRegistry.prototype, projectMethods);
Object.assign(OrcaRegistry.prototype, mcpToolMethods);
Object.assign(OrcaRegistry.prototype, sessionMethods);
Object.assign(OrcaRegistry.prototype, orchestratorMethods);
Object.assign(OrcaRegistry.prototype, cleanupMethods);
Object.assign(OrcaRegistry.prototype, laneOpsMethods);
Object.assign(OrcaRegistry.prototype, laneTerminalMethods);
Object.assign(OrcaRegistry.prototype, laneCreateMethods);
