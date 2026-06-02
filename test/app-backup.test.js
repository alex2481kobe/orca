import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_EXPORT_KIND,
  buildSupportBundle,
  redactDeep,
  validateAppImport,
} from '../src/app-backup.js';

test('app import dry-run rejects secret/auth/artifact fields without echoing values', () => {
  const secret = 'sk-app-import-secret-value';
  assert.throws(
    () => validateAppImport({
      schemaVersion: 1,
      kind: APP_EXPORT_KIND,
      registry: { projects: [] },
      secretValue: secret,
      authSessions: [{ token: secret }],
    }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(String(error.message).includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});

test('app import dry-run summarizes accepted backup payloads', () => {
  const result = validateAppImport({
    schemaVersion: 1,
    kind: APP_EXPORT_KIND,
    registry: {
      projects: [{ id: 'project-a', name: 'Project A' }],
      sessions: [{ id: 'session-a', projectId: 'project-a' }],
      lanes: [{ id: 'lane-a', sessionId: 'session-a', state: 'running' }],
      mcpTools: [{ id: 'tool-a' }],
      notifications: [{ id: 'notification-a' }],
    },
    providers: { schemaVersion: 1, profiles: [{ id: 'openai-compatible' }] },
    privateAccess: { targets: [{ id: 'target-a' }] },
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.counts.projects, 1);
  assert.equal(result.counts.lanes, 1);
  assert.match(result.warnings.join(' '), /active lane/);
});

test('redaction removes secrets and local absolute paths from support-shaped data', () => {
  const redacted = redactDeep({
    message: 'token=sk-redaction-secret-value',
    path: '/Users/testuser/Documents/private/project',
    nested: {
      apiKey: 'sk-redaction-secret-value',
      safe: 'ok',
    },
  });
  const text = JSON.stringify(redacted);
  assert.equal(text.includes('sk-redaction-secret-value'), false);
  assert.equal(text.includes('/Users/testuser'), false);
  assert.equal(text.includes('[LOCAL_PATH]'), true);
  assert.equal(redacted.nested.safe, 'ok');
});

test('support bundle builder excludes auth sessions and raw artifacts', async () => {
  const registry = {
    snapshotState() {
      return {
        version: 1,
        projects: [{ id: 'p1', name: 'Support Project' }],
        sessions: [],
        lanes: [],
        auditEvents: [{ id: 'a1', summary: 'Used sk-support-secret-value' }],
        cleanupSchedule: {},
        mcpTools: [],
        notifications: [],
        notificationSettings: {},
      };
    },
  };
  const providerProfiles = {
    async listProfiles() {
      return {
        profiles: [{
          id: 'openai-compatible',
          displayName: 'OpenAI Compatible',
          kind: 'api',
          credential: { present: true, backend: 'memory' },
        }],
      };
    },
  };
  const privateAccess = {
    state: {
      settings: {},
      targets: [{ id: 't1', label: 'Local', mode: 'local', localUrl: 'http://127.0.0.1:3000' }],
    },
    async ensureLoaded() {},
  };

  const bundle = await buildSupportBundle({
    registry,
    providerProfiles,
    privateAccess,
    routeInventory: { routeCount: 1, routes: [] },
  });
  const text = JSON.stringify(bundle);
  assert.equal(bundle.kind, 'orca.support-bundle');
  assert.equal(bundle.includesAuthSessions, false);
  assert.equal(bundle.includesArtifacts, false);
  assert.equal(text.includes('sk-support-secret-value'), false);
});

test('app import rejects prototype-pollution keys and redactDeep drops them', () => {
  // Build via JSON.parse so __proto__/constructor are real OWN keys (the actual
  // attack shape) — an object literal would set the prototype instead.
  const payload = JSON.parse(
    `{"schemaVersion":1,"kind":"${APP_EXPORT_KIND}","registry":{"projects":[{"id":"p","__proto__":{"polluted":true}}]}}`,
  );
  assert.throws(
    () => validateAppImport(payload),
    (e) => e.status === 422 && Array.isArray(e.blockedKeys),
  );
  // redactDeep strips __proto__/constructor without polluting Object.prototype.
  const dirty = JSON.parse('{"keep":1,"__proto__":{"polluted":"x"},"constructor":{"bad":1}}');
  const cleaned = redactDeep(dirty);
  assert.equal({}.polluted, undefined);
  assert.equal(cleaned.keep, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(cleaned, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cleaned, 'constructor'), false);
});
