import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthSessionStore } from '../src/auth-sessions.js';
import { PrivateAccessStore } from '../src/private-access.js';
import {
  CredentialStore,
  ProviderProfileStore,
  defaultProfiles,
} from '../src/provider-profiles.js';
import { OrcaRegistry } from '../src/registry.js';
import {
  backupPathFor,
  readJsonFileWithRecovery,
  readJsonFileWithRecoverySync,
  writeJsonFileAtomic,
  writeJsonFileAtomicSync,
} from '../src/state-store.js';

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('async state store writes atomically, backs up, restores corrupt primary, and migrates', async () => {
  await withTempDir('orca-state-async-', async (dir) => {
    const stateFile = path.join(dir, 'state.json');
    await writeJsonFileAtomic(stateFile, { schemaVersion: 1, value: 'safe' });
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).value, 'safe');
    assert.equal(JSON.parse(await fs.readFile(backupPathFor(stateFile), 'utf8')).value, 'safe');

    await fs.writeFile(stateFile, '{ bad json');
    const recovered = await readJsonFileWithRecovery(stateFile, {
      fallback: { schemaVersion: 1, value: 'fallback' },
      migrate(data) {
        return { ...data, migrated: true };
      },
    });
    assert.equal(recovered.data.value, 'safe');
    assert.equal(recovered.data.migrated, true);
    assert.equal(recovered.status.source, 'backup');
    assert.equal(recovered.status.recovered, true);
    assert.equal(recovered.status.migrated, true);
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).value, 'safe');
    const entries = await fs.readdir(dir);
    assert.equal(entries.some((name) => name.includes('.corrupt.')), true);

    await fs.unlink(stateFile);
    const missingPrimary = await readJsonFileWithRecovery(stateFile, {
      fallback: { schemaVersion: 1, value: 'fallback' },
    });
    assert.equal(missingPrimary.data.value, 'safe');
    assert.equal(missingPrimary.status.source, 'backup');
    assert.equal(missingPrimary.status.missing, true);
  });
});

test('sync state store writes atomically and recovers corrupt primary from backup', async () => {
  await withTempDir('orca-state-sync-', async (dir) => {
    const stateFile = path.join(dir, 'state.json');
    writeJsonFileAtomicSync(stateFile, { schemaVersion: 1, value: 'sync-safe' });
    await fs.writeFile(stateFile, '{ bad json');
    const recovered = readJsonFileWithRecoverySync(stateFile, {
      fallback: () => ({ schemaVersion: 1, value: 'fallback' }),
      migrate(data) {
        data.syncMigrated = true;
      },
    });
    assert.equal(recovered.data.value, 'sync-safe');
    assert.equal(recovered.data.syncMigrated, true);
    assert.equal(recovered.status.source, 'backup');
    assert.equal(recovered.status.recovered, true);
  });
});

test('provider profile store recovers from backup and audits recovery', async () => {
  await withTempDir('orca-provider-recovery-', async (dir) => {
    const stateFile = path.join(dir, 'providers.json');
    const profiles = defaultProfiles();
    profiles['openai-compatible'] = {
      ...profiles['openai-compatible'],
      enabled: false,
    };
    await writeJsonFileAtomic(stateFile, {
      schemaVersion: 1,
      profiles,
      auditEvents: [],
    });
    await fs.writeFile(stateFile, '{ broken provider json');

    const store = new ProviderProfileStore({
      stateFile,
      credentialStore: new CredentialStore({ backend: 'memory' }),
    });
    const listed = await store.listProfiles();
    assert.equal(listed.loadStatus.source, 'backup');
    assert.equal(listed.loadStatus.recovered, true);
    assert.equal(store.state.auditEvents.some((event) => event.type === 'provider_state_recovered'), true);
  });
});

test('private access store recovers targets from backup and audits recovery', async () => {
  await withTempDir('orca-private-recovery-', async (dir) => {
    const stateFile = path.join(dir, 'private-access.json');
    const seed = new PrivateAccessStore({ stateFile });
    await seed.createTarget({
      label: 'Local app',
      mode: 'local',
      localUrl: 'http://localhost:4173',
    });
    await fs.writeFile(stateFile, '{ broken private access json');

    const recovered = new PrivateAccessStore({ stateFile });
    const described = await recovered.describe();
    assert.equal(described.loadStatus.source, 'backup');
    assert.equal(described.loadStatus.recovered, true);
    assert.equal(described.targets.length, 1);
    assert.equal(recovered.state.auditEvents.some((event) => event.type === 'private_access_state_recovered'), true);
  });
});

