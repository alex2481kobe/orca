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
        version: 1,
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

test('registry restores persisted sessions and normalizes invalid session config', async () => {
  await withTempDir('orca-session-restore-', async (dir) => {
    const previousCwd = process.cwd();
    process.chdir(dir);
    const stateFile = path.join(dir, '.orca', 'state.json');
    try {
      await writeJsonFileAtomic(stateFile, {
        version: 1,
        savedAt: new Date().toISOString(),
        policies: {},
        projects: [{
          id: 'p1', name: 'P1', slug: 'p1',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quickLinks: [],
        }],
        // Session with invalid enum config — exercises ensureSessionWorkspaces
        // normalization (regression guard for the lane-config extraction).
        sessions: [{
          id: 's1', projectId: 'p1', name: 'S1',
          spawnPolicy: 'bogus', idleShutdownMode: 'bogus', critiqueMode: 'bogus',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
        lanes: [], auditEvents: [], cleanupSchedule: {}, mcpTools: [], toolLeases: [],
      });

      const registry = new OrcaRegistry({ heartbeatIntervalMs: 5 });
      try {
        const session = registry.getSession('s1');
        assert.ok(session, 'session restored from disk');
        // Invalid enums normalized to safe defaults (no ReferenceError thrown).
        const cap = registry.getSessionCapacity('s1');
        assert.equal(cap.spawnPolicy, 'within_capacity');
        assert.equal(cap.idleShutdownMode, 'immediate');
        assert.equal(session.critiqueMode, 'suggested');
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
