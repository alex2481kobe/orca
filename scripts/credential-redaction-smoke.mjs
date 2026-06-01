#!/usr/bin/env node
/*
 * Orca credential redaction smoke.
 *
 * Uses only the in-memory credential backend. Verifies that dashboard-facing
 * provider APIs and persisted provider state contain credential references and
 * presence metadata only, never raw provider secrets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialStore,
  ProviderProfileStore,
} from '../src/provider-profiles.js';

const log = (label, info = '') => console.log(`[credential-redaction] ${label}${info ? ' — ' + info : ''}`);

const SECRET = 'sk-orca-redaction-smoke-secret';
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-credential-smoke-'));
try {
  const stateFile = path.join(tempDir, 'providers.json');
  const store = new ProviderProfileStore({
    stateFile,
    credentialStore: new CredentialStore({ backend: 'memory' }),
  });

  const listBefore = await store.listProfiles();
  assert.equal(listBefore.credentialBackend, 'memory');
  assert.equal(JSON.stringify(listBefore).includes(SECRET), false);

  await assert.rejects(
    () => store.setSecret('openai-compatible', SECRET, { actor: 'smoke', approved: false }),
    (error) => error.status === 409,
  );
  const set = await store.setSecret('openai-compatible', SECRET, { actor: 'smoke', approved: true });
  assert.equal(set.credential.present, true);

  const health = await store.health('openai-compatible');
  const listed = await store.listProfiles();
  const exported = await store.exportProfiles();
  const persisted = await fs.readFile(stateFile, 'utf8');
  const publicPayload = JSON.stringify({ set, health, listed, exported, persisted });

  assert.equal(publicPayload.includes(SECRET), false, 'raw secret leaked into public provider payload or state file');
  assert.equal(publicPayload.includes('secretValue'), false, 'secretValue field leaked into public provider payload');
  assert.equal(exported.excludesSecrets, true);

  const leakyDryRun = await store.importDryRun({
    schemaVersion: 1,
    profiles: [{
      id: 'leaky',
      kind: 'api',
      baseUrl: 'https://api.example.com/v1',
      secretValue: SECRET,
    }],
  });
  assert.equal(leakyDryRun.errorCount, 1);
  assert.equal(leakyDryRun.errors.some((error) => /secret values/i.test(error)), true);
  assert.equal(JSON.stringify(leakyDryRun).includes(SECRET), false, 'rejected import error echoed secret');

  const deleted = await store.deleteSecret('openai-compatible', { actor: 'smoke', approved: true });
  assert.equal(deleted.credential.deleted, true);
  assert.equal(JSON.stringify(deleted).includes(SECRET), false);

  log('done', 'provider secret references and exports are redacted');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}
