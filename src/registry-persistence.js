// State persistence: load-with-recovery from disk, debounced atomic writes,
// snapshot serialization, and the SSE stream-revision counter. Prototype mixin
// for OrcaRegistry. Extracted from registry.js.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nowIso, safeArray } from './registry-utils.js';
import { normalizeQuickLinks } from './registry-quick-links.js';
import { defaultPolicy } from './registry-policy.js';
import { normalizeAgentQueueForRestore } from './registry-agent-queue.js';
import { readJsonFileWithRecoverySync } from './state-store/recovery.js';
import { writeJsonFileAtomic } from './state-store/io.js';

export const persistenceMethods = {
  restoreFromDisk() {
    const fallback = {
      version: 3,
      projects: [],
      lanes: [],
      tasks: [],
      loops: [],
      auditEvents: [],
      mcpTools: [],
      toolLeases: [],
      agentQueue: [],
      policies: {},
      cleanupSchedule: {},
    };
    const recovered = readJsonFileWithRecoverySync(this.stateFile, { fallback });
    this.stateLoadStatus = recovered.status;
    let migratedFromV1 = false;
    let migratedFromV2 = false;
    let migrationBackupPath = null;
    try {
      let parsed = recovered.data || fallback;
      // Persisted-state migration. v3 is the orchestrator-only model (no session
      // container). Back up before any migration (never silently delete), then
      // persist the migrated store immediately so it STICKS (writes are otherwise
      // debounced+unref'd; a crash right after would re-migrate on every restart).
      if (parsed && parsed.version !== 3) {
        if (parsed.version === 2) {
          // v2 -> v3: the session container is removed and the orchestrator record
          // is the only container. Carry over projects/orchestrators + lanes that
          // already reference an orchestrator; drop pure-session lanes + all sessions.
          migrationBackupPath = `${this.stateFile}.v2.bak`;
          try { fsSync.copyFileSync(this.stateFile, migrationBackupPath); } catch { /* best-effort backup */ }
          migratedFromV2 = true;
          parsed = {
            ...fallback,
            version: 3,
            projects: safeArray(parsed.projects),
            orchestrators: safeArray(parsed.orchestrators),
            lanes: safeArray(parsed.lanes).filter((lane) => lane && lane.orchestratorId),
            auditEvents: safeArray(parsed.auditEvents),
            mcpTools: safeArray(parsed.mcpTools),
            toolLeases: safeArray(parsed.toolLeases),
            agentQueue: safeArray(parsed.agentQueue),
            policies: parsed.policies || {},
            cleanupSchedule: parsed.cleanupSchedule || {},
          };
        } else {
          // v1 (or unknown legacy) -> fresh start. The v1 model (explicit
          // projects/sessions + per-session orchestrator markers) has no honest
          // mapping; agents repopulate the whole model on reconnect.
          const hadData = safeArray(parsed.projects).length
            || safeArray(parsed.sessions).length
            || safeArray(parsed.lanes).length;
          if (hadData) {
            migrationBackupPath = `${this.stateFile}.v1.bak`;
            try { fsSync.copyFileSync(this.stateFile, migrationBackupPath); } catch { /* best-effort backup */ }
            migratedFromV1 = true;
          }
          parsed = { ...fallback, version: 3 };
        }
        try {
          fsSync.writeFileSync(this.stateFile, JSON.stringify({ ...parsed, savedAt: nowIso() }));
        } catch { /* best-effort; the debounced write will catch up */ }
      }
      this.projects = safeArray(parsed.projects).map((project) => ({
        ...project,
        quickLinks: normalizeQuickLinks(project.quickLinks || []),
      }));
      this.orchestrators = safeArray(parsed.orchestrators);
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
      if (Array.isArray(parsed.agentQueue)) {
        this.agentQueue = normalizeAgentQueueForRestore(parsed.agentQueue);
      }
      if (parsed.cleanupSchedule && typeof parsed.cleanupSchedule === 'object') {
        this.cleanupSchedule = {
          ...this.cleanupSchedule,
          ...parsed.cleanupSchedule,
        };
      }
      if (migratedFromV1 || migratedFromV2) {
        const from = migratedFromV2 ? 2 : 1;
        this.auditEvents.unshift({
          id: randomUUID(),
          type: 'registry_state_migrated',
          actor: 'system',
          status: 'passed',
          summary: migratedFromV2
            ? `Migrated state v2 -> v3 (session container removed); previous state backed up to ${migrationBackupPath}`
            : `Migrated state v1 -> v3 (fresh start); previous state backed up to ${migrationBackupPath}`,
          createdAt: nowIso(),
          evidence: { from, to: 3, backupPath: migrationBackupPath },
        });
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
      this._flushPersistTimer();
    }, 250);
    this._persistTimer.unref?.();
  },

  // Fire the debounced persist NOW and return the tracked write promise, so
  // drainPendingWrites()/shutdown can await it. Without this, a persist whose
  // 250ms timer fires during teardown leaves an untracked in-flight fs.mkdir
  // that resolves after the process's callback scope closes — the AfterMkdirp
  // assertion crash seen under full-suite load. Safe to call with no timer set.
  _flushPersistTimer({ forceBackup = false } = {}) {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    // Snapshot NOW (at flush-issue time) and CHAIN this write after any in-flight
    // write to the same state file. Two concurrent writes' atomic temp+rename can
    // land OUT of issue order under I/O contention, so an earlier (staler) snapshot
    // would win the rename race and silently drop just-persisted state — e.g. an
    // initial stopScheduler flush (empty) racing the drain flush that carries a
    // freshly enqueued agent event. Serializing on _writeChain guarantees the
    // last-ISSUED (freshest) snapshot is the last to hit disk.
    const snapshot = this.snapshotState();
    const write = (this._writeChain || Promise.resolve()).then(async () => {
      try {
        await fs.mkdir(this.storageDir, { recursive: true });
        await writeJsonFileAtomic(this.stateFile, snapshot, { forceBackup });
      } catch (error) {
        console.error('Persist failed:', error);
      }
    });
    this._writeChain = write;
    this._trackAsync(write);
    return write;
  },

  snapshotState() {
    return {
      version: 3,
      savedAt: nowIso(),
      policies: this.policies,
      projects: this.projects,
      orchestrators: this.orchestrators,
      lanes: this.lanes,
      auditEvents: this.auditEvents,
      cleanupSchedule: this.cleanupSchedule,
      mcpTools: this.mcpTools,
      toolLeases: this.toolLeases,
      agentQueue: normalizeAgentQueueForRestore(this.agentQueue),
    };
  },
};
