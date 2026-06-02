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
const MCP_TOOL_SCOPE_ALLOWLIST = new Set([
  'all',
  'mock',
  'codex',
  'claude',
  'gemini-cli',
  'composer-cli',
  'cli',
  'custom-cli',
  'api',
  'openai-compatible',
  'gemini',
  'kimi',
  'deepseek',
  'openrouter',
  'composer',
]);
const MAX_MCP_TOOL_ARG_LENGTH = 255;
const MAX_MCP_TOOL_ARGS = 64;
const SPAWN_POLICIES = new Set(['never', 'ask', 'within_capacity', 'auto']);
const IDLE_SHUTDOWN_MODES = new Set(['immediate', 'short_keepalive', 'policy']);
const CRITIQUE_MODES = new Set(['off', 'suggested', 'required', 'visual-required']);
const DEFAULT_APPROVED_CAPACITY = 2;
const CLI_CAPABILITY_CACHE_MS = 30 * 1000;
const MAX_CLI_CAPABILITY_CACHE_ENTRIES = 50;
const cliCapabilityCache = new Map();

function normalizeSpawnPolicy(value, fallback = 'within_capacity') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return SPAWN_POLICIES.has(normalized) ? normalized : fallback;
}

function normalizeIdleShutdownMode(value, fallback = 'immediate') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return IDLE_SHUTDOWN_MODES.has(normalized) ? normalized : fallback;
}

function normalizeCritiqueMode(value, fallback = 'suggested') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return CRITIQUE_MODES.has(normalized) ? normalized : fallback;
}

function normalizeApprovedCapacity(value, fallback = DEFAULT_APPROVED_CAPACITY) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(64, parsed);
}

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

function getMcpCommandAllowlist() {
  const override = process.env.ORCA_MCP_TOOL_COMMAND_ALLOWLIST;
  if (!override) return null;
  return String(override)
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
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

const defaultPolicy = {
  createProject: {
    requiresApproval: true,
    risk: 'high',
    message: 'Creating a project can change dashboard topology and expose automation surfaces.',
  },
  createLane: {
    requiresApproval: true,
    risk: 'high',
    message: 'Spawns executor process and can mutate workspace state.',
  },
  createSession: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Creates project coordination sessions and increases execution capacity.',
  },
  updateSession: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Session updates can change execution limits and operational state.',
  },
  updateProject: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Project updates can alter routes, quick links, and routing state.',
  },
  stopLane: {
    requiresApproval: true,
    risk: 'high',
    message: 'Stops an active lane and may lose in-flight state.',
  },
  retryLane: {
    requiresApproval: false,
    risk: 'medium',
    message: 'Replays a lane from last known terminal state.',
  },
  updateLaneControls: {
    requiresApproval: true,
    risk: 'high',
    message: 'Changes agent model, mode, or intelligence controls for a lane.',
  },
  auditLane: {
    requiresApproval: false,
    risk: 'medium',
    message: 'Queues lane for review without mutating external state.',
  },
  auditDoneLanes: {
    requiresApproval: false,
    risk: 'medium',
    message: 'Queues review for finished lanes.',
  },
  captureEvidence: {
    requiresApproval: false,
    risk: 'low',
    message: 'Captures lane evidence via browser automation.',
  },
  clearEvidenceArtifacts: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Clears generated evidence artifacts for a lane.',
  },
  waiveCritique: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Waives a required self-verification gate before audit.',
  },
  cleanupArtifacts: {
    requiresApproval: true,
    risk: 'high',
    message: 'Removes archived lane artifacts from disk.',
  },
  manageCleanupSchedule: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Changes periodic cleanup policy and can increase data retention risk.',
  },
  manageExecutorCli: {
    requiresApproval: true,
    risk: 'high',
    message: 'Reinstalling/updating the CLI can change execution trust boundaries.',
  },
  manageMcpTools: {
    requiresApproval: true,
    risk: 'high',
    message: 'MCP tool changes can run arbitrary local commands.',
  },
  manageCapacity: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Changes session agent capacity and spawn policy.',
  },
  requestCapacity: {
    requiresApproval: false,
    risk: 'medium',
    message: 'Requests more executor capacity without spawning agents.',
  },
  manageNotifications: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Changes browser/in-app notification delivery and mobile alert behavior.',
  },
  manageAppBackups: {
    requiresApproval: true,
    risk: 'high',
    message: 'App backup import/export can expose or merge local project coordination state.',
  },
};

const MAX_LANE_LOG_ENTRIES = 2000;
const MAX_AGENT_EVENT_ENTRIES = 3000;
const MAX_ORCHESTRATOR_THREAD_MESSAGES = 500;

// Prefer the native structured clone (faster, less GC pressure than
// JSON.parse(JSON.stringify(...))); fall back for older runtimes.
function sanitizeMcpName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) {
    throw { status: 422, message: 'MCP tool name is required.' };
  }
  if (!/^[a-z0-9-_\.]+$/.test(name)) {
    throw { status: 422, message: 'MCP tool names may only include letters, numbers, hyphen, underscore, and period.' };
  }
  return name;
}

function normalizeMcpScope(raw) {
  const rawList = Array.isArray(raw) ? raw : [];
  const scopes = rawList
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const sanitized = Array.from(new Set(scopes));
  const invalid = sanitized.filter((scope) => !MCP_TOOL_SCOPE_ALLOWLIST.has(scope));
  if (invalid.length) {
    throw { status: 422, message: `MCP tool scope contains unsupported values: ${invalid.join(', ')}` };
  }
  return sanitized;
}

function normalizeCommandArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => sanitizeMcpArgument(item, index))
    .filter(Boolean)
    .slice(0, MAX_MCP_TOOL_ARGS);
}

function sanitizeMcpArgument(raw, index) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.length > MAX_MCP_TOOL_ARG_LENGTH) {
    throw {
      status: 422,
      message: `MCP tool argument #${index + 1} is too long.`,
    };
  }
  if (/[|&;<>$`\r\n\t]/.test(text)) {
    throw {
      status: 422,
      message: `MCP tool argument #${index + 1} contains blocked characters.`,
    };
  }
  return text;
}

// Env keys that can hijack process loading, PATH resolution, or the runtime;
// never accept these from a user-defined MCP tool.
const DANGEROUS_ENV_KEYS = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'BASH_ENV',
  'ENV',
  'IFS',
  'SHELLOPTS',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
]);

function sanitizeMcpEnv(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw { status: 422, message: 'MCP tool env must be an object of string keys/values.' };
  }
  const out = {};
  const keys = Object.keys(raw);
  if (keys.length > 64) {
    throw { status: 422, message: 'MCP tool env has too many entries (max 64).' };
  }
  for (const key of keys) {
    const value = raw[key];
    const safeKey = String(key || '').trim();
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/i.test(safeKey)) {
      throw { status: 422, message: `MCP tool env key "${safeKey}" is invalid (use letters, digits, underscore).` };
    }
    if (DANGEROUS_ENV_KEYS.has(safeKey.toUpperCase())) {
      throw { status: 422, message: `MCP tool env key "${safeKey}" is not allowed (it can hijack process loading/PATH).` };
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw { status: 422, message: `MCP tool env value for ${safeKey} must be a primitive.` };
    }
    const text = String(value);
    if (text.length > 1024) {
      throw { status: 422, message: `MCP tool env value for ${safeKey} is too long (max 1024).` };
    }
    if (/[\x00-\x1f\x7f]/.test(text)) {
      throw { status: 422, message: `MCP tool env value for ${safeKey} contains control characters.` };
    }
    out[safeKey] = text;
  }
  return out;
}

function sanitizeMcpWorkdir(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  const text = String(raw).trim();
  if (!text) return '';
  if (text.length > MAX_WORKDIR_BYTES) {
    throw { status: 422, message: 'MCP tool workdir is too long.' };
  }
  if (/\x00/.test(text)) {
    throw { status: 422, message: 'MCP tool workdir contains invalid bytes.' };
  }
  return text;
}

function sanitizeMcpText(raw, label, maxLen) {
  if (raw === undefined || raw === null) return '';
  const text = String(raw);
  if (text.length > maxLen) {
    throw { status: 422, message: `MCP tool ${label} exceeds ${maxLen}-character limit.` };
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw { status: 422, message: `MCP tool ${label} contains control characters.` };
  }
  return text.trim();
}

