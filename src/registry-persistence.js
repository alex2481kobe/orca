// State persistence: load-with-recovery from disk, debounced atomic writes,
// snapshot serialization, and the SSE stream-revision counter. Prototype mixin
// for OrcaRegistry. Extracted from registry.js.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nowIso, safeArray } from './registry-utils.js';
import { DEFAULT_NOTIFICATION_SETTINGS, sanitizeNotificationSettings } from './registry-notifications.js';
import { normalizeQuickLinks } from './registry-quick-links.js';
import { defaultPolicy } from './registry-policy.js';
import { normalizeAgentQueueForRestore } from './registry-agent-queue.js';
import { readJsonFileWithRecoverySync, writeJsonFileAtomic } from './state-store.js';

export const persistenceMethods = {
  restoreFromDisk() {
    const fallback = {
      version: 1,
      projects: [],
      sessions: [],
      lanes: [],
      tasks: [],
      loops: [],
      auditEvents: [],
      mcpTools: [],
      toolLeases: [],
      notifications: [],
      agentQueue: [],
      notificationSettings: { ...DEFAULT_NOTIFICATION_SETTINGS },
      policies: {},
      cleanupSchedule: {},
    };
    const recovered = readJsonFileWithRecoverySync(this.stateFile, { fallback });
    this.stateLoadStatus = recovered.status;
    let migratedFromV1 = false;
    try {
      let parsed = recovered.data || fallback;
      // v1 -> v2 fresh-start migration. The v1 model (explicit projects/sessions +
      // an exclusive per-session orchestrator marker) has no honest mapping to the
      // v2 model (implicit projects-by-cwd + first-class orchestrator records);
      // agents repopulate the whole model on reconnect. Back up the old file (never
      // silently delete), then start from an empty v2 store.
      if (parsed && parsed.version !== 2) {
        const hadData = safeArray(parsed.projects).length
          || safeArray(parsed.sessions).length
          || safeArray(parsed.lanes).length;
        if (hadData) {
          try { fsSync.copyFileSync(this.stateFile, `${this.stateFile}.v1.bak`); } catch { /* best-effort backup */ }
          migratedFromV1 = true;
        }
        parsed = { ...fallback, version: 2 };
        // Persist the fresh v2 store immediately so the migration STICKS: writes
        // are otherwise debounced+unref'd, so a crash right after migration would
        // re-read the old v1 file and re-migrate on every restart.
        try {
          fsSync.writeFileSync(this.stateFile, JSON.stringify({ ...parsed, savedAt: nowIso() }));
        } catch { /* best-effort; the debounced write will catch up */ }
      }
      this.projects = safeArray(parsed.projects).map((project) => ({
        ...project,
        quickLinks: normalizeQuickLinks(project.quickLinks || []),
      }));
      this.sessions = safeArray(parsed.sessions);
      this.orchestrators = safeArray(parsed.orchestrators);
      this.lanes = safeArray(parsed.lanes);
      this.tasks = safeArray(parsed.tasks);
      this.loops = safeArray(parsed.loops).filter((loop) => loop && typeof loop.id === 'string').slice(0, 500);
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
      if (Array.isArray(parsed.agentQueue)) {
        this.agentQueue = normalizeAgentQueueForRestore(parsed.agentQueue);
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
      if (migratedFromV1) {
        this.auditEvents.unshift({
          id: randomUUID(),
          type: 'registry_state_migrated',
          actor: 'system',
          status: 'passed',
          summary: 'Migrated state v1 -> v2 (fresh start); previous state backed up to state.json.v1.bak',
          createdAt: nowIso(),
          evidence: { from: 1, to: 2, backupPath: `${this.stateFile}.v1.bak` },
        });
      }
      this.ensureSessionWorkspaces();
      this.recoverInterruptedLanes();
      if (typeof this.recoverInterruptedTasks === 'function') {
        this.recoverInterruptedTasks();
      }
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
  },

  // Monotonic counter bumped on any state change; SSE clients diff it to know
  // when to refresh (live push instead of fixed-interval polling).
  getStreamRevision() {
    return this._streamRevision || 0;
  },

  // Bump the revision WITHOUT persisting registry state — for live events that
  // don't live in the registry (e.g. a browser pairing/revocation in the auth
  // store) but should still push an SSE `update` so the dashboard reacts instantly.
  bumpStreamRevision() {
    this._streamRevision = (this._streamRevision || 0) + 1;
    return this._streamRevision;
  },

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
  },

  snapshotState() {
    return {
      version: 2,
      savedAt: nowIso(),
      policies: this.policies,
      projects: this.projects,
      sessions: this.sessions,
      orchestrators: this.orchestrators,
      lanes: this.lanes,
      tasks: this.tasks,
      loops: this.loops,
      auditEvents: this.auditEvents,
      cleanupSchedule: this.cleanupSchedule,
      mcpTools: this.mcpTools,
      toolLeases: this.toolLeases,
      notifications: this.notifications,
      agentQueue: normalizeAgentQueueForRestore(this.agentQueue),
      notificationSettings: this.notificationSettings,
    };
  },
};
