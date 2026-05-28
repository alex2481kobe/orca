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

test('default provider catalog includes required first-class providers without managed installs', () => {
  const profiles = defaultProfiles();
  for (const id of ['codex', 'claude', 'custom-cli', 'openai-compatible', 'gemini', 'kimi', 'deepseek', 'openrouter', 'composer']) {
    assert.equal(Boolean(profiles[id]), true, `missing ${id}`);
    assert.notEqual(profiles[id].installPolicy, 'managed');
    assert.notEqual(profiles[id].updatePolicy, 'managed');
  }
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-providers-'));
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
        apiKeyEnv: 'COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY',
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-provider-secrets-'));
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