function sanitizeMcpCommand(raw) {
  const command = String(raw || '').trim();
  if (!command) {
    throw { status: 422, message: 'MCP tool command is required.' };
  }
  if (/\s/.test(command)) {
    throw { status: 422, message: 'MCP tool command must be a single executable token.' };
  }
  if (command.length > 255) {
    throw { status: 422, message: 'MCP tool command is too long.' };
  }
  if (/[|&;<>$`]/.test(command)) {
    throw { status: 422, message: 'MCP tool command contains blocked characters.' };
  }
  const allowlist = getMcpCommandAllowlist();
  if (allowlist && allowlist.length) {
    const normalized = command.toLowerCase();
    const baseCommand = path.basename(normalized);
    const allowed = allowlist.some((allowedCommand) => {
      const normalizedAllowed = String(allowedCommand || '').trim().toLowerCase();
      if (!normalizedAllowed) return false;
      if (normalized === normalizedAllowed) return true;
      return baseCommand === normalizedAllowed;
    });
    if (!allowed) {
      throw { status: 422, message: `MCP tool command "${command}" is not in the allowlist.` };
    }
  }
  return command;
}

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

function safeChatText(value, max = 12000) {
  return String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

function buildOrchestratorPrompt({
  project,
  session,
  message,
  messages = [],
  model = '',
  permissionsProfile = '',
  intelligenceProfile = '',
  baseUrl = '',
  nextActionUrl = '',
  discoveryUrl = '',
  executorCapabilities = null,
} = {}) {
  const transcript = messages
    .slice(-20)
    .map((entry) => `${String(entry.role || 'user').toUpperCase()}: ${safeChatText(entry.content, 3000)}`)
    .join('\n\n');
  const apiBase = String(baseUrl || '').replace(/\/+$/, '');
  return [
    'You are the Orca orchestration agent for this project/session.',
    'Own decomposition, planning, lane creation, executor assignment, and audit handoff.',
    'Do not ask the human to manually create executor lanes when you can create them through Orca tools.',
    'Use the scoped tool lease from ORCA_TOOL_LEASE_TOKEN, never the full API token.',
    apiBase ? `Orca base URL: ${apiBase}` : '',
    discoveryUrl ? `Tool discovery URL: ${discoveryUrl}` : '',
    nextActionUrl ? `Next-action URL: ${nextActionUrl}` : '',
    'For HTTP tool calls, send header x-orca-tool-lease: $ORCA_TOOL_LEASE_TOKEN.',
    executorCapabilities ? `Executor capability matrix available to you:\n${safeChatText(JSON.stringify(executorCapabilities, null, 2), 6000)}` : '',
    `Project: ${project?.name || project?.id || 'unknown'}`,
    `Session: ${session?.name || session?.id || 'unknown'}`,
    model ? `Requested model: ${safeChatText(model, 120)}` : '',
    permissionsProfile ? `Run mode / permissions: ${safeChatText(permissionsProfile, 120)}` : '',
    intelligenceProfile ? `Requested intelligence level: ${safeChatText(intelligenceProfile, 80)}` : '',
    session?.repoRoot ? `Repository root: ${session.repoRoot}` : `Session workspace: ${session?.worktreeRoot || ''}`,
    transcript ? `Recent conversation:\n${transcript}` : '',
    `Current user request:\n${safeChatText(message)}`,
  ].filter(Boolean).join('\n\n');
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
      if (!SPAWN_POLICIES.has(session.spawnPolicy)) {
        session.spawnPolicy = 'within_capacity';
        migrated = true;
      }
      if (typeof session.soloMode !== 'boolean') {
        session.soloMode = true;
        migrated = true;
      }
      if (!IDLE_SHUTDOWN_MODES.has(session.idleShutdownMode)) {
        session.idleShutdownMode = 'immediate';
        migrated = true;
      }
      if (!Array.isArray(session.capacityRequests)) {
        session.capacityRequests = [];
        migrated = true;
      }
      if (!CRITIQUE_MODES.has(session.critiqueMode)) {
        session.critiqueMode = 'suggested';
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

  createProject({
    name,
    slug,
    quickLinks = [],
    policyProfile = 'default',
    owner = 'dashboard',
    settingsOverrides = {},
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

    const now = nowIso();
    const project = {
      id: randomUUID(),
      name: String(name).trim(),
      slug: finalSlug,
      route: `/projects/${finalSlug}`,
      quickLinks: normalizeQuickLinks(quickLinks),
      policyProfile,
      settingsOverrides: sanitizeSettingsOverrides(settingsOverrides),
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
  }

  listProjects() {
    return clonePayload(this.projects.filter((project) => project.state !== 'archived'));
  }

  getProject(locator) {
    return this.projects.find((project) => project.id === locator || project.slug === locator);
  }

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

    if (patch.settingsOverrides !== undefined) {
      project.settingsOverrides = sanitizeSettingsOverrides(patch.settingsOverrides);
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
  }

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
    const link = normalizeQuickLink(payload, existing);
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
  }

  deleteProjectQuickLink(locator, linkId, context = {}) {
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
    const before = project.quickLinks || [];
    const next = before.filter((link) => link.id !== linkId);
    if (before.length === next.length) {
      throw { status: 404, message: 'Quick link not found.' };
    }
    project.quickLinks = next;
    project.updatedAt = nowIso();
    this.recordAudit({
      type: 'project_quick_link_deleted',
      actor,
      projectId: project.id,
      summary: `Quick link removed from ${project.name}`,
      evidence: { linkId },
      status: 'passed',
    });
    this.persistState();
    return clonePayload({ project, removed: true, linkId });
  }

  async checkProjectQuickLink(locator, linkId, { actor = 'dashboard', prefer = 'auto' } = {}) {
    const project = this.getProject(locator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }
    const link = (project.quickLinks || []).find((item) => item.id === linkId);
    if (!link) {
      throw { status: 404, message: 'Quick link not found.' };
    }
    const result = await boundedQuickLinkHealthCheck(link, { prefer });
    link.healthStatus = result.status;
    link.lastCheckedAt = nowIso();
    link.lastStatusCode = result.httpStatus;
    link.lastHealthDetail = sanitizeQuickLinkText(result.detail, '', 180);
    link.updatedAt = nowIso();
    project.updatedAt = nowIso();
    this.recordAudit({
      type: 'project_quick_link_health_checked',
      actor,
      projectId: project.id,
      summary: `Quick link "${link.label}" health checked: ${result.status}`,
      evidence: {
        linkId: link.id,
        status: result.status,
        httpStatus: result.httpStatus,
        detail: result.detail,
      },
      status: result.status === 'reachable' || result.status === 'not_checkable' ? 'passed' : 'failed',
    });
    this.persistState();
    return clonePayload({ project, link, result });
  }

  updateSession(locator, patch = {}, context = {}) {
    const session = this.getSession(locator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('updateSession', {
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
      throw { status: 422, message: 'Session name cannot be empty.' };
    }

    if (patch.state !== undefined) {
      const nextState = String(patch.state || '').trim();
      if (!['active', 'archived'].includes(nextState)) {
        throw { status: 422, message: 'Session state must be active or archived.' };
      }
      session.state = nextState;
    }

    if (patch.name) {
      session.name = String(patch.name).trim();
    }

    if (patch.laneConcurrencyLimit !== undefined) {
      const parsed = parsePositiveInteger(patch.laneConcurrencyLimit, null);
      if (parsed === null) {
        throw { status: 422, message: 'laneConcurrencyLimit must be a positive integer.' };
      }
      session.laneConcurrencyLimit = parsed;
      if (!session.approvedCapacity || session.approvedCapacity < parsed) {
        session.approvedCapacity = parsed;
      }
    }

    if (patch.approvedCapacity !== undefined) {
      const parsed = parsePositiveInteger(patch.approvedCapacity, null);
      if (parsed === null) {
        throw { status: 422, message: 'approvedCapacity must be a positive integer.' };
      }
      session.approvedCapacity = parsed;
    }

    if (patch.spawnPolicy !== undefined) {
      session.spawnPolicy = normalizeSpawnPolicy(patch.spawnPolicy);
    }

    if (patch.soloMode !== undefined) {
      session.soloMode = Boolean(patch.soloMode);
    }

    if (patch.idleShutdownMode !== undefined) {
      session.idleShutdownMode = normalizeIdleShutdownMode(patch.idleShutdownMode);
    }

    if (patch.critiqueMode !== undefined) {
      session.critiqueMode = normalizeCritiqueMode(patch.critiqueMode);
    }

    if (patch.artifactRetentionDays !== undefined) {
      const parsed = parsePositiveInteger(patch.artifactRetentionDays, null);
      if (parsed === null && patch.artifactRetentionDays !== null) {
        throw { status: 422, message: 'artifactRetentionDays must be a positive integer when provided.' };
      }
      session.artifactRetentionDays = parsed || 14;
    }

    if (patch.settingsOverrides !== undefined) {
      session.settingsOverrides = sanitizeSettingsOverrides(patch.settingsOverrides);
    }

    if (patch.leader !== undefined) {
      const nextLeader = String(patch.leader || '').trim();
      if (!nextLeader) {
        throw { status: 422, message: 'Session leader cannot be empty.' };
      }
      session.leader = nextLeader;
    }

    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'session_updated',
      actor,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Session "${session.name}" updated`,
      evidence: { session },
      status: 'passed',
    });
    this.persistState();

    return clonePayload(session);
  }

  // Store a chat attachment (screenshot/document) under the session's artifacts.
  // dataBase64 is the file contents; the returned ref includes an absolute path
  // the agent can read and a /artifacts URL the dashboard can display.
  async saveSessionAttachment(sessionLocator, { name = '', contentType = '', dataBase64 = '', actor = 'dashboard' } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const data = String(dataBase64 || '');
    if (!data) throw { status: 422, message: 'Attachment data is required.' };
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) throw { status: 422, message: 'Attachment is empty or not valid base64.' };
    if (buffer.length > 12 * 1024 * 1024) throw { status: 413, message: 'Attachment exceeds the 12MB limit.' };
    const base = (String(name || 'attachment').split(/[\\/]/).pop() || 'attachment').slice(-120);
    const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'attachment';
    const sessionSeg = /^[A-Za-z0-9._-]{1,128}$/.test(String(session.id)) ? String(session.id) : 'session';
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`;
    const dir = path.join(process.cwd(), 'artifacts', sessionSeg, 'attachments');
    await fs.mkdir(dir, { recursive: true });
    const abs = path.join(dir, filename);
    // filename is fully server-constructed from a sanitized base, but keep a real
    // boundary check (not a tautology) as defense in depth.
    if (!isPathWithinBoundary(abs, dir)) {
      throw { status: 400, message: 'Invalid attachment path.' };
    }
    await fs.writeFile(abs, buffer);
    const ref = {
      id: randomUUID(),
      name: base,
      filename,
      contentType: String(contentType || '').slice(0, 120),
      bytes: buffer.length,
      path: abs,
      url: `/artifacts/${sessionSeg}/attachments/${filename}`,
    };
    this.recordAudit({
      type: 'session_attachment_uploaded',
      actor: String(actor || 'dashboard').slice(0, 120),
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Attachment "${base}" (${buffer.length}B) uploaded`,
      status: 'passed',
      evidence: { filename, bytes: buffer.length, contentType: ref.contentType },
    });
    this.persistState();
    return ref;
  }

  // Orchestrator-owned session goal + plan (the durable "what are we doing").
  updateSessionPlan(sessionLocator, { goal, plan, actor = 'orchestrator' } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    if (goal === undefined && plan === undefined) {
      throw { status: 422, message: 'Provide a goal and/or plan to update.' };
    }
    if (goal !== undefined) session.goal = String(goal).slice(0, 4000);
    if (plan !== undefined) session.plan = String(plan).slice(0, 20000);
    session.planUpdatedAt = nowIso();
    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'session_plan_updated',
      actor: String(actor || 'orchestrator').slice(0, 120),
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Session "${session.name}" plan updated`,
      status: 'passed',
      evidence: { goal: session.goal || '', planChars: (session.plan || '').length },
    });
    this.persistState();
    return clonePayload(session);
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

  getMcpTools(scope = null) {
    const normalizedScope = String(scope || '').trim().toLowerCase();
    if (!normalizedScope) {
      return clonePayload(this.mcpTools);
    }

    const matching = this.mcpTools.filter((tool) => {
      const toolScopes = Array.isArray(tool.scope) ? tool.scope : [];
      return toolScopes.includes('all') || toolScopes.includes(normalizedScope);
    });
    return clonePayload(matching);
  }

  getMcpTool(locator) {
    if (!locator) return null;
    const target = String(locator).toLowerCase();
    return this.mcpTools.find((tool) => tool.id === target || tool.name === target);
  }

  createMcpTool(payload = {}, context = {}) {
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('manageMcpTools', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const name = sanitizeMcpName(payload.name);
    if (this.getMcpTool(name)) {
      throw { status: 409, message: `MCP tool "${name}" already exists.` };
    }

    const command = sanitizeMcpCommand(payload.command);
    const args = normalizeCommandArray(payload.args);
    const enabled = payload.enabled !== false;
    const scope = normalizeMcpScope(payload.scope);
    const env = sanitizeMcpEnv(payload.env);
    const workdir = sanitizeMcpWorkdir(payload.workdir);
    const description = sanitizeMcpText(payload.description, 'description', 500);
    const notes = sanitizeMcpText(payload.notes, 'notes', 1000);
    const owner = sanitizeMcpText(payload.owner || actor, 'owner', 120) || actor;
    const now = nowIso();
    const tool = {
      id: name,
      name,
      command,
      args,
      env,
      workdir,
      enabled,
      scope,
      description,
      notes,
      createdAt: now,
      updatedAt: now,
      owner,
    };

    this.mcpTools.push(tool);
    this.recordAudit({
      type: 'mcp_tool_created',
      actor,
      summary: `Created MCP tool ${name}`,
      evidence: { tool },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(tool);
  }

  updateMcpTool(locator, patch = {}, context = {}) {
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('manageMcpTools', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const tool = this.getMcpTool(locator);
    if (!tool) {
      throw { status: 404, message: 'MCP tool not found.' };
    }

    if (patch.name) {
      const nextName = sanitizeMcpName(patch.name);
      if (nextName !== tool.name && this.getMcpTool(nextName)) {
        throw { status: 409, message: `MCP tool "${nextName}" already exists.` };
      }
      tool.name = nextName;
      tool.id = nextName;
    }
    if (patch.command) tool.command = sanitizeMcpCommand(patch.command);
    if (Array.isArray(patch.args)) tool.args = normalizeCommandArray(patch.args);
    if (typeof patch.enabled === 'boolean') tool.enabled = patch.enabled;
    if (Array.isArray(patch.scope)) {
      tool.scope = normalizeMcpScope(patch.scope);
    }
    if (patch.env !== undefined) tool.env = sanitizeMcpEnv(patch.env);
    if (patch.workdir !== undefined) tool.workdir = sanitizeMcpWorkdir(patch.workdir);
    if (patch.description !== undefined) tool.description = sanitizeMcpText(patch.description, 'description', 500);
    if (patch.owner !== undefined) tool.owner = sanitizeMcpText(patch.owner, 'owner', 120) || tool.owner;
    if (patch.notes !== undefined) tool.notes = sanitizeMcpText(patch.notes, 'notes', 1000);

    tool.updatedAt = nowIso();
    this.recordAudit({
      type: 'mcp_tool_updated',
      actor,
      summary: `Updated MCP tool ${tool.name}`,
      evidence: { tool },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(tool);
  }

  deleteMcpTool(locator, context = {}) {
    const actor = context.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('manageMcpTools', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const target = this.getMcpTool(locator);
    if (!target) {
      throw { status: 404, message: 'MCP tool not found.' };
    }

    const before = this.mcpTools.length;
    this.mcpTools = this.mcpTools.filter((tool) => tool.id !== target.id);
    if (this.mcpTools.length === before) {
      throw { status: 500, message: 'Failed to remove MCP tool.' };
    }

    const affectedLanes = [];
    for (const lane of this.lanes) {
      if (!Array.isArray(lane.mcpTools)) continue;
      const originalCount = lane.mcpTools.length;
      lane.mcpTools = lane.mcpTools.filter((item) => item?.id !== target.id);
      if (lane.mcpTools.length !== originalCount) {
        affectedLanes.push(lane.id);
        lane.updatedAt = nowIso();
      }
    }

    this.recordAudit({
      type: 'mcp_tool_deleted',
      actor,
      summary: `Deleted MCP tool ${target.name}`,
      evidence: {
        tool: target,
        affectedLanes,
      },
      status: 'passed',
    });
    this.persistState();
    return { removed: true, tool: clonePayload(target) };
  }

  listToolsForExecutor(executorType = '') {
    return this.mcpTools.filter((tool) => {
      if (!tool.enabled) return false;
      if (!tool.scope.length) return true;
      const target = String(executorType || '').toLowerCase();
      return tool.scope.includes(target) || tool.scope.includes('all');
    });
  }

  createSession(projectLocator, {
    name,
    leader = 'codex',
    laneConcurrencyLimit = DEFAULT_APPROVED_CAPACITY,
    approvedCapacity = laneConcurrencyLimit,
    spawnPolicy = 'within_capacity',
    soloMode = true,
    idleShutdownMode = 'immediate',
    critiqueMode = 'suggested',
    artifactRetentionDays = 14,
    settingsOverrides = {},
    actor = 'dashboard',
    repoRoot = '',
  } = {}, context = {}) {
    const resolvedActor = context.actor || actor;
    const policyCheck = this.evaluateActionPolicy('createSession', {
      actor: resolvedActor,
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

    const project = this.getProject(projectLocator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }

    if (!name || !String(name).trim()) {
      throw { status: 422, message: 'Session name is required.' };
    }

    const now = nowIso();
    const concurrencyLimit = Math.max(1, Number.parseInt(laneConcurrencyLimit, 10) || DEFAULT_APPROVED_CAPACITY);
    const normalizedApprovedCapacity = normalizeApprovedCapacity(approvedCapacity, concurrencyLimit);
    const retention = Number.parseInt(artifactRetentionDays, 10) || 14;
    const sessionId = randomUUID();
    let validatedRepoRoot = '';
    if (typeof repoRoot === 'string' && repoRoot.trim()) {
      const candidate = path.resolve(repoRoot.trim());
      const descriptor = describeRepoRoot(candidate);
      if (!descriptor.ok) {
        throw { status: 422, message: `Session repoRoot is not a git working tree: ${descriptor.reason}` };
      }
      // Repo root must live under an approved boundary so we can never auto-worktree
      // into a directory the operator did not bless.
      const approved = this.getApprovedRepoRoots();
      const within = approved.some((root) => candidate === root || candidate.startsWith(root + path.sep));
      if (!within) {
        throw {
          status: 422,
          message: `Session repoRoot ${candidate} is outside the approved repo roots. Add it to ORCA_REPO_ROOTS or run the server from its parent.`,
        };
      }
      validatedRepoRoot = candidate;
    }
    const session = {
      id: sessionId,
      projectId: project.id,
      name: String(name).trim(),
      leader,
      laneConcurrencyLimit: concurrencyLimit,
      approvedCapacity: normalizedApprovedCapacity,
      spawnPolicy: normalizeSpawnPolicy(spawnPolicy),
      soloMode: soloMode !== false,
      idleShutdownMode: normalizeIdleShutdownMode(idleShutdownMode),
      critiqueMode: normalizeCritiqueMode(critiqueMode),
      capacityRequests: [],
      artifactRetentionDays: retention,
      settingsOverrides: sanitizeSettingsOverrides(settingsOverrides),
      route: `/projects/${project.slug}/sessions/${sessionId}`,
      createdAt: now,
      updatedAt: now,
      state: 'active',
      artifactsRoot: path.join(this.artifactRoot, sessionId),
      worktreeRoot: path.join(this.workspacesRoot, sessionId),
      repoRoot: validatedRepoRoot,
      notes: [],
      orchestratorThread: {
        id: randomUUID(),
        messages: [],
        laneIds: [],
        activeLaneId: null,
        executorType: null,
        updatedAt: now,
      },
    };
    ensureDirectorySync(session.artifactsRoot);
    ensureDirectorySync(session.worktreeRoot);

    this.sessions.push(session);
    this.recordAudit({
      type: 'session_created',
      actor: resolvedActor,
      projectId: project.id,
      sessionId: session.id,
      summary: `Session "${session.name}" created for project ${project.name}`,
      evidence: { session },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(session);
  }

  listSessions(projectLocator) {
    const project = this.getProject(projectLocator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }
    return clonePayload(this.sessions.filter((session) => session.projectId === project.id));
  }

  getSession(locator) {
    return this.sessions.find((session) => session.id === locator);
  }

  ensureOrchestratorThread(session) {
    if (!session.orchestratorThread || typeof session.orchestratorThread !== 'object') {
      session.orchestratorThread = {
        id: randomUUID(),
        messages: [],
        laneIds: [],
        activeLaneId: null,
        executorType: null,
        updatedAt: nowIso(),
      };
    }
    if (!Array.isArray(session.orchestratorThread.messages)) {
      session.orchestratorThread.messages = [];
    }
    if (session.orchestratorThread.messages.length > MAX_ORCHESTRATOR_THREAD_MESSAGES) {
      session.orchestratorThread.messages = session.orchestratorThread.messages.slice(-MAX_ORCHESTRATOR_THREAD_MESSAGES);
    }
    if (!Array.isArray(session.orchestratorThread.laneIds)) {
      session.orchestratorThread.laneIds = [];
    }
    return session.orchestratorThread;
  }

  appendOrchestratorThreadMessage(thread, message) {
    if (!thread || !message) return;
    if (!Array.isArray(thread.messages)) {
      thread.messages = [];
    }
    thread.messages.push(message);
    if (thread.messages.length > MAX_ORCHESTRATOR_THREAD_MESSAGES) {
      thread.messages = thread.messages.slice(-MAX_ORCHESTRATOR_THREAD_MESSAGES);
    }
  }

  getOrchestratorThread(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const thread = this.ensureOrchestratorThread(session);
    return clonePayload({
      ...thread,
      sessionId: session.id,
      projectId: session.projectId,
      activeLane: thread.activeLaneId ? this.getLane(thread.activeLaneId) || null : null,
    });
  }

  notifyOrchestratorManualLaneStop(lane, actor = 'dashboard', reason = '') {
    if (!lane || lane.owner === 'orchestrator') return;
    if (!['dashboard', 'operator', 'user'].includes(String(actor || '').toLowerCase())) return;
    const session = this.getSession(lane.sessionId);
    if (!session) return;
    const thread = this.ensureOrchestratorThread(session);
    const activeLaneId = thread.activeLaneId || '';
    const hasOrchestrator = activeLaneId || (Array.isArray(thread.laneIds) && thread.laneIds.length);
    if (!hasOrchestrator) return;
    this.appendOrchestratorThreadMessage(thread, {
      id: randomUUID(),
      role: 'system',
      content: `Operator manually stopped executor lane "${lane.title}". Reason: ${reason || 'stopped by dashboard'}.`,
      laneId: lane.id,
      createdAt: nowIso(),
    });
    thread.updatedAt = nowIso();
  }

  resolveOrchestratorExecutorType(session, requestedType = '') {
    const supported = this.getSupportedExecutorTypes();
    const requested = normalizeExecutorType(requestedType);
    if (requested && supported.includes(requested)) return requested;
    const leader = normalizeExecutorType(session?.leader);
    if (leader && supported.includes(leader) && leader !== 'mock') return leader;
    return supported.includes('codex') ? 'codex' : 'mock';
  }

  async sendOrchestratorMessage(sessionLocator, {
    message,
    executorType,
    model,
    permissionsProfile,
    intelligenceProfile,
    targetUrl,
    attachments = [],
    baseUrl = '',
    discoveryUrl = '',
    nextActionUrl = '',
  } = {}, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const text = safeChatText(message);
    const attachmentList = (Array.isArray(attachments) ? attachments : [])
      .filter((entry) => entry && (entry.path || entry.url))
      .slice(0, 20);
    if (!text && !attachmentList.length) throw { status: 422, message: 'Message or attachment is required.' };

    const project = this.getProject(session.projectId);
    const thread = this.ensureOrchestratorThread(session);
    const now = nowIso();
    const userMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      attachments: attachmentList.map((entry) => ({
        name: String(entry.name || 'attachment').slice(0, 200),
        url: String(entry.url || '').slice(0, 500),
        contentType: String(entry.contentType || '').slice(0, 120),
      })),
      createdAt: now,
    };
    this.appendOrchestratorThreadMessage(thread, userMessage);
    // Resolve each attachment's server-side absolute path from its /artifacts URL
    // (never trust a client-supplied path), contained under artifacts/.
    const artifactsRoot = path.join(process.cwd(), 'artifacts');
    const resolveAttachmentPath = (entry) => {
      const url = String(entry.url || '');
      if (!url.startsWith('/artifacts/')) return null;
      const abs = path.join(process.cwd(), url.replace(/^\/+/, ''));
      return abs.startsWith(artifactsRoot + path.sep) ? abs : null;
    };
    const promptText = attachmentList.length
      ? `${text}\n\nAttached files (absolute paths you can read):\n${attachmentList.map(resolveAttachmentPath).filter(Boolean).map((p) => `- ${p}`).join('\n')}`
      : text;

    const resolvedExecutorType = this.resolveOrchestratorExecutorType(session, executorType);
    const executorCapabilities = this.getExecutorCapabilitiesMatrix();
    const turnNumber = thread.messages.filter((entry) => entry.role === 'user').length;
    const workdir = session.repoRoot || session.worktreeRoot;
    let lane;
    try {
      lane = await this.createLane(session.id, {
        title: `Orchestrator turn ${turnNumber}`,
        taskDescription: (text || '(attachment)').slice(0, 1000),
        executorType: resolvedExecutorType,
        owner: 'orchestrator',
        workdir,
        sharedWorktree: true,
        taskPrompt: buildOrchestratorPrompt({
          project,
          session,
          message: promptText,
          messages: thread.messages,
          model,
          permissionsProfile,
          intelligenceProfile,
          baseUrl,
          discoveryUrl,
          nextActionUrl,
          executorCapabilities,
        }),
        model,
        permissionsProfile,
        intelligenceProfile,
        targetUrl,
      }, {
        actor: context.actor || 'dashboard',
        approved: context.approved,
      });
    } catch (error) {
      thread.messages = thread.messages.filter((entry) => entry.id !== userMessage.id);
      throw error;
    }

    const nextAction = context.nextAction || null;
    let lease = null;
    if (nextAction && Array.isArray(nextAction.allowedTools) && nextAction.allowedTools.length) {
      lease = this.createToolLease({
        role: 'orchestrator',
        projectId: session.projectId,
        sessionId: session.id,
        laneId: lane.id,
        allowedTools: nextAction.allowedTools,
        ttlMs: 24 * 60 * 60 * 1000,
        actor: 'orchestrator-bootstrap',
      });
      this.laneRuntimeEnv.set(String(lane.id), {
        ORCA_TOOL_LEASE_TOKEN: lease.leaseToken,
        ORCA_AGENT_TOOLS_BASE_URL: String(baseUrl || ''),
        ORCA_AGENT_TOOLS_DISCOVERY_URL: String(discoveryUrl || ''),
        ORCA_AGENT_TOOLS_NEXT_ACTION_URL: String(nextActionUrl || ''),
      });
    }

    thread.laneIds = [...new Set([...thread.laneIds, lane.id])].slice(-100);
    thread.activeLaneId = lane.id;
    thread.executorType = resolvedExecutorType;
    thread.updatedAt = nowIso();
    this.appendOrchestratorThreadMessage(thread, {
      id: randomUUID(),
      role: 'assistant',
      content: `Started ${resolvedExecutorType} orchestrator lane "${lane.title}".`,
      laneId: lane.id,
      executorCapabilities: lane.executorCapabilities || null,
      createdAt: thread.updatedAt,
    });
    this.recordAudit({
      type: 'orchestrator_message_queued',
      actor: context.actor || 'dashboard',
      projectId: session.projectId,
      sessionId: session.id,
      laneId: lane.id,
      summary: `Queued orchestrator turn for session ${session.name}`,
      status: 'passed',
      evidence: {
        messageId: userMessage.id,
        executorType: resolvedExecutorType,
        executorCapabilities: lane.executorCapabilities || null,
        leaseId: lease?.lease?.id || null,
      },
    });
    this.persistState();
    return clonePayload({
      thread,
      message: userMessage,
      lane,
      lease: lease ? lease.lease : null,
    });
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

  critiqueRequiredForLane(lane) {
    return ['required', 'visual-required'].includes(normalizeCritiqueMode(lane?.critiqueMode, 'suggested'));
  }

  critiqueSatisfiedForLane(lane) {
    if (!this.critiqueRequiredForLane(lane)) return true;
    return lane?.critiqueState === 'satisfied' || lane?.critiqueState === 'waived';
  }

  hasFreshVisualEvidence(lane) {
    if (!lane?.lastEvidenceCaptureAt || !lane?.lastEvidence) return false;
    if (lane.completedAt && Date.parse(lane.lastEvidenceCaptureAt) < Date.parse(lane.completedAt)) return false;
    const requested = Array.isArray(lane.lastEvidence.requested) ? lane.lastEvidence.requested : [];
    const produced = Array.isArray(lane.lastEvidence.produced) ? lane.lastEvidence.produced : [];
    const askedForScreenshot = requested.includes('screenshot') || produced.some((item) => String(item || '').includes('screenshot'));
    return askedForScreenshot && !['failed', 'degraded'].includes(String(lane.lastEvidence.status || '').toLowerCase());
  }

  createCritiqueBundle(laneLocator, { actor = 'dashboard' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const nonce = randomUUID();
    lane.critiqueNonce = nonce;
    lane.critiqueState = 'in_progress';
    lane.updatedAt = nowIso();
    const bundle = {
      laneId: lane.id,
      sessionId: lane.sessionId,
      projectId: lane.projectId,
      critiqueMode: normalizeCritiqueMode(lane.critiqueMode),
      critiqueRevision: lane.critiqueRevision || 1,
      critiqueNonce: nonce,
      evidenceRequired: lane.critiqueMode === 'visual-required',
      evidenceFresh: lane.critiqueMode === 'visual-required' ? this.hasFreshVisualEvidence(lane) : Boolean(lane.lastEvidence),
      latestEvidence: clonePayload(lane.lastEvidence || null),
      state: lane.state,
      taskPrompt: lane.taskPrompt || '',
      targetUrl: lane.targetUrl || '',
    };
    this.recordAudit({
      type: 'critique_bundle_created',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Critique bundle created for lane ${lane.title}`,
      status: 'passed',
      evidence: { laneId: lane.id, critiqueMode: lane.critiqueMode, critiqueRevision: bundle.critiqueRevision },
    });
    this.persistState();
    return bundle;
  }

  recordCritiqueFindings(laneLocator, {
    critiqueNonce,
    checksRun = [],
    visualEvidenceReviewed = false,
    issues = [],
    fixes = [],
    risks = [],
    ready = false,
    actor = 'dashboard',
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    if (!lane.critiqueNonce || critiqueNonce !== lane.critiqueNonce) {
      throw { status: 409, message: 'Critique findings are stale or missing the current critique nonce.' };
    }
    if (lane.critiqueMode === 'visual-required' && !this.hasFreshVisualEvidence(lane)) {
      throw { status: 409, message: 'Visual-required critique needs fresh screenshot evidence before findings can satisfy the gate.' };
    }
    const finding = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      recordedAt: nowIso(),
      critiqueRevision: lane.critiqueRevision || 1,
      critiqueNonce,
      checksRun: safeArray(checksRun).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50),
      visualEvidenceReviewed: Boolean(visualEvidenceReviewed),
      issues: safeArray(issues).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50),
      fixes: safeArray(fixes).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50),
      risks: safeArray(risks).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50),
      ready: Boolean(ready),
    };
    lane.critiqueFindings = [...safeArray(lane.critiqueFindings), finding].slice(-50);
    lane.critiqueState = finding.ready ? 'satisfied' : 'needed';
    lane.critiqueNonce = null;
    if (finding.ready && lane.state === NEEDS_CRITIQUE_STATE) {
      lane.state = READY_FOR_AUDIT_STATE;
    }
    lane.updatedAt = nowIso();
    this.recordAudit({
      type: 'critique_findings_recorded',
      actor: finding.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Critique findings recorded for lane ${lane.title}`,
      status: finding.ready ? 'passed' : 'pending',
      evidence: finding,
    });
    this.persistState();
    return { lane: clonePayload(lane), finding: clonePayload(finding) };
  }

  waiveCritique(laneLocator, { reason = '', actor = 'dashboard', approved } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const policyCheck = this.evaluateActionPolicy('waiveCritique', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    const waiverReason = String(reason || '').trim();
    if (!waiverReason) throw { status: 422, message: 'Critique waiver requires a reason.' };
    lane.critiqueState = 'waived';
    lane.critiqueNonce = null;
    if (lane.state === NEEDS_CRITIQUE_STATE) lane.state = READY_FOR_AUDIT_STATE;
    lane.updatedAt = nowIso();
    const waiver = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      reason: waiverReason.slice(0, 1000),
      waivedAt: nowIso(),
      critiqueMode: lane.critiqueMode,
      evidenceFresh: this.hasFreshVisualEvidence(lane),
    };
    lane.critiqueFindings = [...safeArray(lane.critiqueFindings), { ...waiver, waived: true }].slice(-50);
    this.recordAudit({
      type: 'critique_waived',
      actor: waiver.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Critique waived for lane ${lane.title}`,
      status: 'passed',
      evidence: waiver,
    });
    this.persistState();
    return { lane: clonePayload(lane), waiver };
  }

  async clearLaneEvidenceArtifacts(laneLocator, {
    actor = 'dashboard',
    approved,
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('clearEvidenceArtifacts', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const result = await this.evidenceRunner.clearEvidence(lane);
    lane.lastEvidence = null;
    lane.lastEvidenceCaptureAt = null;
    if (result.removed) {
      this.recordAudit({
        type: 'lane_evidence_cleared',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Evidence artifacts cleared for lane ${lane.title}`,
        evidence: { laneId: lane.id },
        status: 'passed',
      });
      this.appendLaneLog(lane, 'Evidence artifacts cleared.');
    } else {
      this.recordAudit({
        type: 'lane_evidence_cleared',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `No evidence artifacts to clear for lane ${lane.title}`,
        evidence: { laneId: lane.id },
        status: 'passed',
      });
    }

    this.persistState();
    return { removed: result.removed };
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

  queueLaneAudit(laneLocator, context = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('auditLane', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    if (this.critiqueRequiredForLane(lane) && !this.critiqueSatisfiedForLane(lane)) {
      throw { status: 409, message: 'Lane requires self-verification before audit can be queued.' };
    }

    const existing = this.auditEvents.find((event) =>
      event.type === 'lane_audit_queued' &&
      event.laneId === lane.id &&
      event.status === 'pending' &&
      event.followUpQueued
    );
    if (existing) {
      return {
        id: existing.id,
        queueId: existing.id,
        event: clonePayload(existing),
        lane: clonePayload(lane),
        alreadyQueued: true,
      };
    }

    this.appendLaneLog(lane, `Audit requested by ${context.actor || 'dashboard'}`);
    lane.auditState = 'queued';
    const queueId = this.recordAudit({
      type: 'lane_audit_queued',
      actor: context.actor || 'dashboard',
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Review requested for lane ${lane.title}`,
      evidence: {
        laneSnapshot: {
          title: lane.title,
          state: lane.state,
          logs: lane.logs.length,
        },
      },
      status: 'pending',
      followUpQueued: true,
    });
    this.persistState();
    const event = this.auditEvents.find((item) => item.id === queueId) || null;
    return { id: queueId, queueId, event: event ? clonePayload(event) : null, lane: clonePayload(lane) };
  }

  async queueDoneLanesAudit(sessionLocator, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }

    const doneLanes = this.lanes.filter((lane) =>
      lane.sessionId === session.id &&
      [DONE_STATE, READY_FOR_AUDIT_STATE].includes(lane.state) &&
      (!this.critiqueRequiredForLane(lane) || this.critiqueSatisfiedForLane(lane))
    );
    if (!doneLanes.length) {
      return { enqueued: 0, queueIds: [] };
    }

    const policyCheck = this.evaluateActionPolicy('auditDoneLanes', context);
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const queueIds = [];
    let enqueuedNew = 0;
    for (const lane of doneLanes) {
      const existing = this.auditEvents.find((event) =>
        event.type === 'session_audit_batch_queued' &&
        event.laneId === lane.id &&
        event.status === 'pending' &&
        event.followUpQueued
      );
      if (existing) {
        queueIds.push(existing.id);
        continue;
      }
      this.appendLaneLog(lane, `Session-level audit queued by ${context.actor || 'dashboard'}`);
      lane.auditState = 'queued';
      const queueId = this.recordAudit({
        type: 'session_audit_batch_queued',
        actor: context.actor || 'dashboard',
        projectId: lane.projectId,
        sessionId: session.id,
        laneId: lane.id,
        summary: `Session audit queued for lane ${lane.title}`,
        evidence: { laneSnapshot: { id: lane.id, state: lane.state } },
        status: 'pending',
        followUpQueued: true,
      });
      queueIds.push(queueId);
      enqueuedNew += 1;
    }

    this.persistState();
    return {
      enqueued: doneLanes.length,
      enqueuedNew,
      queueIds,
      alreadyQueued: doneLanes.length - enqueuedNew,
    };
  }

  acceptLaneAudit(laneLocator, {
    actor = 'dashboard',
    findings = [],
    reviewedFiles = [],
    verdict = 'accepted',
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    if (this.critiqueRequiredForLane(lane) && !this.critiqueSatisfiedForLane(lane)) {
      throw { status: 409, message: 'Cannot accept lane before required critique is satisfied.' };
    }
    lane.auditState = 'accepted';
    lane.state = ACCEPTED_STATE;
    lane.updatedAt = nowIso();
    const record = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      verdict,
      findings: safeArray(findings).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100),
      reviewedFiles: safeArray(reviewedFiles).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 200),
      recordedAt: nowIso(),
    };
    lane.auditFindings = [...safeArray(lane.auditFindings), record].slice(-50);
    for (const event of this.auditEvents) {
      if (event.laneId === lane.id && event.status === 'pending' && ['lane_audit_queued', 'session_audit_batch_queued'].includes(event.type)) {
        event.status = 'passed';
        event.reviewedAt = nowIso();
      }
    }
    this.recordAudit({
      type: 'lane_audit_accepted',
      actor: record.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Audit accepted lane ${lane.title}`,
      status: 'passed',
      evidence: record,
    });
    this.persistState();
    return { lane: clonePayload(lane), audit: clonePayload(record) };
  }

  requestLaneFix(laneLocator, {
    actor = 'dashboard',
    findings = [],
    nextTask = '',
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    lane.auditState = 'fix_requested';
    lane.state = FIX_REQUESTED_STATE;
    lane.updatedAt = nowIso();
    const record = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      findings: safeArray(findings).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100),
      nextTask: String(nextTask || '').trim().slice(0, 2000),
      recordedAt: nowIso(),
    };
    lane.auditFindings = [...safeArray(lane.auditFindings), record].slice(-50);
    this.recordAudit({
      type: 'lane_audit_fix_requested',
      actor: record.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Audit requested fix pass for lane ${lane.title}`,
      status: 'pending',
      followUpQueued: true,
      evidence: record,
    });
    this.persistState();
    return { lane: clonePayload(lane), audit: clonePayload(record) };
  }

  blockLaneAudit(laneLocator, {
    actor = 'dashboard',
    reason = '',
    findings = [],
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const blockReason = String(reason || '').trim();
    if (!blockReason) throw { status: 422, message: 'Blocking an audit requires a reason.' };
    lane.auditState = 'blocked';
    lane.state = BLOCKED_STATE;
    lane.updatedAt = nowIso();
    const record = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      reason: blockReason.slice(0, 2000),
      findings: safeArray(findings).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100),
      recordedAt: nowIso(),
    };
    lane.auditFindings = [...safeArray(lane.auditFindings), record].slice(-50);
    this.recordAudit({
      type: 'lane_audit_blocked',
      actor: record.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Audit blocked lane ${lane.title}`,
      status: 'failed',
      evidence: record,
    });
    this.persistState();
    return { lane: clonePayload(lane), audit: clonePayload(record) };
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

  async getEvidenceFiles(laneLocator) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const files = await this.listArtifactFiles(lane.id);
    const evidence = [];
    for (const filename of files) {
      if (!filename.startsWith('evidence-') && !filename.endsWith('-log.txt')) {
        continue;
      }
      const mode = inferEvidenceMode(filename);
      if (!mode) continue;
      const filePath = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id, filename);
      const stats = await fs.stat(filePath);
      evidence.push({
        name: filename,
        mode,
        at: stats.mtime.toISOString(),
        size: stats.size,
        url: `/artifacts/${lane.sessionId}/${lane.id}/${filename}`,
      });
    }
    evidence.sort((left, right) => new Date(right.at) - new Date(left.at));
    return evidence;
  }

  getEvidencePresets(laneLocator) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }
    const project = this.projects.find((item) => item.id === lane.projectId) || null;
    const presets = [];
    if (lane.targetUrl) {
      presets.push({
        id: 'lane-target',
        label: 'Lane target URL',
        url: lane.targetUrl,
        source: 'lane',
        kind: 'target-url',
      });
    }
    if (project) {
      for (const link of project.quickLinks || []) {
        if (!link) continue;
        const presetUrl = effectiveQuickLinkUrl(link, { prefer: 'auto' });
        if (!presetUrl || presetUrl.startsWith('/')) continue;
        presets.push({
          id: `project-link:${link.id}`,
          label: link.label || presetUrl,
          url: presetUrl,
          source: 'project-quick-link',
          kind: link.kind || 'other',
          linkId: link.id,
        });
      }
    }
    return {
      laneId: lane.id,
      sessionId: lane.sessionId,
      presets,
    };
  }

  async getLatestEvidence(laneLocator, { mode = null } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }
    const requestedMode = normalizeEvidenceModeList(mode);
    const evidenceFiles = await this.getEvidenceFiles(lane.id);
    const result = {
      laneId: lane.id,
      sessionId: lane.sessionId,
      generatedAt: nowIso(),
      files: {},
      requestedMode: requestedMode || 'all',
    };

    const includeAll = !requestedMode;
    if (includeAll) {
      for (const item of evidenceFiles) {
        if (!result.files[item.mode]) {
          result.files[item.mode] = item;
        }
      }
    } else {
      result.files[requestedMode] = evidenceFiles.find((item) => item.mode === requestedMode) || null;
    }
    return result;
  }

  async getArtifactFile(laneLocator, filename) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    if (!filename) {
      throw { status: 400, message: 'Invalid artifact filename.' };
    }

    let decoded = filename;
    try {
      decoded = decodeURIComponent(String(filename));
    } catch {
      throw { status: 400, message: 'Invalid artifact filename encoding.' };
    }

    if (
      decoded.includes('\0')
      || decoded.includes('..')
      || decoded.startsWith('/')
      || decoded.startsWith('\\')
      || path.isAbsolute(decoded)
      || /[\\]/.test(decoded)
    ) {
      throw { status: 400, message: 'Invalid artifact filename.' };
    }

    const laneDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
    const filePath = path.join(laneDir, decoded);
    if (!isPathWithinBoundary(filePath, laneDir)) {
      throw { status: 400, message: 'Artifact path escapes lane boundary.' };
    }

    let stats;
    try {
      stats = await fs.lstat(filePath);
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 500;
      throw { status, message: 'Artifact file not found.' };
    }
    if (stats.isSymbolicLink()) {
      throw { status: 400, message: 'Artifact path resolves to a symlink and was refused.' };
    }
    if (!stats.isFile()) {
      throw { status: 404, message: 'Artifact file not found.' };
    }

    return {
      lane,
      filePath,
      fullPath: filePath,
    };
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

  getPolicyMap() {
    return clonePayload(this.policies);
  }

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
  }

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
  }

  getSessionCapacity(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const approvedCapacity = normalizeApprovedCapacity(session.approvedCapacity, normalizeApprovedCapacity(session.laneConcurrencyLimit));
    const activeAgents = this.lanes.filter((lane) =>
      lane.sessionId === session.id &&
      [QUEUED_STATE, STARTING_STATE, RUNNING_STATE].includes(lane.state)
    ).length;
    return {
      sessionId: session.id,
      spawnPolicy: normalizeSpawnPolicy(session.spawnPolicy),
      approvedCapacity,
      activeAgents,
      idleSlots: Math.max(0, approvedCapacity - activeAgents),
      soloMode: session.soloMode !== false,
      idleShutdownMode: normalizeIdleShutdownMode(session.idleShutdownMode),
      capacityRequests: safeArray(session.capacityRequests).map((request) => clonePayload(request)),
    };
  }

  requestCapacity(sessionLocator, {
    requestedCapacity,
    reason = '',
    tasksUnlocked = [],
    costRisk = '',
    actor = 'dashboard',
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const policyCheck = this.evaluateActionPolicy('requestCapacity', { actor, approved: true });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    const current = this.getSessionCapacity(session.id);
    const requested = normalizeApprovedCapacity(requestedCapacity, current.approvedCapacity);
    if (requested <= current.approvedCapacity) {
      return {
        alreadyWithinCapacity: true,
        request: null,
        capacity: current,
      };
    }
    const existing = safeArray(session.capacityRequests).find((request) =>
      request.status === 'pending' && request.requestedCapacity === requested
    );
    if (existing) {
      return {
        alreadyPending: true,
        request: clonePayload(existing),
        capacity: current,
      };
    }
    const request = {
      id: randomUUID(),
      status: 'pending',
      actor: String(actor || 'dashboard').slice(0, 120),
      requestedCapacity: requested,
      currentApprovedCapacity: current.approvedCapacity,
      reason: String(reason || '').trim().slice(0, 1000),
      tasksUnlocked: safeArray(tasksUnlocked).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20),
      costRisk: String(costRisk || '').trim().slice(0, 1000),
      createdAt: nowIso(),
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
    };
    session.capacityRequests = [request, ...safeArray(session.capacityRequests)].slice(0, 100);
    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'capacity_request_created',
      actor: request.actor,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Requested capacity ${requested} for session ${session.name}`,
      status: 'pending',
      followUpQueued: true,
      evidence: { request },
    });
    this.persistState();
    return {
      request: clonePayload(request),
      capacity: this.getSessionCapacity(session.id),
    };
  }

  approveCapacityRequest(sessionLocator, requestId, {
    actor = 'dashboard',
    approved,
    reason = '',
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const policyCheck = this.evaluateActionPolicy('manageCapacity', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    const request = safeArray(session.capacityRequests).find((item) => item.id === requestId);
    if (!request) throw { status: 404, message: 'Capacity request not found.' };
    if (request.status !== 'pending') {
      return { alreadyDecided: true, request: clonePayload(request), capacity: this.getSessionCapacity(session.id) };
    }
    request.status = 'approved';
    request.decidedAt = nowIso();
    request.decidedBy = String(actor || 'dashboard').slice(0, 120);
    request.decisionReason = String(reason || '').trim().slice(0, 1000);
    session.approvedCapacity = Math.max(normalizeApprovedCapacity(session.approvedCapacity), request.requestedCapacity);
    session.laneConcurrencyLimit = session.approvedCapacity;
    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'capacity_request_approved',
      actor: request.decidedBy,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Approved capacity ${session.approvedCapacity} for session ${session.name}`,
      status: 'passed',
      evidence: { request },
    });
    this.persistState();
    return { request: clonePayload(request), capacity: this.getSessionCapacity(session.id) };
  }

  rejectCapacityRequest(sessionLocator, requestId, {
    actor = 'dashboard',
    approved,
    reason = '',
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const policyCheck = this.evaluateActionPolicy('manageCapacity', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    const request = safeArray(session.capacityRequests).find((item) => item.id === requestId);
    if (!request) throw { status: 404, message: 'Capacity request not found.' };
    if (request.status !== 'pending') {
      return { alreadyDecided: true, request: clonePayload(request), capacity: this.getSessionCapacity(session.id) };
    }
    request.status = 'rejected';
    request.decidedAt = nowIso();
    request.decidedBy = String(actor || 'dashboard').slice(0, 120);
    request.decisionReason = String(reason || '').trim().slice(0, 1000);
    session.updatedAt = nowIso();
    this.recordAudit({
      type: 'capacity_request_rejected',
      actor: request.decidedBy,
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Rejected capacity request for session ${session.name}`,
      status: 'passed',
      evidence: { request },
    });
    this.persistState();
    return { request: clonePayload(request), capacity: this.getSessionCapacity(session.id) };
  }

  setCapacityPolicy(sessionLocator, {
    spawnPolicy,
    approvedCapacity,
    soloMode,
    idleShutdownMode,
    actor = 'dashboard',
    approved,
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }
    const policyCheck = this.evaluateActionPolicy('manageCapacity', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    if (spawnPolicy !== undefined) session.spawnPolicy = normalizeSpawnPolicy(spawnPolicy, session.spawnPolicy || 'within_capacity');
    if (approvedCapacity !== undefined) {
      session.approvedCapacity = normalizeApprovedCapacity(approvedCapacity, normalizeApprovedCapacity(session.approvedCapacity));
      session.laneConcurrencyLimit = session.approvedCapacity;
    }
    if (soloMode !== undefined) session.soloMode = soloMode !== false;
    if (idleShutdownMode !== undefined) session.idleShutdownMode = normalizeIdleShutdownMode(idleShutdownMode, session.idleShutdownMode || 'immediate');
    session.updatedAt = nowIso();
    const capacity = this.getSessionCapacity(session.id);
    this.recordAudit({
      type: 'capacity_policy_updated',
      actor: String(actor || 'dashboard').slice(0, 120),
      projectId: session.projectId,
      sessionId: session.id,
      summary: `Updated capacity policy for session ${session.name}`,
      status: 'passed',
      evidence: { capacity },
    });
    this.persistState();
    return capacity;
  }

  getSupportedExecutorTypes() {
    const supported = ['mock', ...FIRST_CLASS_CLI_EXECUTOR_TYPES, ...getApiProviderExecutorTypes()];
    if (getExecutorProfileFromFactory('cli')) {
      supported.push('cli');
    }
    return [...new Set(supported)];
  }

  async describeSystemBlockers() {
    const blockers = [];
    // Executor blockers
    for (const executorType of ['codex', 'claude']) {
      try {
        const info = this.getExecutorCliInfo(executorType);
        if (!info.binaryExists) {
          blockers.push({
            id: `executor-${executorType}-missing`,
            severity: 'error',
            area: 'executor',
            summary: `${executorType.toUpperCase()} CLI not executable`,
            detail: `Configured binary ${info.binary} could not be invoked (exitCode=${info.binaryExitCode || 'n/a'}).`,
            remediation: executorType === 'codex'
              ? 'Reinstall the Codex CLI: `brew reinstall --cask codex` OR `npm install -g @openai/codex`. Then restart Orca.'
              : 'Reinstall Claude Code: `brew install anthropic-ai/tap/claude` or follow the official installer. Then restart Orca.',
            approvalRequired: true,
          });
        } else if (!info.version) {
          blockers.push({
            id: `executor-${executorType}-version-unknown`,
            severity: 'warn',
            area: 'executor',
            summary: `${executorType.toUpperCase()} CLI version is unknown`,
            detail: `${info.binary} exists but did not return a version. Trust state cannot be verified.`,
            remediation: `Run \`${info.binary} --version\` manually and confirm output.`,
            approvalRequired: false,
          });
        }
      } catch (error) {
        blockers.push({
          id: `executor-${executorType}-error`,
          severity: 'error',
          area: 'executor',
          summary: `${executorType.toUpperCase()} CLI inspection failed`,
          detail: error?.message || 'unknown',
          remediation: 'Check Orca logs for the underlying error.',
          approvalRequired: false,
        });
      }
    }
    // Playwright blocker — await detection so we don't false-positive after install.
    const playwrightOk = await this.evidenceRunner.ensurePlaywrightDetected();
    if (!playwrightOk) {
      blockers.push({
        id: 'playwright-missing',
        severity: 'warn',
        area: 'evidence',
        summary: 'Playwright not installed; evidence capture is degraded',
        detail: 'Without Playwright, /api/lanes/:id/evidence returns captured=false and writes a JSON marker only. Screenshots, traces, and videos cannot be produced.',
        remediation: 'From the repo root, run: npm install --save-dev playwright && npx playwright install chromium',
        approvalRequired: true,
      });
    }
    return {
      generatedAt: nowIso(),
      blockers,
    };
  }

  getExecutorProfiles() {
    return clonePayload(getExecutorProfilesFromFactory());
  }

  getExecutorCapabilities(executorType) {
    const type = normalizeExecutorType(executorType);
    const supported = this.getSupportedExecutorTypes();
    if (!supported.includes(type)) {
      throw { status: 404, message: 'Unsupported executor type.' };
    }

    if (type === 'mock') {
      return compactCapabilities({
        type,
        displayName: 'Mock',
        kind: 'mock',
        binary: null,
        binaryExists: true,
        version: 'built-in',
        roles: ['orchestrator', 'executor', 'auditor', 'critique'],
        controls: {
          model: { supported: false, values: [] },
          permissions: { supported: true, values: ['plan', 'read-only', 'auto-edit'] },
          intelligence: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'], passthrough: true },
          structuredOutput: { supported: true, formats: ['mock-events'] },
          backgroundAgents: { supported: false },
        },
        invocation: {
          canRunAsOrchestrator: true,
          canRunAsExecutor: true,
          commandDerivedFromLane: true,
          customArgs: false,
        },
        mcpScopes: ['mock', 'all'],
        detection: { source: 'built-in', checkedAt: nowIso() },
      });
    }

    if (FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(type) || type === 'cli') {
      const profile = getExecutorProfileFromFactory(type) || {};
      const binary = String(profile.defaultBinary || type);
      const cacheKey = `${type}:${binary}:${safeArray(profile.allowedModels).join(',')}`;
      const cached = cliCapabilityCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < CLI_CAPABILITY_CACHE_MS) {
        return clonePayload(cached.capabilities);
      }
      const versionInfo = getCliVersion(binary);
      const helpInfo = versionInfo.exists ? getCliHelp(binary, type) : { ok: false, text: '', exitCode: null };
      const helpText = helpInfo.text || '';
      const supportsModel = helpHas(helpText, /(?:^|\s)--model(?:\s|[=<])/m);
      const supportsMcpConfig = helpHas(helpText, /(?:^|\s)--mcp-config(?:\s|[=<])/m);
      const supportsOutputFormat = helpHas(helpText, /(?:^|\s)--output-format(?:\s|[=<])/m) || type === 'codex';
      const supportsPermissionMode = helpHas(helpText, /(?:^|\s)--permission-mode(?:\s|[=<])/m);
      const supportsApprovalMode = helpHas(helpText, /(?:^|\s)--approval-mode(?:\s|[=<])/m);
      const supportsEffort = helpHas(helpText, /(?:^|\s)--effort(?:\s|[=<])/m);
      const permissionChoices = parseHelpChoices(helpText, '--permission-mode');
      const outputChoices = parseHelpChoices(helpText, '--output-format');
      const effortChoices = parseHelpChoices(helpText, '--effort');
      const permissionValues = permissionChoices.length
        ? permissionChoices
        : (type === 'codex'
          ? ['plan', 'read-only', 'auto-edit', 'bypass-permissions']
          : (supportsApprovalMode ? ['plan', 'read-only', 'auto-edit', 'bypass-permissions'] : ['plan', 'read-only', 'auto-edit', 'acceptEdits', 'bypassPermissions']));
      const intelligenceValues = supportsEffort
        ? (effortChoices.length ? effortChoices : ['low', 'medium', 'high', 'xhigh', 'max'])
        : ['low', 'medium', 'high', 'xhigh', 'max'];
      const backgroundAgents = type === 'claude' && (
        helpHas(helpText, /^\s*agents\s/m)
        || helpHas(helpText, /(?:^|\s)--agents(?:\s|[=<])/m)
        || helpHas(helpText, /(?:^|\s)--agent(?:\s|[=<])/m)
      );
      const attachable = type === 'claude' && helpHas(helpText, /^\s*attach\s/m);
      const stoppable = type === 'claude' && helpHas(helpText, /^\s*stop\s/m);
      const logs = type === 'claude' && helpHas(helpText, /^\s*logs\s/m);

      const capabilities = compactCapabilities({
        type,
        displayName: type === 'cli' ? 'Custom CLI' : type,
        kind: 'cli',
        binary: publicBinaryName(binary),
        binaryExists: Boolean(versionInfo.exists),
        version: firstLine(versionInfo.version),
        roles: ['orchestrator', 'executor', 'auditor', 'critique'],
        controls: {
          model: {
            supported: supportsModel || safeArray(profile.allowedModels).length > 0,
            values: safeArray(profile.allowedModels),
            defaultValue: String(process.env[`ORCA_${String(type).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MODEL`] || '').slice(0, 120) || null,
          },
          permissions: {
            supported: true,
            values: permissionValues,
            nativeFlag: supportsPermissionMode ? '--permission-mode' : (supportsApprovalMode ? '--approval-mode' : (type === 'codex' ? '--sandbox/--full-auto' : 'derived-or-passthrough')),
          },
          intelligence: {
            supported: supportsEffort,
            values: intelligenceValues,
            nativeFlag: supportsEffort ? '--effort' : null,
            passthrough: !supportsEffort,
          },
          structuredOutput: {
            supported: supportsOutputFormat || ['codex', 'claude', 'gemini-cli', 'composer-cli'].includes(type),
            formats: outputChoices.length ? outputChoices : (type === 'codex' ? ['jsonl'] : []),
          },
          mcpConfig: {
            supported: supportsMcpConfig || ['codex', 'claude'].includes(type),
            nativeFlag: supportsMcpConfig || ['codex', 'claude'].includes(type) ? '--mcp-config' : null,
          },
          backgroundAgents: {
            supported: backgroundAgents,
            attachable,
            logs,
            stoppable,
            commands: backgroundAgents ? ['agents', 'attach', 'logs', 'stop', 'respawn'].filter((command) => command === 'agents' || helpHas(helpText, new RegExp(`^\\s*${command}\\s`, 'm'))) : [],
          },
        },
        invocation: {
          canRunAsOrchestrator: true,
          canRunAsExecutor: true,
          commandDerivedFromLane: type !== 'cli',
          customArgs: type === 'cli',
          rawTerminalArtifacts: true,
          structuredAgentEvents: ['codex', 'claude', 'gemini-cli', 'composer-cli'].includes(type),
        },
        mcpScopes: type === 'cli' ? ['cli', 'custom-cli', 'all'] : [type, 'all'],
        detection: {
          source: helpInfo.ok ? 'version-and-help' : (versionInfo.exists ? 'version-only' : 'static'),
          checkedAt: nowIso(),
          helpExitCode: helpInfo.exitCode ?? null,
        },
      });
      cliCapabilityCache.set(cacheKey, {
        cachedAt: Date.now(),
        capabilities,
      });
      while (cliCapabilityCache.size > MAX_CLI_CAPABILITY_CACHE_ENTRIES) {
        const oldestKey = cliCapabilityCache.keys().next().value;
        if (!oldestKey) break;
        cliCapabilityCache.delete(oldestKey);
      }
      return clonePayload(capabilities);
    }

    const profile = getApiProviderProfileFromFactory(type) || {};
    return compactCapabilities({
      type,
      displayName: profile.id || type,
      kind: 'api',
      binary: null,
      binaryExists: false,
      version: null,
      roles: ['orchestrator', 'executor', 'auditor', 'critique'],
      controls: {
        model: { supported: true, values: safeArray(profile.allowedModels), defaultValue: profile.defaultModel || null },
        permissions: { supported: false, values: ['restricted'] },
        intelligence: { supported: false, values: ['low', 'medium', 'high', 'xhigh', 'max'], passthrough: true },
        structuredOutput: { supported: Boolean(profile.streaming), formats: profile.streaming ? ['provider-stream'] : ['provider-json'] },
        backgroundAgents: { supported: false },
      },
      invocation: {
        canRunAsOrchestrator: true,
        canRunAsExecutor: true,
        commandDerivedFromLane: false,
        customArgs: false,
        rawTerminalArtifacts: false,
        structuredAgentEvents: false,
      },
      mcpScopes: ['api', type, 'all'],
      detection: { source: 'provider-profile', checkedAt: nowIso() },
    });
  }

  getExecutorCapabilitiesMatrix() {
    return this.getSupportedExecutorTypes().reduce((accum, executorType) => {
      try {
        accum[executorType] = this.getExecutorCapabilities(executorType);
      } catch (error) {
        accum[executorType] = {
          type: executorType,
          error: error?.message || 'Capability detection failed.',
          roles: [],
          controls: {},
          invocation: {},
          detection: { source: 'error', checkedAt: nowIso() },
        };
      }
      return accum;
    }, {});
  }

  getExecutorCliInfo(executorType) {
    const type = normalizeExecutorType(executorType);
    if (!this.getSupportedExecutorTypes().includes(type)) {
      throw { status: 404, message: 'Unsupported executor type.' };
    }
    if (!FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(type) && type !== 'cli') {
      return {
        type,
        profile: getApiProviderProfileFromFactory(type) || {},
        binary: null,
        binaryExists: false,
        version: null,
        binaryExitCode: null,
        capabilities: this.getExecutorCapabilities(type),
        reinstall: {
          available: false,
          command: null,
          preferSource: false,
          sourceRepos: [],
          sourceCommand: null,
        },
      };
    }

    const profile = getExecutorProfileFromFactory(type) || {};
    const binary = String(profile.defaultBinary || type);
    const versionInfo = getCliVersion(binary);
    const reinstallCommand = getReinstallCommand(type);
    const reinstallSourceRepos = getReinstallSourceRepos(type);
    const preferSource = shouldPreferSourceReinstall(type);
    return {
      type,
      profile,
      binary,
      binaryExists: versionInfo.exists,
      version: versionInfo.version,
      binaryExitCode: versionInfo.exitCode,
      capabilities: this.getExecutorCapabilities(type),
      reinstall: {
        available: Boolean(reinstallCommand),
        command: reinstallCommand,
        preferSource,
        sourceRepos: reinstallSourceRepos,
        sourceCommand: getReinstallSourceCommand(type),
      },
    };
  }

  // Governed on-demand setup of the evidence-capture browser backend.
  // Dry-run by default; executes only with approval + explicit confirmation.
  async setupCaptureBackend({
    actor = 'dashboard',
    approved = false,
    confirmed = false,
    preferSystemChrome = true,
  } = {}) {
    const policyCheck = this.evaluateActionPolicy('manageExecutorCli', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const installDir = path.join(this.storageDir, 'capture', 'playwright');
    const plan = planPlaywrightInstall({ installDir, preferSystemChrome });

    if (!confirmed) {
      this.recordAudit({
        type: 'capture_setup_planned',
        actor,
        summary: `Capture setup planned (${plan.backend})`,
        evidence: { backend: plan.backend, channel: plan.channel, installDir, steps: plan.steps.map((s) => s.label) },
        status: 'passed',
      });
      return { dryRun: true, plan };
    }

    await fs.mkdir(installDir, { recursive: true });
    const result = await runCaptureInstall(plan, {
      approved: true,
      spawn: (command, args, options) => new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd: options?.cwd,
          env: { ...process.env, ...(options?.env || {}) },
          stdio: 'ignore',
        });
        child.on('error', () => resolve({ code: 1 }));
        child.on('close', (code) => resolve({ code: code ?? 1 }));
      }),
    });

    if (result.ok) {
      // Wire env so capture works immediately, without restarting the server.
      process.env.ORCA_PLAYWRIGHT_DIR = installDir;
      if (plan.channel) process.env.ORCA_CAPTURE_CHANNEL = plan.channel;
      else delete process.env.ORCA_CAPTURE_CHANNEL;
      if (plan.browsersDir) process.env.PLAYWRIGHT_BROWSERS_PATH = plan.browsersDir;
      if (this.evidenceRunner) this.evidenceRunner._hasPlaywright = null; // force re-detect
    }

    this.recordAudit({
      type: 'capture_setup_executed',
      actor,
      summary: `Capture setup ${result.ok ? 'succeeded' : 'failed'} (${plan.backend})`,
      evidence: { backend: plan.backend, channel: plan.channel, ok: result.ok, failedStep: result.failedStep || null },
      status: result.ok ? 'passed' : 'failed',
    });

    return { dryRun: false, executed: true, ok: result.ok, plan, result };
  }

  captureStatus({ playwrightAvailable = false } = {}) {
    return describeCaptureStatus({ playwrightAvailable });
  }

  async runExecutorCliReinstall(executorType, {
    actor = 'dashboard',
    approved = false,
    execute = false,
    command,
    confirmed = false,
    useSource = false,
  } = {}) {
    const type = normalizeExecutorType(executorType);
    if (!['codex', 'claude'].includes(type)) {
      throw { status: 404, message: 'Unsupported executor type.' };
    }

    const policyCheck = this.evaluateActionPolicy('manageExecutorCli', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const willExecute = Boolean(execute);
    const requestSource = Boolean(useSource);
    const hasOverride = command !== undefined;
    if (hasOverride && requestSource) {
      throw {
        status: 422,
        message: `Cannot combine custom command override and source mode for ${type} reinstall.`,
        risk: defaultPolicy.manageExecutorCli.risk,
      };
    }

    if (willExecute && !confirmed) {
      throw {
        status: 409,
        message: `Execution for ${type} CLI reinstall requires explicit confirmation.`,
        risk: defaultPolicy.manageExecutorCli.risk,
      };
    }

    const overrideCommand = hasOverride ? normalizeReinstallCommand(command, type) : null;
    const preferredCommand = getReinstallCommand(type);
    const sourceCommand = requestSource ? getReinstallSourceCommand(type) : null;

    if (hasOverride && !overrideCommand) {
      throw {
        status: 422,
        message: `Invalid reinstall command override for ${type}.`,
        risk: defaultPolicy.manageExecutorCli.risk,
      };
    }

    let commandToRun = null;
    let commandOrigin = 'policy';
    if (requestSource) {
      if (!sourceCommand) {
        throw {
          status: 422,
          message: `No trusted source reinstall command is available for ${type}.`,
          risk: defaultPolicy.manageExecutorCli.risk,
        };
      }
      const normalizedSourceCommand = normalizeReinstallCommand(sourceCommand, type);
      if (!normalizedSourceCommand) {
        throw {
          status: 422,
          message: `No trusted source reinstall command is available for ${type}.`,
          risk: defaultPolicy.manageExecutorCli.risk,
        };
      }
      commandToRun = normalizedSourceCommand;
      commandOrigin = 'source';
    } else if (hasOverride) {
      commandToRun = overrideCommand;
      commandOrigin = 'request';
    } else {
      commandToRun = preferredCommand;
    }

    if (!commandToRun) {
      throw {
        status: 422,
        message: `No safe reinstall command configured for ${type}.`,
        risk: defaultPolicy.manageExecutorCli.risk,
      };
    }

    if (!execute) {
      this.recordAudit({
        type: 'executor_cli_reinstall_plan_only',
        actor,
        projectId: null,
        sessionId: null,
        laneId: null,
        summary: `${type} CLI reinstall plan requested (dry-run mode)`,
        evidence: { executorType: type, command: commandToRun, source: commandOrigin },
        status: 'passed',
      });
      return {
        executorType: type,
        executed: false,
        command: commandToRun,
        reason: 'Dry-run mode. Set execute=true to apply.',
      };
    }

    const [binary, ...args] = commandToRun;
    const startedAt = new Date().toISOString();
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: REINSTALL_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });

    const evidence = {
      executorType: type,
      command: commandToRun,
      status: result.status,
      stdout: (result.stdout || '').slice(0, 8000),
      stderr: (result.stderr || '').slice(0, 8000),
      startedAt,
      completedAt: new Date().toISOString(),
      signal: result.signal || null,
    };

    this.recordAudit({
      type: 'executor_cli_reinstall_run',
      actor,
      projectId: null,
      sessionId: null,
      laneId: null,
      summary: `Executed ${type} CLI reinstall command`,
      evidence,
      status: result.status === 0 ? 'passed' : 'failed',
    });

    if (result.error && result.error.code) {
      evidence.errorCode = result.error.code;
      evidence.error = String(result.error.message || result.error);
    }

    return {
      executorType: type,
      executed: true,
      command: commandToRun,
      status: result.status,
      signal: result.signal || null,
      errorCode: result.error?.code || null,
      evidence,
    };
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
