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

function isLiveLaneState(state) {
  return [QUEUED_STATE, STARTING_STATE, RUNNING_STATE].includes(String(state || '').toLowerCase());
}

function sanitizeWorkdirInput(raw) {
  if (raw === undefined || raw === null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  if (text.length > MAX_WORKDIR_BYTES) return '__INVALID_LENGTH__';
  if (/\x00/.test(text)) return '__INVALID_BYTES__';
  return text;
}

async function getDirectorySize(directoryPath) {
  let bytes = 0;
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        bytes += await getDirectorySize(resolved);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(resolved);
        bytes += stat.size || 0;
      } catch {
        continue;
      }
    }
  } catch {
    return 0;
  }
  return bytes;
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

function buildLaneRoute(projectSlug, sessionId, laneId) {
  return `/projects/${projectSlug}/sessions/${sessionId}/lanes/${laneId}`;
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


  getCleanupSchedule() {
    return clonePayload(this.cleanupSchedule);
  }

  updateCleanupSchedule({
    enabled,
    intervalHours,
    olderThanDays,
    sessionId,
    dryRun,
  } = {}, context = {}) {
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('manageCleanupSchedule', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const next = { ...this.cleanupSchedule };
    if (typeof enabled === 'boolean') {
      next.enabled = enabled;
    }

    const parsedInterval = parsePositiveFloat(intervalHours, null);
    if (intervalHours !== undefined) {
      if (parsedInterval === null) {
        throw { status: 422, message: 'intervalHours must be a positive number when provided.' };
      }
      if (parsedInterval > 720) {
        throw { status: 422, message: 'Cleanup interval cannot exceed 720 hours.' };
      }
      next.intervalHours = parsedInterval;
    }

    if (olderThanDays !== undefined) {
      if (olderThanDays === null) {
        next.olderThanDays = null;
      } else {
        const parsedRetention = parsePositiveInteger(olderThanDays, null);
        if (parsedRetention === null) {
          throw { status: 422, message: 'olderThanDays must be a positive integer or null.' };
        }
        next.olderThanDays = parsedRetention;
      }
    }

    if (typeof dryRun === 'boolean') {
      next.dryRun = dryRun;
    }

    if (sessionId) {
      const targetSession = this.getSession(sessionId);
      if (!targetSession) {
        throw { status: 404, message: 'Session not found.' };
      }
      next.sessionId = targetSession.id;
    } else if (sessionId === null) {
      next.sessionId = null;
    }

    if (next.enabled) {
      const cadenceMs = next.intervalHours * 60 * 60 * 1000;
      const now = Date.now();
      next.nextRunAt = new Date(now + cadenceMs).toISOString();
    } else {
      next.nextRunAt = null;
    }

    this.cleanupSchedule = next;
    this.recordAudit({
      type: 'cleanup_schedule_updated',
      actor,
      summary: `Artifact cleanup schedule ${next.enabled ? 'enabled' : 'disabled'}`,
      evidence: { cleanupSchedule: next },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(this.cleanupSchedule);
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

  createLane(sessionLocator, {
    title,
    taskDescription,
    executorType = 'mock',
    command,
    commandArgs = [],
    args,
    executorBinary,
    workdir,
    owner = 'dashboard',
    policyProfile = 'default',
    autoCompleteMs,
    heartbeatMs,
    mcpToolIds = [],
    taskPrompt,
    model,
    permissionsProfile,
    intelligenceProfile,
    verificationCommand,
    expectedArtifacts,
    targetUrl,
    critiqueMode,
    settingsOverrides,
    repoRoot,
    branch,
    sharedWorktree,
  }, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('createLane', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    if (!title || !String(title).trim()) {
      throw { status: 422, message: 'Lane title is required.' };
    }

    // Auto-create per-lane git worktree when the session has a vetted
    // repoRoot and the lane is not explicitly shared. This is the default
    // isolation model for implementation lanes.
    let workdirOverride = workdir;
    let reservedLaneId = null;
    let derivedWorktree = null;
    let derivedBranch = String(branch || '').trim();
    let derivedRepoRoot = String(repoRoot || '').trim();
    const sessionRepoRoot = session.repoRoot ? String(session.repoRoot).trim() : '';
    const wantsShared = Boolean(sharedWorktree);
    if (!wantsShared && sessionRepoRoot && !workdir) {
      const laneId = randomUUID();
      // Reserve the laneId via the create call below by reusing it for the worktree.
      const result = createLaneWorktree({
        repoRoot: sessionRepoRoot,
        worktreeBase: path.join(this.workspacesRoot, session.id, 'worktrees'),
        laneId,
        branchHint: derivedBranch,
      });
      if (!result.ok) {
        throw { status: 422, message: `Could not create lane worktree: ${result.reason}` };
      }
      workdirOverride = result.worktreePath;
      derivedWorktree = result.worktreePath;
      derivedBranch = result.branch || derivedBranch;
      derivedRepoRoot = result.repoRoot;
      // Reuse this laneId for the lane object below (local, so a later throw in
      // this method can never leak it into a subsequent createLane call).
      reservedLaneId = laneId;
    }
    const resolvedWorkdir = this.resolveLaneWorkdir(session, workdirOverride);

    const normalizedExecutorType = normalizeExecutorType(executorType);
    const supportedExecutorTypes = this.getSupportedExecutorTypes();
    if (!supportedExecutorTypes.includes(normalizedExecutorType)) {
      throw {
        status: 422,
        message: `Lane executorType must be one of: ${supportedExecutorTypes.join(', ')}.`,
      };
    }
    if (FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(normalizedExecutorType)) {
      const commandParts = String(command || '').trim().split(/\s+/).filter(Boolean);
      if (commandParts.length > 0 && !commandTargetsExecutorFirstToken(normalizedExecutorType, commandParts)) {
        throw {
          status: 422,
          message: `Lane command for ${normalizedExecutorType} must target an approved ${normalizedExecutorType} binary.`,
        };
      }
      if (!commandParts.length && executorBinary) {
        const normalizedBinary = String(executorBinary).trim().toLowerCase();
        const binaryName = path.basename(normalizedBinary);
        if (!commandTargetsExecutorFirstToken(normalizedExecutorType, [binaryName])) {
          throw {
            status: 422,
            message: `Lane executor binary for ${normalizedExecutorType} must target an approved ${normalizedExecutorType} binary.`,
          };
        }
      }
    }

    const project = this.projects.find((item) => item.id === session.projectId);
    const now = nowIso();
    const laneId = reservedLaneId || randomUUID();
    const scopedToolIds = new Set(this.listToolsForExecutor(normalizedExecutorType).map((tool) => tool.id));
    const resolvedToolIds = safeArray(mcpToolIds)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    const unknownToolIds = [];
    const disallowedToolIds = [];
    resolvedToolIds.forEach((toolId) => {
      const tool = this.getMcpTool(toolId);
      if (!tool) {
        unknownToolIds.push(toolId);
        return;
      }
      if (!scopedToolIds.has(tool.id) || !tool.enabled) {
        disallowedToolIds.push(tool.id);
      }
    });
    if (unknownToolIds.length || disallowedToolIds.length) {
      const details = [];
      if (unknownToolIds.length) {
        details.push(`Unknown MCP tools: ${unknownToolIds.join(', ')}`);
      }
      if (disallowedToolIds.length) {
        details.push(`Unauthorized MCP tools: ${disallowedToolIds.join(', ')}`);
      }
      throw {
        status: 422,
        message: `Cannot create lane: ${details.join('; ')}`,
      };
    }
    const mcpTools = resolvedToolIds
      .map((id) => this.getMcpTool(id))
      .filter((tool) => tool && scopedToolIds.has(tool.id))
      .filter((tool) => tool && tool.enabled)
      .map((tool) => ({
        id: tool.id,
        name: tool.name,
        command: tool.command,
        args: tool.args,
        scope: tool.scope,
      }));

    const sanitizedTaskPrompt = typeof taskPrompt === 'string' ? taskPrompt.trim().slice(0, 8000) : '';
    const sanitizedModel = typeof model === 'string' ? model.trim().slice(0, 120) : '';
    const sanitizedPermissionsProfile = typeof permissionsProfile === 'string'
      ? permissionsProfile.trim().slice(0, 120) : '';
    const sanitizedIntelligenceProfile = typeof intelligenceProfile === 'string'
      ? intelligenceProfile.trim().slice(0, 80) : '';
    const executorCapabilities = this.getExecutorCapabilities(normalizedExecutorType);
    const sanitizedVerificationCommand = typeof verificationCommand === 'string'
      ? verificationCommand.trim().slice(0, 1000) : '';
    const sanitizedTargetUrl = typeof targetUrl === 'string' && targetUrl.trim()
      ? validateNetworkUrl(targetUrl, { field: 'targetUrl', allowSensitive: false }).url
      : '';
    const normalizedCritiqueMode = normalizeCritiqueMode(
      critiqueMode,
      sanitizedTargetUrl ? 'visual-required' : normalizeCritiqueMode(session.critiqueMode, 'suggested'),
    );
    const sanitizedRepoRoot = (derivedRepoRoot || (typeof repoRoot === 'string' ? repoRoot.trim() : '')).slice(0, MAX_WORKDIR_BYTES);
    const sanitizedBranch = (derivedBranch || (typeof branch === 'string' ? branch.trim() : ''))
      .replace(/[^A-Za-z0-9._\-/]/g, '')
      .slice(0, 200);
    const expectedArtifactsList = Array.isArray(expectedArtifacts)
      ? expectedArtifacts.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 32)
      : [];

    const lane = {
      id: laneId,
      projectId: session.projectId,
      sessionId: session.id,
      title: String(title).trim(),
      taskDescription: String(taskDescription || '').trim(),
      executorType: normalizedExecutorType,
      command,
      commandArgs,
      args,
      executorBinary,
      workdir: resolvedWorkdir,
      policyProfile,
      settingsOverrides: sanitizeSettingsOverrides(settingsOverrides || {}),
      mcpTools,
      mcpToolIds: mcpTools.map((tool) => tool.id),
      taskPrompt: sanitizedTaskPrompt,
      model: sanitizedModel,
      permissionsProfile: sanitizedPermissionsProfile,
      intelligenceProfile: sanitizedIntelligenceProfile,
      executorCapabilities,
      verificationCommand: sanitizedVerificationCommand,
      expectedArtifacts: expectedArtifactsList,
      targetUrl: sanitizedTargetUrl,
      repoRoot: sanitizedRepoRoot,
      branch: sanitizedBranch,
      sharedWorktree: Boolean(sharedWorktree),
      worktreePath: derivedWorktree || resolvedWorkdir,
      state: QUEUED_STATE,
      owner,
      heartbeatAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      exitReason: null,
      processMeta: null,
      changedFiles: [],
      lastEvidenceCaptureAt: null,
      lastEvidence: null,
      critiqueMode: normalizedCritiqueMode,
      critiqueState: ['required', 'visual-required'].includes(normalizedCritiqueMode) ? 'needed' : 'not_required',
      critiqueRevision: 1,
      critiqueNonce: null,
      critiqueFindings: [],
      auditState: 'not_queued',
      auditFindings: [],
      route: buildLaneRoute(project.slug, session.id, laneId),
      runProfile: {
        autoCompleteMs: Number.parseInt(autoCompleteMs, 10) || this.autoCompleteMs,
        heartbeatIntervalMs: Number.parseInt(heartbeatMs, 10) || this.heartbeatIntervalMs,
      },
      logs: [
        {
          at: now,
          message: 'Lane queued by controller.',
        },
      ],
      agentEvents: [
        {
          id: randomUUID(),
          at: now,
          type: 'agent.queued',
          source: normalizedExecutorType,
          title: 'Lane queued',
          content: String(taskDescription || sanitizedTaskPrompt || title || '').trim().slice(0, 1000),
        },
      ],
      artifactPath: `/artifacts/${session.id}/${laneId}`,
    };

    if (project) {
      lane.projectSlug = project.slug;
      lane.projectName = project.name;
    }

    this.lanes.push(lane);
    this.recordAudit({
      type: 'lane_created',
      actor: owner,
      projectId: session.projectId,
      sessionId: session.id,
      laneId: lane.id,
      summary: `Lane "${lane.title}" queued`,
      evidence: { lane },
      status: 'passed',
    });
    if (lane.sharedWorktree) {
      // Shared-working-tree is a named exception: stronger conflict risk, so
      // an explicit audit event is queued for review and the lane stores a
      // visible warning the dashboard can surface.
      lane.warnings = [...(lane.warnings || []), {
        kind: 'shared_worktree',
        message: 'Lane is configured to share the session worktree. Concurrent edits may conflict.',
      }];
      this.recordAudit({
        type: 'lane_shared_worktree',
        actor: owner,
        projectId: session.projectId,
        sessionId: session.id,
        laneId: lane.id,
        summary: `Lane "${lane.title}" is shared-worktree; concurrent edits may conflict.`,
        evidence: { laneId: lane.id, workdir: lane.workdir, branch: lane.branch || null },
        status: 'pending',
        followUpQueued: true,
      });
    }
    this.persistState();
    return clonePayload(lane);
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
  submitLane(laneLocator, { actor = 'executor', summary = '', changedFiles = [], handoff = '' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const submittable = new Set([STARTING_STATE, RUNNING_STATE, NEEDS_CRITIQUE_STATE]);
    if (!submittable.has(lane.state)) {
      throw { status: 409, message: `Lane cannot be submitted from state "${lane.state}".` };
    }
    if (summary) lane.summary = String(summary).slice(0, 4000);
    if (Array.isArray(changedFiles) && changedFiles.length) {
      lane.changedFiles = changedFiles.map((file) => String(file).slice(0, 400)).slice(0, 500);
    }
    if (handoff) lane.handoff = String(handoff).slice(0, 4000);
    const needsCritique = this.critiqueRequiredForLane(lane) && !this.critiqueSatisfiedForLane(lane);
    lane.state = needsCritique ? NEEDS_CRITIQUE_STATE : READY_FOR_AUDIT_STATE;
    lane.submittedAt = nowIso();
    lane.updatedAt = nowIso();
    this.appendLaneAgentEvent(lane, {
      type: 'agent.submitted',
      title: 'Lane submitted for review',
      content: lane.summary || '',
    }, { persist: false });
    this.recordAudit({
      type: 'lane_submitted',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Lane ${lane.title} submitted (${needsCritique ? 'needs self-verification' : 'ready for audit'})`,
      status: needsCritique ? 'pending' : 'passed',
      evidence: { summary: lane.summary || '', changedFiles: lane.changedFiles || [] },
    });
    this.persistState();
    return { lane: clonePayload(lane), needsCritique };
  }

  // --- Permission-approval relay (Codex-app-style approval loop) -----------
  // An executor agent that hits a permission decision records a pending approval;
  // the orchestrator (or user) approves/denies; the decision is relayed back.
  recordLaneApproval(laneLocator, { kind = 'command', detail = '', requestId = '', actor = 'executor' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const normalizedKind = ['command', 'patch', 'tool', 'network', 'other'].includes(String(kind))
      ? String(kind) : 'other';
    const approval = {
      id: randomUUID(),
      requestId: String(requestId || '').slice(0, 200) || null,
      kind: normalizedKind,
      detail: String(detail || '').slice(0, 2000),
      status: 'pending',
      decision: null,
      requestedBy: String(actor || 'executor').slice(0, 120),
      requestedAt: nowIso(),
      decidedBy: null,
      decidedAt: null,
    };
    lane.pendingApprovals = [...safeArray(lane.pendingApprovals), approval].slice(-50);
    lane.awaitingApproval = true;
    lane.updatedAt = nowIso();
    this.appendLaneAgentEvent(lane, {
      type: 'agent.approval_requested',
      title: `Approval requested: ${approval.kind}`,
      content: approval.detail,
    }, { persist: false });
    this.recordAudit({
      type: 'lane_approval_requested',
      actor: approval.requestedBy,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Approval requested (${approval.kind}) for lane ${lane.title}`,
      status: 'pending',
      evidence: { approval },
    });
    this.persistState();
    return { lane: clonePayload(lane), approval: clonePayload(approval) };
  }

  decideLaneApproval(laneLocator, approvalId, { decision, actor = 'dashboard' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const normalized = String(decision || '').toLowerCase();
    const approve = ['approve', 'approved', 'allow', 'yes'].includes(normalized);
    const deny = ['deny', 'denied', 'reject', 'no'].includes(normalized);
    if (!approve && !deny) throw { status: 422, message: 'Decision must be approve or deny.' };
    const approval = safeArray(lane.pendingApprovals).find((entry) => entry.id === approvalId);
    if (!approval) throw { status: 404, message: 'Approval not found.' };
    if (approval.status !== 'pending') throw { status: 409, message: `Approval already ${approval.status}.` };
    approval.status = approve ? 'approved' : 'denied';
    approval.decision = approve ? 'approve' : 'deny';
    approval.decidedBy = String(actor || 'dashboard').slice(0, 120);
    approval.decidedAt = nowIso();
    lane.awaitingApproval = safeArray(lane.pendingApprovals).some((entry) => entry.status === 'pending');
    lane.updatedAt = nowIso();
    this.appendLaneAgentEvent(lane, {
      type: 'agent.approval_decided',
      title: `Approval ${approval.status}`,
      content: approval.detail,
    }, { persist: false });
    this.recordAudit({
      type: 'lane_approval_decided',
      actor: approval.decidedBy,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Approval ${approval.status} for lane ${lane.title}`,
      status: approve ? 'passed' : 'failed',
      evidence: { approval },
    });
    this.persistState();
    return { lane: clonePayload(lane), approval: clonePayload(approval) };
  }

  getLaneApprovals(laneLocator) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    return {
      laneId: lane.id,
      awaitingApproval: Boolean(lane.awaitingApproval),
      approvals: safeArray(lane.pendingApprovals).map(clonePayload),
    };
  }

  updateLaneControls(laneLocator, {
    model,
    permissionsProfile,
    intelligenceProfile,
  } = {}, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('updateLaneControls', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const before = {
      model: lane.model || '',
      permissionsProfile: lane.permissionsProfile || '',
      intelligenceProfile: lane.intelligenceProfile || '',
    };
    const next = {
      model: typeof model === 'string' ? model.trim().slice(0, 120) : before.model,
      permissionsProfile: typeof permissionsProfile === 'string' ? permissionsProfile.trim().slice(0, 120) : before.permissionsProfile,
      intelligenceProfile: typeof intelligenceProfile === 'string' ? intelligenceProfile.trim().slice(0, 80) : before.intelligenceProfile,
    };

    lane.model = next.model;
    lane.permissionsProfile = next.permissionsProfile;
    lane.intelligenceProfile = next.intelligenceProfile;
    lane.executorCapabilities = this.getExecutorCapabilities(lane.executorType);
    lane.updatedAt = nowIso();
    this.appendLaneLog(
      lane,
      `Lane controls updated: model=${next.model || 'default'}, mode=${next.permissionsProfile || 'default'}, intelligence=${next.intelligenceProfile || 'default'}.`,
      { persist: false },
    );
    this.appendLaneAgentEvent(lane, {
      type: 'agent.controls_updated',
      source: lane.executorType,
      title: 'Controls updated',
      content: `Model: ${next.model || 'default'}\nMode: ${next.permissionsProfile || 'default'}\nIntelligence: ${next.intelligenceProfile || 'default'}`,
    }, { persist: false });
    this.recordAudit({
      type: 'lane_controls_updated',
      actor: context.actor || 'dashboard',
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Updated controls for lane ${lane.title}`,
      status: 'passed',
      evidence: {
        before,
        after: next,
        runningProcess: isLiveLaneState(lane.state),
      },
    });
    this.persistState();
    return clonePayload(lane);
  }

  async stopLane(laneLocator, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('stopLane', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    if ([DONE_STATE, FAILED_STATE, STOPPED_STATE].includes(lane.state)) {
      this.clearLaneExecutor(lane.id);
      return clonePayload(lane);
    }

    const executor = this.getExecutorForLane(lane);
    const workerStopped = await executor.stop(lane.id, {
      actor: context.actor || 'dashboard',
      reason: `Stopped by ${context.actor || 'dashboard'}`,
    });
    if (!workerStopped.stopped) {
      const now = nowIso();
      lane.state = STOPPED_STATE;
      lane.exitReason = `Stopped by ${context.actor || 'dashboard'}`;
      lane.completedAt = now;
      lane.updatedAt = now;
      this.appendLaneLog(lane, lane.exitReason, { persist: false });
      this.appendLaneAgentEvent(lane, {
        type: 'agent.stopped',
        source: lane.executorType,
        title: 'Agent stopped',
        content: lane.exitReason,
      });
      this.notifyOrchestratorManualLaneStop(lane, context.actor || 'dashboard', lane.exitReason);
      this.recordAudit({
        type: 'lane_stopped',
        actor: context.actor || 'dashboard',
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Lane ${lane.title} stopped`,
        evidence: { lane },
        status: 'passed',
      });
      this.notifyLaneTerminal(
        lane,
        'warning',
        'Lane stopped',
        `${lane.title} stopped: ${lane.exitReason}`,
      );
    }
    this.clearLaneExecutor(lane.id);
    this.persistState();
    return clonePayload(lane);
  }

  retryLane(laneLocator, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('retryLane', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    if (![FAILED_STATE, STOPPED_STATE, FIX_REQUESTED_STATE].includes(lane.state)) {
      throw { status: 409, message: `Lane state "${lane.state}" is not retryable.` };
    }
    this.clearLaneExecutor(lane.id);

    lane.state = QUEUED_STATE;
    lane.updatedAt = nowIso();
    lane.exitReason = null;
    lane.completedAt = null;
    lane.startedAt = null;
    lane.auditState = 'not_queued';
    lane.critiqueState = this.critiqueRequiredForLane(lane) ? 'needed' : 'not_required';
    lane.critiqueNonce = null;
    lane.critiqueRevision = (Number.parseInt(lane.critiqueRevision, 10) || 1) + 1;
    this.appendLaneLog(lane, `Retry requested by ${context.actor || 'dashboard'}`);
    this.recordAudit({
      type: 'lane_retried',
      actor: context.actor || 'dashboard',
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Retry requested for lane ${lane.title}`,
      evidence: { lane },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(lane);
  }


  async touchHeartbeat(laneLocator, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const executor = this.getExecutorForLane(lane);
    const updated = executor.touchHeartbeat(lane.id, context.actor || 'mock-worker');
    if (!updated) {
      return clonePayload(lane);
    }
    lane.heartbeatAt = nowIso();
    return clonePayload(lane);
  }

  async listArtifactFiles(laneLocator) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const laneDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
    try {
      const entries = await fs.readdir(laneDir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        // Defense-in-depth: ensure the entry resolves inside laneDir even if
        // the filesystem races a symlink swap between readdir and lstat.
        try {
          const resolved = await fs.realpath(path.join(laneDir, entry.name));
          const laneReal = await fs.realpath(laneDir);
          if (resolved !== path.join(laneReal, entry.name)) continue;
        } catch {
          continue;
        }
        files.push(entry.name);
      }
      return files.sort();
    } catch {
      return [];
    }
  }

  async cleanupArtifacts({
    actor = 'dashboard',
    approved,
    skipApproval = false,
    dryRun = false,
    confirmed = false,
    sessionId = null,
    olderThanDays = null,
  } = {}) {
    const policyCheck = this.evaluateActionPolicy('cleanupArtifacts', {
      actor,
      approved,
      skipApproval,
    });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const isDryRun = Boolean(dryRun);
    if (!isDryRun && !skipApproval && !confirmed) {
      throw {
        status: 409,
        message: 'Destructive cleanup requires explicit confirmation.',
        risk: defaultPolicy.cleanupArtifacts.risk,
      };
    }

    const targetSessions = sessionId
      ? this.sessions.filter((session) => session.id === String(sessionId))
      : this.sessions;
    if (sessionId && !targetSessions.length) {
      throw {
        status: 404,
        message: 'Session not found.',
      };
    }

    const terminalStates = new Set([DONE_STATE, READY_FOR_AUDIT_STATE, ACCEPTED_STATE, FIX_REQUESTED_STATE, BLOCKED_STATE, FAILED_STATE, STOPPED_STATE]);
    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;
    const summary = {
      scanned: 0,
      candidates: 0,
      removed: 0,
      removedLanes: [],
      dryRun,
      errors: 0,
      removedBytes: 0,
      sessionId: sessionId ? String(sessionId) : null,
      olderThanDays: parsePositiveInteger(olderThanDays, null),
    };
    const fallbackRetentionDays = 14;

    for (const session of targetSessions) {
      const retentionDays = parsePositiveInteger(session.artifactRetentionDays, fallbackRetentionDays);
      // An explicit olderThanDays from the caller takes precedence (operator asked
      // for a specific window); otherwise fall back to the session's retention.
      const effectiveRetentionDays = summary.olderThanDays || retentionDays;
      const deadline = now - (effectiveRetentionDays * msPerDay);
      const sessionLanes = this.lanes.filter((lane) => lane.sessionId === session.id && terminalStates.has(lane.state));
      for (const lane of sessionLanes) {
        summary.scanned += 1;
        const laneTimestamp = new Date(lane.completedAt || lane.updatedAt || lane.createdAt).getTime();
        if (!Number.isFinite(laneTimestamp) || laneTimestamp >= deadline) {
          continue;
        }

        summary.candidates += 1;
        if (dryRun) continue;
        const laneDir = path.join(process.cwd(), 'artifacts', session.id, lane.id);
        try {
          const laneBytes = await getDirectorySize(laneDir);
          await fs.rm(laneDir, { recursive: true, force: true });
          summary.removed += 1;
          summary.removedBytes += laneBytes;
          summary.removedLanes.push({
            laneId: lane.id,
            sessionId: session.id,
            removedBytes: laneBytes,
            removed: true,
          });
        } catch (error) {
          summary.errors += 1;
          summary.removedLanes.push({
            laneId: lane.id,
            sessionId: session.id,
            removed: false,
            reason: error?.message || 'Unknown error.',
          });
        }
      }
    }

    if (!dryRun) {
      this.recordAudit({
        type: 'artifacts_cleanup',
        actor,
        summary: `Artifact cleanup completed (dryRun=${dryRun}, sessionId=${sessionId || 'all'}, olderThanDays=${summary.olderThanDays || 'default'})`,
        evidence: {
          removed: summary.removed,
          candidates: summary.candidates,
          scanned: summary.scanned,
          errors: summary.errors,
          removedBytes: summary.removedBytes,
          sessionId: summary.sessionId,
          olderThanDays: summary.olderThanDays,
          dryRun,
        },
        status: 'passed',
      });
    }

    this.persistState();
    return summary;
  }

  async runCleanupSchedulerTick() {
    if (!this.cleanupSchedule.enabled) return;
    if (!this.cleanupSchedule.nextRunAt) return;

    const now = Date.now();
    const next = Date.parse(this.cleanupSchedule.nextRunAt);
    if (!Number.isFinite(next) || now < next) return;

    const result = await this.cleanupArtifacts({
      actor: 'scheduler',
      approved: true,
      skipApproval: true,
      sessionId: this.cleanupSchedule.sessionId,
      olderThanDays: this.cleanupSchedule.olderThanDays,
      dryRun: Boolean(this.cleanupSchedule.dryRun),
    });

    const cadenceMs = (parsePositiveFloat(this.cleanupSchedule.intervalHours, 24) || 24) * 60 * 60 * 1000;
    this._lastTickMs = (this._lastTickMs || 0) + 1;
    this.cleanupSchedule.lastRunAt = nowIso();
    this.cleanupSchedule.nextRunAt = new Date(now + cadenceMs + this._lastTickMs).toISOString();
    this.recordAudit({
      type: 'artifacts_cleanup_scheduler_run',
      actor: 'scheduler',
      summary: 'Automatic artifact cleanup executed',
      evidence: {
        removed: result.removed,
        removedLanes: result.removedLanes,
        candidates: result.candidates,
        scanned: result.scanned,
        dryRun: result.dryRun,
      },
      status: 'passed',
    });
    this.persistState();
  }


  async removeLaneWorktree(laneLocator, { actor = 'dashboard', approved, removeBranch = false } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    if (!lane.repoRoot || !lane.worktreePath) {
      throw { status: 422, message: 'Lane has no managed worktree to remove.' };
    }
    const policyCheck = this.evaluateActionPolicy('cleanupArtifacts', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    if (![DONE_STATE, READY_FOR_AUDIT_STATE, ACCEPTED_STATE, FIX_REQUESTED_STATE, BLOCKED_STATE, FAILED_STATE, STOPPED_STATE].includes(lane.state)) {
      throw { status: 409, message: 'Lane is still active; stop it before removing its worktree.' };
    }
    const result = removeLaneWorktree({
      repoRoot: lane.repoRoot,
      worktreePath: lane.worktreePath,
      removeBranch,
      branch: lane.branch || null,
    });
    if (!result.removed) {
      throw { status: 500, message: result.reason || 'Could not remove worktree.' };
    }
    lane.worktreePath = '';
    this.recordAudit({
      type: 'lane_worktree_removed',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Worktree removed for lane ${lane.title}`,
      evidence: { lane, branchRemoved: result.branchRemoved },
      status: 'passed',
    });
    this.persistState();
    return { removed: true, branchRemoved: result.branchRemoved };
  }

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

  markLaneCompleted(lane) {
    const now = nowIso();
    const needsCritique = this.critiqueRequiredForLane(lane) && !this.critiqueSatisfiedForLane(lane);
    lane.state = needsCritique ? NEEDS_CRITIQUE_STATE : DONE_STATE;
    lane.updatedAt = now;
    lane.completedAt = now;
    const executorLabel = String(lane.executorType || 'mock');
    lane.exitReason = needsCritique
      ? 'Execution completed; self-verification required before audit.'
      : `${executorLabel} execution completed`;
    this.appendLaneLog(lane, lane.exitReason, { persist: false });
    this.appendLaneAgentEvent(lane, {
      type: needsCritique ? 'agent.needs_critique' : 'agent.done',
      source: lane.executorType,
      title: needsCritique ? 'Needs self-check' : 'Agent completed',
      content: lane.exitReason,
    });
    this.recordAudit({
      type: needsCritique ? 'lane_needs_critique' : 'lane_completed',
      // Attribute completion to the lane's actual executor, not always the mock.
      actor: `${executorLabel}-worker`,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: needsCritique ? `Lane ${lane.title} needs self-verification` : `Lane ${lane.title} completed`,
      evidence: { lane },
      status: needsCritique ? 'pending' : 'passed',
      followUpQueued: needsCritique,
    });
    this.notifyLaneTerminal(
      lane,
      needsCritique ? 'warning' : 'success',
      needsCritique ? 'Lane needs self-check' : 'Lane completed',
      needsCritique
        ? `${lane.title} needs self-verification before audit.`
        : `${lane.title} finished successfully.`,
    );
    this._trackAsync(this.writeLaneArtifacts(lane, lane.state).catch(() => {}));
    this.clearLaneExecutor(lane.id);
    this.laneRuntimeEnv.delete(String(lane.id));
    this.persistState();
  }

  markLaneFailed(lane, reason, actor = 'scheduler', persist = true) {
    const now = nowIso();
    lane.state = FAILED_STATE;
    lane.updatedAt = now;
    lane.completedAt = now;
    lane.exitReason = reason || 'Execution failed';
    this.appendLaneLog(lane, lane.exitReason, { persist: false });
    this.appendLaneAgentEvent(lane, {
      type: 'agent.failed',
      source: lane.executorType,
      title: 'Agent failed',
      content: lane.exitReason,
    });
    this.recordAudit({
      type: 'lane_failed',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Lane ${lane.title} failed`,
      evidence: { lane },
      status: 'failed',
    });
    this.notifyLaneTerminal(
      lane,
      'error',
      'Lane failed',
      `${lane.title} failed: ${lane.exitReason}`,
    );
    this._trackAsync(this.writeLaneArtifacts(lane, 'failed').catch(() => {}));
    this.clearLaneExecutor(lane.id);
    this.laneRuntimeEnv.delete(String(lane.id));
    if (persist) this.persistState();
  }

  markLaneStopped(lane, context = {}) {
    const now = nowIso();
    const actor = context.actor || 'scheduler';
    const reason = context.reason || `Stopped by ${actor}`;
    lane.state = STOPPED_STATE;
    lane.updatedAt = now;
    lane.completedAt = now;
    lane.exitReason = reason;
    this.appendLaneLog(lane, reason, { persist: false });
    this.appendLaneAgentEvent(lane, {
      type: 'agent.stopped',
      source: lane.executorType,
      title: 'Agent stopped',
      content: reason,
    });
    this.notifyOrchestratorManualLaneStop(lane, actor, reason);
    this.recordAudit({
      type: 'lane_stopped',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Lane ${lane.title} stopped`,
      evidence: { lane },
      status: 'passed',
    });
    this.notifyLaneTerminal(
      lane,
      'warning',
      'Lane stopped',
      `${lane.title} stopped: ${reason}`,
    );
    this._trackAsync(this.writeLaneArtifacts(lane, 'stopped').catch(() => {}));
    this.clearLaneExecutor(lane.id);
    this.laneRuntimeEnv.delete(String(lane.id));
    this.persistState();
  }

  async writeLaneArtifacts(lane, status = DONE_STATE) {
    const laneArtifactDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
    await fs.mkdir(laneArtifactDir, { recursive: true });
    // Capture changed-files via git status when the lane lives in a git worktree.
    let changedFiles = Array.isArray(lane.changedFiles) ? lane.changedFiles : [];
    if (lane.worktreePath || lane.workdir) {
      const result = changedFilesIn(lane.worktreePath || lane.workdir);
      if (result.length) changedFiles = result;
    }
    lane.changedFiles = changedFiles;

    const evidenceSummary = lane.lastEvidence
      ? {
          status: lane.lastEvidence.status || null,
          capturedAt: lane.lastEvidenceCaptureAt || null,
          produced: Array.isArray(lane.lastEvidence.produced) ? lane.lastEvidence.produced : [],
          requested: Array.isArray(lane.lastEvidence.requested) ? lane.lastEvidence.requested : [],
          error: lane.lastEvidence.error || null,
        }
      : null;

    await fs.writeFile(
      path.join(laneArtifactDir, 'outcome.txt'),
      `Lane ${lane.id} completed at ${lane.completedAt}
Title: ${lane.title || ''}
Task: ${lane.taskDescription || 'No task description'}
Task prompt: ${lane.taskPrompt || ''}
Status: ${status}
Exit reason: ${lane.exitReason || ''}
Executor: ${lane.executorType}
Model: ${lane.model || ''}
Permissions profile: ${lane.permissionsProfile || ''}
Intelligence profile: ${lane.intelligenceProfile || ''}
Branch: ${lane.branch || ''}
Workdir: ${lane.workdir || ''}
MCP config: ${lane.mcpConfigPath || ''}
Verification command: ${lane.verificationCommand || ''}
Process PID: ${lane.processMeta?.pid ?? ''}
Exit code: ${lane.processMeta?.exitCode ?? ''}
Signal: ${lane.processMeta?.signal ?? ''}
Stop requested by: ${lane.processMeta?.stopRequestedBy ?? ''}
Stop result: ${lane.processMeta?.stopResult ?? ''}
Changed files: ${changedFiles.length}
`,
    );
    await fs.writeFile(path.join(laneArtifactDir, 'transcript.json'), JSON.stringify({
      laneId: lane.id,
      title: lane.title,
      logs: lane.logs,
      agentEvents: lane.agentEvents || [],
      terminalArtifacts: ['terminal.log', 'stdout.log', 'stderr.log'],
      completedAt: lane.completedAt,
      status,
      taskDescription: lane.taskDescription,
      taskPrompt: lane.taskPrompt || null,
      model: lane.model || null,
      permissionsProfile: lane.permissionsProfile || null,
      intelligenceProfile: lane.intelligenceProfile || null,
      branch: lane.branch || null,
      repoRoot: lane.repoRoot || null,
      worktreePath: lane.worktreePath || lane.workdir || null,
      verificationCommand: lane.verificationCommand || null,
      expectedArtifacts: lane.expectedArtifacts || [],
      targetUrl: lane.targetUrl || null,
      mcpConfigPath: lane.mcpConfigPath || null,
      mcpTools: lane.mcpTools || [],
      command: lane.command || null,
      commandArgs: lane.commandArgs || null,
      executorBinary: lane.executorBinary || null,
      workdir: lane.workdir || null,
      sessionId: lane.sessionId,
      projectId: lane.projectId,
      processMeta: lane.processMeta || null,
      changedFiles,
      evidence: evidenceSummary,
      exitReason: lane.exitReason || null,
    }, null, 2));
    lane.artifactPath = `/artifacts/${lane.sessionId}/${lane.id}`;
    return clonePayload({
      files: ['outcome.txt', 'transcript.json'],
      artifactPath: lane.artifactPath,
      changedFiles,
      evidence: evidenceSummary,
    });
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
