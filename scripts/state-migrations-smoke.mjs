import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthSessionStore } from '../src/auth-sessions/store.js';
import { PrivateAccessStore } from '../src/private-access/store.js';
import { OrcaRegistry } from '../src/registry.js';
import { backupPathFor, writeJsonFileAtomic } from '../src/state-store/io.js';
import { readJsonFileWithRecovery } from '../src/state-store/recovery.js';

const nowIso = () => new Date().toISOString();

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function corruptPrimary(filePath) {
  await fs.writeFile(filePath, '{ intentionally corrupt json');
}

async function verifySharedStore(dir) {
  const stateFile = path.join(dir, 'shared.json');
  await writeJsonFileAtomic(stateFile, { schemaVersion: 1, check: 'shared-store' });
  await corruptPrimary(stateFile);
  const result = await readJsonFileWithRecovery(stateFile, {
    fallback: { schemaVersion: 1, check: 'fallback' },
  });
  assert.equal(result.data.check, 'shared-store');
  assert.equal(result.status.source, 'backup');
  assert.equal(result.status.recovered, true);
  assert.equal(JSON.parse(await fs.readFile(backupPathFor(stateFile), 'utf8')).check, 'shared-store');
}

async function verifyPrivateAccessStore(dir) {
  const stateFile = path.join(dir, 'private-access.json');
  const store = new PrivateAccessStore({ stateFile });
  await store.updateSettings({ preferredMode: 'tailnet-https-serve' });
  await corruptPrimary(stateFile);
  const recovered = new PrivateAccessStore({ stateFile });
  const described = await recovered.describe({ fakeTailnetState: 'serve-http' });
  assert.equal(described.loadStatus.source, 'backup');
  assert.equal(described.settings.preferredMode, 'tailnet-https-serve');
  assert.equal(recovered.state.auditEvents.some((event) => event.type === 'private_access_state_recovered'), true);
}

async function verifyAuthStore(dir) {
  const stateFile = path.join(dir, 'auth-sessions.json');
  const store = new AuthSessionStore({
    stateFile,
    pairingTtlMs: 60000,
    sessionTtlMs: 60000,
  });
  store.createPairingCode({ actor: 'smoke', label: 'phone' });
  await corruptPrimary(stateFile);
  const recovered = new AuthSessionStore({
    stateFile,
    pairingTtlMs: 60000,
    sessionTtlMs: 60000,
  });
  assert.equal(recovered.loadStatus.source, 'backup');
  assert.equal(recovered.state.pairingCodes.length, 1);
  assert.equal(recovered.state.auditEvents.some((event) => event.type === 'auth_state_recovered'), true);
}

async function verifyRegistryStore(dir) {
  const previousCwd = process.cwd();
  process.chdir(dir);
  const stateFile = path.join(dir, '.orca', 'state.json');
  try {
    await writeJsonFileAtomic(stateFile, {
      // v2 schema (see OrcaRegistry#snapshotState in src/registry-persistence.js).
      // A `version: 1` seed here would trip the v1 -> v2 fresh-start migration
      // (src/registry-persistence.js `restoreFromDisk`), which intentionally
      // discards projects/sessions/lanes on load — that's not a recovery bug,
      // it's the documented one-way migration, and would make this smoke seed
      // its own failure regardless of backup recovery working correctly.
      version: 2,
      savedAt: nowIso(),
      policies: {},
      projects: [{
        id: 'smoke-project',
        name: 'Smoke Project',
        slug: 'smoke-project',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        quickLinks: [],
      }],
      sessions: [],
      orchestrators: [],
      lanes: [],
      auditEvents: [],
      cleanupSchedule: {},
      mcpTools: [],
      toolLeases: [],
      agentQueue: [],
    });
    await corruptPrimary(stateFile);
    const registry = new OrcaRegistry({ heartbeatIntervalMs: 5 });
    try {
      assert.equal(registry.stateLoadStatus.source, 'backup');
      assert.equal(registry.projects.length, 1);
      assert.equal(registry.auditEvents.some((event) => event.type === 'registry_state_recovered'), true);
    } finally {
      registry.stopScheduler();
      await registry.drainPendingWrites();
    }
  } finally {
    process.chdir(previousCwd);
  }
}

await withTempDir('orca-state-smoke-', async (dir) => {
  await verifySharedStore(dir);
  await verifyPrivateAccessStore(dir);
  await verifyAuthStore(dir);
  await verifyRegistryStore(dir);
});

console.log('state migration/recovery smoke passed');
