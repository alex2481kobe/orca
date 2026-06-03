import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CredentialStore,
  ProviderProfileStore,
  defaultProfiles,
  normalizeProfile,
} from '../src/provider-profiles.js';

test('concurrent ensureLoaded shares one load so callers never see unpopulated/default state', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-profile-race-'));
  const stateFile = path.join(tempDir, 'providers.json');
  try {
    // Persist a distinctive value so we can tell loaded-from-disk apart from the
    // constructor's default catalog.
    const writer = new ProviderProfileStore({ stateFile, credentialStore: new CredentialStore({ backend: 'memory' }) });
    await writer.updateProfile('openai-compatible', { allowedModels: ['race-marker-model'] }, { actor: 'test', approved: true });

    // Fresh store with a deliberately slow load. Fire two concurrent ensureLoaded
    // and capture the state the SECOND caller sees the moment it resolves. Before
    // the fix (this.loaded set before the await), the second caller returned early
    // and saw the constructor's default catalog, not the persisted marker.
    const store = new ProviderProfileStore({ stateFile, credentialStore: new CredentialStore({ backend: 'memory' }) });
    const orig = store._loadState.bind(store);
    store._loadState = async () => { await new Promise((r) => setTimeout(r, 50)); return orig(); };
    let secondCallerState = null;
    const p1 = store.ensureLoaded();
    const p2 = store.ensureLoaded().then(() => { secondCallerState = store.state; });
    await Promise.all([p1, p2]);
    const models = secondCallerState?.profiles?.['openai-compatible']?.allowedModels || [];
    assert.ok(models.includes('race-marker-model'), 'concurrent caller must observe persisted state, not constructor defaults');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('default provider catalog includes required first-class providers without managed installs', () => {
  const profiles = defaultProfiles();
  for (const id of ['codex', 'claude', 'gemini-cli', 'composer-cli', 'custom-cli', 'openai-compatible', 'gemini', 'kimi', 'deepseek', 'openrouter', 'composer']) {
    assert.equal(Boolean(profiles[id]), true, `missing ${id}`);
    assert.notEqual(profiles[id].installPolicy, 'managed');
    assert.notEqual(profiles[id].updatePolicy, 'managed');
  }
  assert.equal(profiles['gemini-cli'].kind, 'cli');
  assert.equal(profiles['composer-cli'].binary, 'cursor-agent');
  assert.equal(profiles.kimi.apiStyle, 'openai-compatible');
  assert.equal(profiles.deepseek.apiStyle, 'openai-compatible');
  assert.equal(profiles.openrouter.apiStyle, 'openai-compatible');
});

test('provider profile validation rejects unsafe base URLs and managed policies', () => {
  assert.throws(() => normalizeProfile({
    id: 'bad',
    kind: 'api',
    baseUrl: 'javascript:alert(1)',
  }), (error) => /Base URL/.test(error.message));

  assert.throws(() => normalizeProfile({
    id: 'bad-managed',
    kind: 'api',
    baseUrl: 'https://api.example.com/v1',
    installPolicy: 'managed',
  }), (error) => /Managed/.test(error.message));
});

test('provider store import/export excludes secrets and validates schema', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-providers-'));
  const store = new ProviderProfileStore({
    stateFile: path.join(tempDir, 'providers.json'),
    credentialStore: new CredentialStore({ backend: 'memory' }),
  });
  try {
    const list = await store.listProfiles();
    assert.equal(list.credentialBackend, 'memory');
    assert.equal(list.profiles.length >= 9, true);

    const dryRun = await store.importDryRun({
      schemaVersion: 1,
      profiles: [{
        id: 'openai-compatible',
        displayName: 'OpenAI-compatible API',
        kind: 'api',
        enabled: false,
        baseUrl: 'https://api.openai.com/v1',
        apiStyle: 'openai-compatible',
        secretRef: 'provider:openai-compatible',
        apiKeyEnv: 'ORCA_OPENAI_COMPATIBLE_API_KEY',
      }],
    });
    assert.equal(dryRun.acceptedCount, 1);
    assert.equal(dryRun.dryRun, true);

    const leaky = await store.importDryRun({
      schemaVersion: 1,
      profiles: [{
        id: 'leaky',
        kind: 'api',
        baseUrl: 'https://api.example.com/v1',
        secretValue: 'do-not-import',
      }],
    });
    assert.equal(leaky.errorCount, 1);
    assert.equal(leaky.errors.some((error) => /secret values/.test(error)), true);

    const exported = await store.exportProfiles();
    assert.equal(exported.excludesSecrets, true);
    assert.equal(JSON.stringify(exported).includes('do-not-import'), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('memory credential store never echoes secret values through provider APIs', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-provider-secrets-'));
  const store = new ProviderProfileStore({
    stateFile: path.join(tempDir, 'providers.json'),
    credentialStore: new CredentialStore({ backend: 'memory' }),
  });
  try {
    await assert.rejects(
      () => store.setSecret('openai-compatible', 'sk-test-secret', { actor: 'test', approved: false }),
      (error) => error.status === 409,
    );
    const set = await store.setSecret('openai-compatible', 'sk-test-secret', { actor: 'test', approved: true });
    assert.equal(set.credential.present, true);
    assert.equal(JSON.stringify(set).includes('sk-test-secret'), false);
    const health = await store.health('openai-compatible');
    assert.equal(health.status, 'configured');
    assert.equal(JSON.stringify(health).includes('sk-test-secret'), false);
    const deleted = await store.deleteSecret('openai-compatible', { actor: 'test', approved: true });
    assert.equal(deleted.credential.deleted, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('credential store reports env fallback and blocked OS backend states without values', async () => {
  const env = { ORCA_TEST_API_KEY: 'sk-env-secret' };
  const credentialStore = new CredentialStore({ backend: 'env', platform: 'linux', env });
  const description = await credentialStore.describe('provider:test', 'ORCA_TEST_API_KEY');
  assert.equal(description.present, true);
  assert.equal(description.backend, 'env');
  assert.equal(description.envFallbackPresent, true);
  assert.equal(JSON.stringify(description).includes('sk-env-secret'), false);

  const statuses = credentialStore.backendStatuses();
  assert.equal(statuses.some((status) => status.id === 'linux-secret-service' && /blocked/.test(status.status)), true);
  assert.equal(statuses.some((status) => status.id === 'windows-credential-manager' && /blocked/.test(status.status)), true);
  assert.equal(JSON.stringify(statuses).includes('sk-env-secret'), false);
});

test('provider list exposes credential backend status metadata without secret values', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-provider-backends-'));
  const store = new ProviderProfileStore({
    stateFile: path.join(tempDir, 'providers.json'),
    credentialStore: new CredentialStore({
      backend: 'env',
      platform: 'darwin',
      env: { ORCA_OPENAI_COMPATIBLE_API_KEY: 'sk-env-provider-secret' },
    }),
  });
  try {
    const list = await store.listProfiles();
    assert.equal(list.credentialBackend, 'env');
    assert.equal(Array.isArray(list.credentialBackends), true);
    assert.equal(list.credentialBackends.some((status) => status.id === 'macos-keychain' && status.available), true);
    assert.equal(JSON.stringify(list).includes('sk-env-provider-secret'), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('macOS Keychain credential backend is proven through injectable runner and redacted public status', async () => {
  const secret = 'sk-keychain-secret';
  const ref = 'provider:fake-keychain';
  const stored = new Map();
  const commands = [];
  const runner = (command, args) => {
    commands.push({ command, args: [...args] });
    assert.equal(command, 'security');
    const account = args[args.indexOf('-a') + 1];
    if (args[0] === 'add-generic-password') {
      stored.set(account, args[args.indexOf('-w') + 1]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password' && args.includes('-w')) {
      return stored.has(account)
        ? { status: 0, stdout: `${stored.get(account)}\n`, stderr: '' }
        : { status: 44, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'find-generic-password') {
      return stored.has(account)
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 44, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'delete-generic-password') {
      const deleted = stored.delete(account);
      return { status: deleted ? 0 : 44, stdout: '', stderr: deleted ? '' : 'not found' };
    }
    return { status: 64, stdout: '', stderr: 'unsupported' };
  };

  const credentialStore = new CredentialStore({
    backend: 'macos-keychain',
    platform: 'darwin',
    runner,
  });

  const set = await credentialStore.set(ref, secret);
  assert.equal(set.present, true);
  assert.equal(set.backend, 'macos-keychain');
  assert.equal(JSON.stringify(set).includes(secret), false);

  const description = await credentialStore.describe(ref);
  assert.equal(description.present, true);
  assert.equal(JSON.stringify(description).includes(secret), false);

  const value = await credentialStore.get(ref);
  assert.equal(value, secret);

  const deleted = await credentialStore.delete(ref);
  assert.equal(deleted.deleted, true);
  assert.equal(JSON.stringify(deleted).includes(secret), false);

  const afterDelete = await credentialStore.describe(ref);
  assert.equal(afterDelete.present, false);
  assert.equal(JSON.stringify({ set, description, deleted, afterDelete }).includes(secret), false);
  assert.equal(commands.some((entry) => entry.args[0] === 'add-generic-password'), true);
  assert.equal(commands.some((entry) => entry.args[0] === 'delete-generic-password'), true);
});

test('unsupported writable OS credential backends fail closed with env fallback available', async () => {
  const credentialStore = new CredentialStore({
    backend: 'linux-secret-service',
    platform: 'darwin',
    env: { ORCA_TEST_API_KEY: 'sk-env-fallback-secret' },
  });
  const description = await credentialStore.describe('provider:test', 'ORCA_TEST_API_KEY');
  assert.equal(description.present, true);
  assert.equal(description.backend, 'env');
  assert.equal(JSON.stringify(description).includes('sk-env-fallback-secret'), false);

  await assert.rejects(
    () => credentialStore.set('provider:test', 'sk-new-secret'),
    (error) => error.status === 409 && /No writable OS credential backend/.test(error.message),
  );
});
