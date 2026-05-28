import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { LANE_STATES } from './worker-contract.js';
import {
  createExecutorAdapter,
  getExecutorProfiles as getExecutorProfilesFromFactory,
  getExecutorProfile as getExecutorProfileFromFactory,
} from './executor-factory.js';
import { PlaywrightEvidenceRunner } from './evidence-runner.js';

const { QUEUED: QUEUED_STATE, STARTING: STARTING_STATE, RUNNING: RUNNING_STATE, STOPPED: STOPPED_STATE, DONE: DONE_STATE, FAILED: FAILED_STATE } = LANE_STATES;

const nowIso = () => new Date().toISOString();
const sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parsePositiveInteger = (value, fallback = null) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const parsePositiveFloat = (value, fallback = null) => {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const REINSTALL_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REINSTALL_ARG_LEN = 120;
const MAX_REINSTALL_ARGS = 24;
const ALLOWED_REINSTALL_BINARIES = new Set(['npm', 'pnpm', 'bun', 'brew', 'pip', 'pip3']);
const REINSTALL_PACKAGE_ALLOWLIST = {
  codex: ['codex-cli', '@openai/codex'],
  claude: ['claude-cli', 'claude-code', '@anthropic/claude-code'],
};
const REINSTALL_INSTALL_VERBS = {
  npm: ['install', 'i', 'update', 'upgrade', 'reinstall'],
  pnpm: ['install', 'add', 'update', 'upgrade', 'reinstall'],
  bun: ['install', 'add', 'upgrade', 'reinstall'],
  brew: ['install', 'upgrade', 'reinstall'],
  pip: ['install'],
  pip3: ['install'],
};
const DEFAULT_REINSTALL_COMMANDS = {
  codex: ['npm', 'install', '--yes', '-g', '@openai/codex'],
  claude: ['npm', 'install', '--yes', '-g', '@anthropic/claude-code'],
};
const MCP_TOOL_SCOPE_ALLOWLIST = new Set(['all', 'codex', 'claude', 'mock']);

function getMcpCommandAllowlist() {
  const override = process.env.COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST;
  if (!override) return null;
  return String(override)
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function normalizeReinstallToken(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (value.length > MAX_REINSTALL_ARG_LEN) return null;
  if (/[|&;<>$`\\r\n\t]/.test(value)) return null;
  return value;
}

function getReinstallPackageAllowlist(type) {
  const normalizedType = normalizeExecutorType(type);
  const envKey = `COMMAND_DECK_${normalizedType.toUpperCase()}_REINSTALL_PACKAGES`;
  const override = process.env[envKey];
  if (!override) {
    return REINSTALL_PACKAGE_ALLOWLIST[normalizedType] || [];
  }
  return String(override)
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function tokenMatchesPackage(token, allowedPackage) {
  const normalizedToken = String(token || '').toLowerCase();
  const normalizedAllowed = String(allowedPackage || '').toLowerCase();
  if (!normalizedToken || !normalizedAllowed) return false;
  const isScopedAllowed = normalizedAllowed.includes('/');
  if (normalizedToken.startsWith('http://')
    || normalizedToken.startsWith('https://')
    || normalizedToken.startsWith('git+')
    || normalizedToken.startsWith('file:')) return false;

  if (!isScopedAllowed) {
    if (normalizedToken.includes('/')) {
      // Disallow path-like package references to avoid URL/path spoofing.
      return false;
    }
    return normalizedToken === normalizedAllowed
      || normalizedToken.startsWith(`${normalizedAllowed}@`);
  }

  if (normalizedToken.includes('://')) return false;
  return normalizedToken === normalizedAllowed
    || normalizedToken.startsWith(`${normalizedAllowed}@`);
}

function hasAllowedReinstallPackage(parts, expectedType) {
  const allowlist = getReinstallPackageAllowlist(expectedType);
  if (!allowlist.length) return true;
  return parts.some((part) => allowlist.some((allowed) => tokenMatchesPackage(part, allowed)));
}

function commandTargetsExecutor(type, commandParts) {
  const normalizedType = String(type || '').toLowerCase().trim();
  if (!normalizedType) return true;

  return commandParts.some((part) => {
    const token = normalizeReinstallToken(part);
    if (!token) return false;
    return token.includes(normalizedType);
  });
}

function getInstallerVerbsForBinary(binary) {
  if (!binary) return ['install'];
  const normalizedBinary = String(binary).toLowerCase();
  const byBinary = REINSTALL_INSTALL_VERBS[normalizedBinary];
  const byBase = REINSTALL_INSTALL_VERBS[path.basename(normalizedBinary)];
  return byBase || byBinary || ['install'];
}

function normalizeExecutorType(raw) {
  return String(raw || '').toLowerCase().trim();
}

function normalizeReinstallCommand(raw, expectedType = null) {
  if (!raw) return null;
  if (!Array.isArray(raw) && typeof raw !== 'string') return null;

  let parts = [];
  if (Array.isArray(raw)) {
    parts = raw.map((item) => String(item || '').trim()).filter(Boolean);
  } else {
    const text = String(raw).trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        parts = parsed.map((item) => String(item || '').trim()).filter(Boolean);
      } else {
        parts = text.split(/\s+/).filter(Boolean);
      }
    } catch {
      parts = text.split(/\s+/).filter(Boolean);
    }
  }

  if (!parts.length || parts.length > MAX_REINSTALL_ARGS) return null;

  const [binary, ...args] = parts;
  const normalizedBinary = normalizeReinstallToken(binary);
  if (!ALLOWED_REINSTALL_BINARIES.has(normalizedBinary)) return null;

  const installVerbs = getInstallerVerbsForBinary(normalizedBinary);
  const hasInstallerVerb = args.some((arg) => installVerbs.includes(normalizeReinstallToken(arg)));
  if (!hasInstallerVerb) return null;

  if (!hasAllowedReinstallPackage(parts, expectedType)) return null;

  if (!commandTargetsExecutor(expectedType, parts)) return null;

  for (const part of parts) {
    if (!normalizeReinstallToken(part)) return null;
  }

  return [binary, ...args];
}

function getReinstallCommand(type) {
  const executorType = normalizeExecutorType(type);
  const config = {
    codex: 'COMMAND_DECK_CODEX_REINSTALL_COMMAND',
    claude: 'COMMAND_DECK_CLAUDE_REINSTALL_COMMAND',
  };
  const envVar = config[executorType];
  if (!envVar) return null;
  const configured = process.env[envVar];
  if (configured === undefined) {
    return normalizeReinstallCommand(DEFAULT_REINSTALL_COMMANDS[executorType], executorType);
  }
  return normalizeReinstallCommand(configured, executorType);
}

function getCliVersion(binary) {
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });

    if (result.error) {
      return {
        exists: false,
        version: null,
        exitCode: result.error.code,
      };
    }

    const raw = String(result.stdout || result.stderr || '').trim();
    return {
      exists: true,
      version: raw || null,
      exitCode: result.status,
    };
  } catch (error) {
    return {
      exists: false,
      version: null,
      exitCode: error.code,
    };
  }
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
  createLane: {
    requiresApproval: true,
    risk: 'high',
    message: 'Spawns executor process and can mutate workspace state.',
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
};

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function clonePayload(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

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
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 64);
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

export class CommandDeckRegistry {
  constructor({
    heartbeatIntervalMs = 2000,
    autoCompleteMs = 12000,
    heartbeatTimeoutMs = 15000,
  } = {}) {
    this.projects = [];
    this.sessions = [];
    this.lanes = [];
    this.auditEvents = [];
    this.mcpTools = [];
    this.artifactRoot = path.join(process.cwd(), 'artifacts');
    this.storageDir = path.join(process.cwd(), '.command-deck');
    this.stateFile = path.join(this.storageDir, 'state.json');

    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.autoCompleteMs = autoCompleteMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
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
    this._starting = true;
    const baseExecutorCallbacks = {
      onLog: (lane, message) => this.appendLaneLog(lane, message, { persist: false }),
      onComplete: async (lane) => this.markLaneCompleted(lane),
      onFail: async (lane, reason) => this.markLaneFailed(lane, reason, 'scheduler'),
      onStop: async (lane, context) => this.markLaneStopped(lane, context),
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
    this.restoreFromDisk();
    if (!this.projects.length) {
      this.seed();
    }
    this.startScheduler();
  }

  restoreFromDisk() {
    try {
      const raw = fsSync.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.projects = safeArray(parsed.projects);
      this.sessions = safeArray(parsed.sessions);
      this.lanes = safeArray(parsed.lanes);
      this.auditEvents = safeArray(parsed.auditEvents, []).slice(0, 200);
      if (parsed.policies && typeof parsed.policies === 'object') {
        this.policies = { ...defaultPolicy, ...parsed.policies };
      }
      if (Array.isArray(parsed.mcpTools)) {
        this.mcpTools = parsed.mcpTools;
      }
      if (parsed.cleanupSchedule && typeof parsed.cleanupSchedule === 'object') {
        this.cleanupSchedule = {
          ...this.cleanupSchedule,
          ...parsed.cleanupSchedule,
        };
      }
      this.recoverInterruptedLanes();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Failed to restore persisted Command Deck state:', error);
      }
      return;
    } finally {
      this._storageReady = true;
    }
  }

  async persistState() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(async () => {
      this._persistTimer = null;
      try {
        await fs.mkdir(this.storageDir, { recursive: true });
        const snapshot = {
          version: 1,
          savedAt: nowIso(),
          policies: this.policies,
          projects: this.projects,
          sessions: this.sessions,
          lanes: this.lanes,
          auditEvents: this.auditEvents,
          cleanupSchedule: this.cleanupSchedule,
          mcpTools: this.mcpTools,
        };
        await fs.writeFile(this.stateFile, JSON.stringify(snapshot, null, 2));
      } catch (error) {
        console.error('Persist failed:', error);
      }
    }, 250);
    this._persistTimer.unref?.();
  }

  recoverInterruptedLanes() {
    for (const lane of this.lanes) {
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
      name: 'Realm Shaper',
      slug: 'realm-shaper',
      quickLinks: [
        { label: 'Local dev server', url: 'http://localhost:4173' },
        { label: 'Artifacts', url: '/projects/realm-shaper/sessions/overview?section=artifacts' },
      ],
      owner: 'seed',
    });

    const session = this.createSession(project.id, {
      name: 'Studio coordination',
      leader: 'codex',
      laneConcurrencyLimit: 2,
      actor: 'seed',
    });

    this.createLane(session.id, {
      title: 'Initialize command deck lane',
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
  }) {
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
      quickLinks: quickLinks.slice(0, 8),
      policyProfile,
      owner,
      createdAt: now,
      updatedAt: now,
      state: 'active',
      notes: [],
    };

    this.projects.push(project);
    this.recordAudit({
      type: 'project_created',
      actor: owner,
      projectId: project.id,
      summary: `Project "${project.name}" created`,
      evidence: { project },
      status: 'passed',
    });
    this.persistState();
    return clonePayload(project);
  }

  listProjects() {
    return clonePayload(this.projects);
  }

  getProject(locator) {
    return this.projects.find((project) => project.id === locator || project.slug === locator);
  }

  updateProject(locator, patch = {}, actor = 'dashboard') {
    const project = this.getProject(locator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
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
      project.quickLinks = patch.quickLinks;
    }

    if (patch.policyProfile) {
      project.policyProfile = patch.policyProfile;
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

    const parsedRetention = parsePositiveInteger(olderThanDays, undefined);
    if (olderThanDays !== undefined) {
      if (parsedRetention === undefined && olderThanDays !== null) {
        throw { status: 422, message: 'olderThanDays must be a positive integer or null.' };
      }
      next.olderThanDays = parsedRetention || null;
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
    const now = nowIso();
    const tool = {
      id: name,
      name,
      command,
      args,
      enabled,
      scope,
      createdAt: now,
      updatedAt: now,
      owner: actor,
      notes: payload.notes || '',
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
    if (patch.notes !== undefined) tool.notes = String(patch.notes);

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

    this.recordAudit({
      type: 'mcp_tool_deleted',
      actor,
      summary: `Deleted MCP tool ${target.name}`,
      evidence: { tool: target },
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
    laneConcurrencyLimit = 1,
    artifactRetentionDays = 14,
    actor = 'dashboard',
  }) {
    const project = this.getProject(projectLocator);
    if (!project) {
      throw { status: 404, message: 'Project not found.' };
    }

    if (!name || !String(name).trim()) {
      throw { status: 422, message: 'Session name is required.' };
    }

    const now = nowIso();
    const concurrencyLimit = Math.max(1, Number.parseInt(laneConcurrencyLimit, 10) || 1);
    const retention = Number.parseInt(artifactRetentionDays, 10) || 14;
    const session = {
      id: randomUUID(),
      projectId: project.id,
      name: String(name).trim(),
      leader,
      laneConcurrencyLimit: concurrencyLimit,
      artifactRetentionDays: retention,
      route: `/projects/${project.slug}/sessions/${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      state: 'active',
      artifactsRoot: path.join(this.artifactRoot, randomUUID()),
      notes: [],
    };
    session.route = `/projects/${project.slug}/sessions/${session.id}`;

    this.sessions.push(session);
    this.recordAudit({
      type: 'session_created',
      actor,
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

  getLane(locator) {
    return this.lanes.find((lane) => lane.id === locator);
  }

  async captureLaneEvidence(laneLocator, {
    url,
    modes,
    timeoutMs,
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

    const result = await this.evidenceRunner.capture(lane, {
      url,
      modes,
      timeoutMs,
      actor,
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
      this.appendLaneLog(lane, `Evidence capture completed for ${url || 'no URL'}.`);
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
      onComplete: async (lane) => this.markLaneCompleted(lane),
      onFail: async (lane, reason) => this.markLaneFailed(lane, reason, 'scheduler'),
      onStop: async (lane, context) => this.markLaneStopped(lane, context),
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

    const normalizedExecutorType = normalizeExecutorType(executorType);
    if (['codex', 'claude'].includes(normalizedExecutorType)) {
      const commandParts = String(command || '').trim().split(/\s+/).filter(Boolean);
      if (commandParts.length > 0 && !commandTargetsExecutor(normalizedExecutorType, commandParts)) {
        throw {
          status: 422,
          message: `Lane command for ${normalizedExecutorType} must target the ${normalizedExecutorType} binary.`,
        };
      }
      if (!commandParts.length && executorBinary) {
        const normalizedBinary = String(executorBinary).trim().toLowerCase();
        const binaryName = path.basename(normalizedBinary);
        if (!binaryName.includes(normalizedExecutorType)) {
          throw {
            status: 422,
            message: `Lane executor binary for ${normalizedExecutorType} must target the ${normalizedExecutorType} binary.`,
          };
        }
      }
    }

    const project = this.projects.find((item) => item.id === session.projectId);
    const now = nowIso();
    const laneId = randomUUID();
    const scopedToolIds = new Set(this.listToolsForExecutor(normalizedExecutorType).map((tool) => tool.id));
    const resolvedToolIds = safeArray(mcpToolIds)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
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
      workdir,
      policyProfile,
      mcpTools,
      state: QUEUED_STATE,
      owner,
      heartbeatAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      exitReason: null,
      lastEvidenceCaptureAt: null,
      lastEvidence: null,
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
      lane.logs.push({ at: now, message: lane.exitReason });
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

    if (lane.state !== FAILED_STATE && lane.state !== STOPPED_STATE) {
      throw { status: 409, message: `Lane state "${lane.state}" is not retryable.` };
    }
    this.clearLaneExecutor(lane.id);

    lane.state = QUEUED_STATE;
    lane.updatedAt = nowIso();
    lane.exitReason = null;
    lane.completedAt = null;
    lane.startedAt = null;
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

    const existing = this.auditEvents.find((event) =>
      event.type === 'lane_audit_queued' &&
      event.laneId === lane.id &&
      event.status === 'pending' &&
      event.followUpQueued
    );
    if (existing) {
      return { queueId: existing.id, lane: clonePayload(lane), alreadyQueued: true };
    }

    this.appendLaneLog(lane, `Audit requested by ${context.actor || 'dashboard'}`);
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
    return { queueId, lane: clonePayload(lane) };
  }

  async queueDoneLanesAudit(sessionLocator, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) {
      throw { status: 404, message: 'Session not found.' };
    }

    const doneLanes = this.lanes.filter((lane) => lane.sessionId === session.id && lane.state === DONE_STATE);
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
        if (entry.isFile()) {
          files.push(entry.name);
        }
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

    const targetSessions = sessionId
      ? this.sessions.filter((session) => session.id === String(sessionId))
      : this.sessions;
    if (sessionId && !targetSessions.length) {
      throw {
        status: 404,
        message: 'Session not found.',
      };
    }

    const terminalStates = new Set([DONE_STATE, FAILED_STATE, STOPPED_STATE]);
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
      const effectiveRetentionDays = summary.olderThanDays || retentionDays;
      const cutoff = now - (retentionDays * msPerDay);
      const configuredCutoff = now - (effectiveRetentionDays * msPerDay);
      const sessionLanes = this.lanes.filter((lane) => lane.sessionId === session.id && terminalStates.has(lane.state));
      for (const lane of sessionLanes) {
        summary.scanned += 1;
        const laneTimestamp = new Date(lane.completedAt || lane.updatedAt || lane.createdAt).getTime();
        const deadline = Number.isFinite(configuredCutoff) ? configuredCutoff : cutoff;
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
    this.cleanupSchedule.lastRunAt = nowIso();
    this.cleanupSchedule.nextRunAt = new Date(now + cadenceMs).toISOString();
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

    if (!filename || filename.includes('..')) {
      throw { status: 400, message: 'Invalid artifact filename.' };
    }

    const laneDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
    const filePath = path.join(laneDir, filename);
    return {
      lane,
      filePath,
      fullPath: filePath,
    };
  }

  listAuditEvents({ status } = {}) {
    if (status) {
      return clonePayload(this.auditEvents.filter((event) => event.status === status));
    }
    return clonePayload(this.auditEvents);
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

  getExecutorProfiles() {
    return clonePayload(getExecutorProfilesFromFactory());
  }

  getExecutorCliInfo(executorType) {
    const type = normalizeExecutorType(executorType);
    if (!['codex', 'claude'].includes(type)) {
      throw { status: 404, message: 'Unsupported executor type.' };
    }

    const profile = getExecutorProfileFromFactory(type) || {};
    const binary = String(profile.defaultBinary || type);
    const versionInfo = getCliVersion(binary);
    const reinstallCommand = getReinstallCommand(type);
    return {
      type,
      profile,
      binary,
      binaryExists: versionInfo.exists,
      version: versionInfo.version,
      binaryExitCode: versionInfo.exitCode,
      reinstall: {
        available: Boolean(reinstallCommand),
        command: reinstallCommand,
      },
    };
  }

  async runExecutorCliReinstall(executorType, {
    actor = 'dashboard',
    approved = false,
    execute = false,
    command,
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

    const hasOverride = command !== undefined;
    const overrideCommand = hasOverride ? normalizeReinstallCommand(command, type) : null;
    const defaultCommand = getReinstallCommand(type);

    if (hasOverride && !overrideCommand) {
      throw {
        status: 422,
        message: `Invalid reinstall command override for ${type}.`,
        risk: defaultPolicy.manageExecutorCli.risk,
      };
    }

    const commandToRun = hasOverride ? overrideCommand : defaultCommand;

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
        evidence: { executorType: type, command: commandToRun, source: overrideCommand ? 'request' : 'policy' },
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
    lane.logs.push({
      at: nowIso(),
      message,
    });
    lane.updatedAt = nowIso();
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
    lane.state = DONE_STATE;
    lane.updatedAt = now;
    lane.completedAt = now;
    lane.exitReason = 'Mock execution completed';
    lane.logs.push({ at: now, message: lane.exitReason });
    this.recordAudit({
      type: 'lane_completed',
      actor: 'mock-worker',
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Lane ${lane.title} completed`,
      evidence: { lane },
      status: 'passed',
    });
    this.writeLaneArtifacts(lane, 'done').catch(() => {});
    this.clearLaneExecutor(lane.id);
    this.persistState();
  }

  markLaneFailed(lane, reason, actor = 'scheduler', persist = true) {
    const now = nowIso();
    lane.state = FAILED_STATE;
    lane.updatedAt = now;
    lane.completedAt = now;
    lane.exitReason = reason || 'Execution failed';
    lane.logs.push({ at: now, message: lane.exitReason });
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
    this.writeLaneArtifacts(lane, 'failed').catch(() => {});
    this.clearLaneExecutor(lane.id);
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
    lane.logs.push({ at: now, message: reason });
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
    this.writeLaneArtifacts(lane, 'stopped').catch(() => {});
    this.clearLaneExecutor(lane.id);
    this.persistState();
  }

  async writeLaneArtifacts(lane, status = DONE_STATE) {
    const laneArtifactDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
    await fs.mkdir(laneArtifactDir, { recursive: true });
    await fs.writeFile(
      path.join(laneArtifactDir, 'outcome.txt'),
      `Lane ${lane.id} completed at ${lane.completedAt}
Task: ${lane.taskDescription || 'No task description'}
Status: ${status}
Exit reason: ${lane.exitReason}
Executor: ${lane.executorType}
`,
    );
    await fs.writeFile(path.join(laneArtifactDir, 'transcript.json'), JSON.stringify({
      laneId: lane.id,
      title: lane.title,
      logs: lane.logs,
      completedAt: lane.completedAt,
      status,
      taskDescription: lane.taskDescription,
      command: lane.command || null,
      commandArgs: lane.commandArgs || null,
      sessionId: lane.sessionId,
      projectId: lane.projectId,
    }, null, 2));
    lane.artifactPath = `/artifacts/${lane.sessionId}/${lane.id}`;
    return clonePayload({
      files: ['outcome.txt', 'transcript.json'],
      artifactPath: lane.artifactPath,
    });
  }

  async startScheduler() {
    if (this._schedulerRunning) return;
    this._schedulerRunning = true;
    this._starting = false;
    while (this._schedulerRunning) {
      await sleep(this.heartbeatIntervalMs);
      await this.advanceLanes();
    }
  }

  stopScheduler() {
    this._schedulerRunning = false;
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
      const availableSlots = Math.max(0, session.laneConcurrencyLimit - runningCount);

      for (let i = 0; i < availableSlots; i += 1) {
        const lane = queued[i];
        if (!lane) break;
        if (lane.state !== QUEUED_STATE) continue;
        const now = nowIso();
        lane.state = STARTING_STATE;
        lane.updatedAt = now;
        lane.startedAt = now;
        lane.completedAt = null;
        lane.exitReason = null;
        lane.heartbeatAt = now;
        lane.logs.push({ at: now, message: `Lane started by scheduler using ${lane.executorType} executor` });

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
