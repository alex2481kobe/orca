#!/usr/bin/env node
/*
 * Command Deck credential backend smoke.
 *
 * Proves env fallback, macOS Keychain command wiring through an injected fake
 * runner, and explicit fail-closed blocked states for unsupported OS stores.
 * This smoke never writes real OS credentials.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialStore,
  ProviderProfileStore,
} from '../src/provider-profiles.js';

const log = (label, info = '') => console.log(`[credential-backends] ${label}${info ? ' — ' + info : ''}`);

const SECRET = 'sk-command-deck-backend-smoke-secret';
const REF = 'provider:credential-backend-smoke';

function createFakeSecurityRunner() {
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
    return { status: 64, stdout: '', stderr: 'unsupported command' };
  };
  return { runner, commands };
}

const envStore = new CredentialStore({
  backend: 'env',
  platform: 'linux',
  env: { COMMAND_DECK_BACKEND_SMOKE_API_KEY: SECRET },
});
const envDescription = await envStore.describe(REF, 'COMMAND_DECK_BACKEND_SMOKE_API_KEY');
assert.equal(envDescription.present, true);
assert.equal(envDescription.backend, 'env');
assert.equal(JSON.stringify(envDescription).includes(SECRET), false);
assert.equal(await envStore.get(REF, 'COMMAND_DECK_BACKEND_SMOKE_API_KEY'), SECRET);

const { runner, commands } = createFakeSecurityRunner();
const keychainStore = new CredentialStore({
  backend: 'macos-keychain',
  platform: 'darwin',
  runner,
});
const set = await keychainStore.set(REF, SECRET);
const described = await keychainStore.describe(REF);
assert.equal(set.present, true);
assert.equal(described.present, true);
assert.equal(await keychainStore.get(REF), SECRET);
const deleted = await keychainStore.delete(REF);
const afterDelete = await keychainStore.describe(REF);
assert.equal(deleted.deleted, true);
assert.equal(afterDelete.present, false);
assert.equal(commands.some((entry) => entry.args[0] === 'add-generic-password'), true);
assert.equal(commands.some((entry) => entry.args[0] === 'delete-generic-password'), true);

const unsupportedStore = new CredentialStore({
  backend: 'windows-credential-manager',
  platform: 'darwin',
  env: {},
});
await assert.rejects(
  () => unsupportedStore.set(REF, SECRET),
  (error) => error.status === 409,
);
const unsupportedStatuses = unsupportedStore.backendStatuses();
assert.equal(unsupportedStatuses.some((status) => status.id === 'windows-credential-manager' && /blocked/.test(status.status)), true);
assert.equal(unsupportedStatuses.some((status) => status.id === 'linux-secret-service' && /blocked/.test(status.status)), true);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-credential-backends-'));
try {
  const profileStore = new ProviderProfileStore({
    stateFile: path.join(tempDir, 'providers.json'),
    credentialStore: new CredentialStore({
      backend: 'env',
      platform: 'darwin',
      env: { COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY: SECRET },
    }),
  });
  const providerList = await profileStore.listProfiles();
  const publicPayload = JSON.stringify({
    envDescription,
    set,
    described,
    deleted,
    afterDelete,
    unsupportedStatuses,
    providerList,
  });
  assert.equal(publicPayload.includes(SECRET), false, 'credential backend public metadata leaked a secret');
  assert.equal(Array.isArray(providerList.credentialBackends), true);
  assert.equal(providerList.credentialBackends.some((status) => status.id === 'macos-keychain'), true);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

log('done', 'env fallback, fake macOS Keychain, and blocked OS backend states are redacted and fail closed');
