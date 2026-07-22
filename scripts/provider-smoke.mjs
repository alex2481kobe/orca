#!/usr/bin/env node
/*
 * Provider profile smoke. Safe by default: no installs, no updates, no public
 * network probes, and no real OS credential writes unless the store is
 * explicitly using the test memory credential backend.
 *
 * v2 note: the provider-config HTTP surface (`/api/providers*`) was removed
 * in "Lane 3: remove the provider-config MCP surface" (agents configure
 * providers via their own CLI, not through Orca). ProviderProfileStore now
 * lives purely in-process, consumed directly by API-style executor lanes
 * (see scripts/api-provider-smoke.mjs for that end-to-end flow). This smoke
 * therefore drives ProviderProfileStore + CredentialStore directly instead of
 * over HTTP, to keep exercising the profile catalog / export / import /
 * secret-write behavior that would otherwise only be covered by unit tests.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CredentialStore, ProviderProfileStore } from '../src/provider-profiles.js';

const log = (label, info = '') => console.log(`[provider-smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[provider-smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(label);
};

const previousCwd = process.cwd();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-provider-smoke-'));

try {
  process.chdir(tempDir);
  const stateFile = path.join(tempDir, '.orca', 'providers.json');
  const credentialStore = new CredentialStore({ backend: 'memory' });
  const store = new ProviderProfileStore({ stateFile, credentialStore });

  const list = await store.listProfiles();
  const ids = new Set(list.profiles.map((profile) => profile.id));
  for (const id of ['codex', 'claude', 'custom-cli', 'openai-compatible', 'gemini', 'kimi', 'deepseek', 'openrouter', 'composer']) {
    if (!ids.has(id)) fail('missing provider profile', id);
  }
  if (JSON.stringify(list).includes('sk-test')) fail('provider list leaked a test-looking secret value');
  if (!Array.isArray(list.credentialBackends)) fail('credential backend statuses missing');
  if (!list.credentialBackends.some((backend) => backend.id === 'macos-keychain')) fail('macOS Keychain status missing');
  log('profiles', `${ids.size} loaded; credential backend=${list.credentialBackend}`);

  const health = await store.health('openai-compatible');
  if (!['configured', 'missing_secret', 'disabled'].includes(health.status)) fail('unexpected API provider health status', health.status);
  log('api health', health.status);

  const exported = await store.exportProfiles();
  if (exported.excludesSecrets !== true) fail('export must declare secret exclusion');
  if (JSON.stringify(exported).includes('secretValue')) fail('export contains secretValue field');
  log('export', `${(exported.profiles || []).length} profiles`);

  const dryRun = await store.importDryRun({
    schemaVersion: 1,
    profiles: [
      {
        id: 'openai-compatible',
        displayName: 'OpenAI-compatible API',
        kind: 'api',
        enabled: false,
        baseUrl: 'https://api.openai.com/v1',
        apiStyle: 'openai-compatible',
        secretRef: 'provider:openai-compatible',
        apiKeyEnv: 'ORCA_OPENAI_COMPATIBLE_API_KEY',
      },
    ],
  });
  if (dryRun.dryRun !== true || dryRun.acceptedCount !== 1) fail('bad import dry-run result', JSON.stringify(dryRun));
  log('import dry-run', 'ok');

  if (list.credentialBackend === 'memory') {
    const set = await store.setSecret('openai-compatible', 'smoke-provider-secret', { actor: 'dashboard', approved: true });
    if (JSON.stringify(set).includes('smoke-provider-secret')) fail('secret set response leaked secret value');
    const afterSet = await store.health('openai-compatible');
    if (afterSet.status !== 'configured') fail('memory secret should configure provider', JSON.stringify(afterSet));
    await store.deleteSecret('openai-compatible', { actor: 'dashboard', approved: true });
    log('memory secret flow', 'ok');
  } else {
    log('secret write', 'skipped because backend is not memory');
  }

  log('done', 'ok');
} finally {
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}