test('auth session store recovers sessions from backup and audits recovery', async () => {
  await withTempDir('orca-auth-recovery-', async (dir) => {
    const stateFile = path.join(dir, 'auth-sessions.json');
    const seed = new AuthSessionStore({
      stateFile,
      pairingTtlMs: 60000,
      sessionTtlMs: 60000,
    });
    seed.createPairingCode({ actor: 'test', label: 'phone' });
    await fs.writeFile(stateFile, '{ broken auth json');

    const recovered = new AuthSessionStore({
      stateFile,
      pairingTtlMs: 60000,
      sessionTtlMs: 60000,
    });
    assert.equal(recovered.loadStatus.source, 'backup');
    assert.equal(recovered.loadStatus.recovered, true);
    assert.equal(recovered.state.pairingCodes.length, 1);
    assert.equal(recovered.state.auditEvents.some((event) => event.type === 'auth_state_recovered'), true);
  });
});

test('registry recovers persisted projects from backup and audits recovery', async () => {
  await withTempDir('orca-registry-recovery-', async (dir) => {
    const previousCwd = process.cwd();
    process.chdir(dir);
    const stateFile = path.join(dir, '.orca', 'state.json');
    try {
      await writeJsonFileAtomic(stateFile, {
        version: 2,
        savedAt: new Date().toISOString(),
        policies: {},
        projects: [{
          id: 'project-one',
          name: 'Project One',
          slug: 'project-one',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          quickLinks: [],
        }],
        sessions: [],
        lanes: [],
        auditEvents: [],
        cleanupSchedule: {},
        mcpTools: [],
        toolLeases: [],
      });
      await fs.writeFile(stateFile, '{ broken registry json');

      const registry = new OrcaRegistry({ heartbeatIntervalMs: 5 });
      try {
        assert.equal(registry.stateLoadStatus.source, 'backup');
        assert.equal(registry.stateLoadStatus.recovered, true);
        assert.equal(registry.projects.length, 1);
        assert.equal(registry.projects[0].name, 'Project One');
        assert.equal(registry.auditEvents.some((event) => event.type === 'registry_state_recovered'), true);
      } finally {
        registry.stopScheduler();
        if (typeof registry.drainPendingWrites === 'function') {
          await registry.drainPendingWrites();
        }
      }
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// PORTED from 'registry restores persisted sessions and normalizes invalid
// session config'. v3 is the orchestrator-only model: the Model-A session
// container was deleted, so there is no getSession('s1') / ensureSessionWorkspaces
// session-config normalization to assert anymore. The load-bearing intent that
// survives is: restoreFromDisk must migrate a legacy v2 store (with sessions) to
// v3 WITHOUT throwing — dropping the sessions, keeping projects + orchestrator-
// referencing lanes, and recording a migration audit event.
test('registry migrates a legacy v2 store (sessions dropped) to the orchestrator-only v3 model', async () => {
  await withTempDir('orca-v2-migrate-', async (dir) => {
    const previousCwd = process.cwd();
    process.chdir(dir);
    const stateFile = path.join(dir, '.orca', 'state.json');
    try {
      await writeJsonFileAtomic(stateFile, {
        version: 2,
        savedAt: new Date().toISOString(),
        policies: {},
        projects: [{
          id: 'p1', name: 'P1', slug: 'p1',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quickLinks: [],
        }],
        orchestrators: [{
          id: 'orc_legacy', projectId: 'p1', actor: 'chat', leaseId: 'dashboard',
          registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
        }],
        // Legacy session container with invalid enum config — must be dropped by
        // the v2 -> v3 migration (no throw, no getSession revival).
        sessions: [{
          id: 's1', projectId: 'p1', name: 'S1',
          spawnPolicy: 'bogus', idleShutdownMode: 'bogus', critiqueMode: 'bogus',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
        // A lane still bound to the orchestrator survives; a pure-session lane does not.
        lanes: [
          { id: 'lane-orc', orchestratorId: 'orc_legacy', projectId: 'p1', sessionId: 'orc_legacy', title: 'kept', state: 'done' },
          { id: 'lane-session', projectId: 'p1', sessionId: 's1', title: 'dropped', state: 'done' },
        ],
        auditEvents: [], cleanupSchedule: {}, mcpTools: [], toolLeases: [],
      });

      const registry = new OrcaRegistry({ heartbeatIntervalMs: 5 });
      try {
        // Sessions are gone in v3: the legacy session id never resolves.
        assert.equal(registry.getSession('s1'), undefined, 'legacy session must not be revived');
        // The orchestrator container survives and getSession resolves the orc_ id.
        assert.ok(registry.getSession('orc_legacy'), 'orchestrator container restored from disk');
        assert.equal(registry.projects.length, 1);
        // Only the orchestrator-referencing lane is carried over.
        assert.ok(registry.getLane('lane-orc'), 'orchestrator-bound lane survives migration');
        assert.equal(registry.getLane('lane-session'), undefined, 'pure-session lane dropped');
        // Migration audit event recorded (no throw during restore).
        assert.equal(registry.auditEvents.some((event) => event.type === 'registry_state_migrated'), true);
      } finally {
        registry.stopScheduler();
        if (typeof registry.drainPendingWrites === 'function') {
          await registry.drainPendingWrites();
        }
      }
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('state store writes compact JSON by default that round-trips, and recovers a corrupt primary from backup', async () => {
  await withTempDir('orca-state-compact-', async (dir) => {
    const stateFile = path.join(dir, 'state.json');
    const payload = { schemaVersion: 1, nested: { a: 1, b: [2, 3] }, value: 'compact' };
    await writeJsonFileAtomic(stateFile, payload);

    // Compact by default: single line, no indentation (only a trailing newline).
    const raw = await fs.readFile(stateFile, 'utf8');
    assert.equal(raw, `${JSON.stringify(payload)}\n`);
    assert.equal(raw.includes('\n  '), false, 'no pretty-print indentation');
    assert.equal(raw.trimEnd().includes('\n'), false, 'primary JSON is a single line');

    // The compact form must still round-trip through the recovery read path.
    const primary = await readJsonFileWithRecovery(stateFile, { fallback: {} });
    assert.equal(primary.status.source, 'primary');
    assert.deepEqual(primary.data, payload);

    // The very first backup is never throttled away, so a corrupt primary still
    // recovers from `.bak`.
    assert.deepEqual(JSON.parse(await fs.readFile(backupPathFor(stateFile), 'utf8')), payload);
    await fs.writeFile(stateFile, '{ corrupt');
    const recovered = await readJsonFileWithRecovery(stateFile, { fallback: {} });
    assert.equal(recovered.status.source, 'backup');
    assert.equal(recovered.status.recovered, true);
    assert.deepEqual(recovered.data, payload);
  });
});

test('ORCA_PRETTY_STATE=1 writes indented JSON that still round-trips', async () => {
  await withTempDir('orca-state-pretty-', async (dir) => {
    const stateFile = path.join(dir, 'state.json');
    const payload = { schemaVersion: 1, value: 'pretty' };
    const prev = process.env.ORCA_PRETTY_STATE;
    process.env.ORCA_PRETTY_STATE = '1';
    try {
      await writeJsonFileAtomic(stateFile, payload);
    } finally {
      if (prev === undefined) delete process.env.ORCA_PRETTY_STATE;
      else process.env.ORCA_PRETTY_STATE = prev;
    }
    const raw = await fs.readFile(stateFile, 'utf8');
    assert.equal(raw.includes('\n  '), true, 'pretty output is indented');
    const read = await readJsonFileWithRecovery(stateFile, { fallback: {} });
    assert.deepEqual(read.data, payload);
  });
});

test('backup copy is throttled per write but the first and forced backups always fire', async () => {
  await withTempDir('orca-state-throttle-', async (dir) => {
    const stateFile = path.join(dir, 'state.json');
    const bak = backupPathFor(stateFile);

    // First write: backup is always taken (throttle can never skip the first).
    await writeJsonFileAtomic(stateFile, { v: 1 });
    assert.equal(JSON.parse(await fs.readFile(bak, 'utf8')).v, 1);

    // Immediate second write within the 60s window: primary advances, backup is
    // throttled (still the previous value).
    await writeJsonFileAtomic(stateFile, { v: 2 });
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).v, 2);
    assert.equal(JSON.parse(await fs.readFile(bak, 'utf8')).v, 1);

    // forceBackup (the shutdown-flush path) always refreshes `.bak` regardless
    // of the throttle window.
    await writeJsonFileAtomic(stateFile, { v: 3 }, { forceBackup: true });
    assert.equal(JSON.parse(await fs.readFile(bak, 'utf8')).v, 3);
  });
});

test('state-store strips prototype-pollution keys when reading from disk', async () => {
  await withTempDir('orca-proto-pollution-', async (dir) => {
    const target = path.join(dir, 'state.json');
    // A crafted file with __proto__/constructor payloads.
    await fs.writeFile(target, JSON.stringify({
      ok: true,
      __proto__: { polluted: 'yes' },
      nested: { constructor: { prototype: { bad: 1 } }, keep: 'value' },
    }));
    const result = await readJsonFileWithRecovery(target, { fallback: {} });
    assert.equal(result.status.ok, true);
    // Object.prototype must not be polluted.
    assert.equal({}.polluted, undefined);
    // Dangerous keys stripped; legitimate data preserved.
    assert.equal(Object.prototype.hasOwnProperty.call(result.data, '__proto__'), false);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.nested.keep, 'value');
  });
});
