import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandDeckRegistry } from '../src/registry.js';
import {
  buildEffectiveSettings,
  sanitizeSettingsOverrides,
} from '../src/effective-settings.js';

async function withTempRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-effective-settings-'));
  let registry = null;
  process.chdir(tempDir);
  try {
    registry = new CommandDeckRegistry();
    await callback(registry);
  } finally {
    if (registry && typeof registry.stopScheduler === 'function') {
      registry.stopScheduler();
    }
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('effective settings expose locked product defaults without secrets', () => {
  const effective = buildEffectiveSettings();

  assert.equal(effective.contractVersion, 'command-deck.effective-settings.v1');
  assert.equal(effective.settings.spawn.spawnPolicy, 'within_capacity');
  assert.equal(effective.settings.spawn.approvedCapacity, 2);
  assert.equal(effective.settings.spawn.soloMode, true);
  assert.equal(effective.settings.spawn.idleShutdownMode, 'immediate');
  assert.equal(effective.settings.critique.mode, 'suggested');
  assert.equal(effective.settings.critique.visualBrowserMode, 'visual-required');
  assert.equal(effective.settings.provider.secretPriority[0], 'os-credential');
  assert.equal(effective.settings.privateAccess.preferredMode, 'auto');
  assert.equal(effective.settings.privateAccess.funnelAllowed, false);
  assert.equal(effective.settings.urlOpening.defaultMode, 'external');
  assert.equal(effective.settings.mobile.pwaStaticCacheOnly, true);
  assert.equal(JSON.stringify(effective).includes('apiKey'), false);
});

test('effective settings precedence applies project, session, lane, and action overrides', () => {
  const effective = buildEffectiveSettings({
    project: {
      id: 'project-1',
      slug: 'project-1',
      settingsOverrides: {
        spawn: { approvedCapacity: 3 },
        privateAccess: { preferredMode: 'local' },
      },
    },
    session: {
      id: 'session-1',
      projectId: 'project-1',
      spawnPolicy: 'ask',
      approvedCapacity: 4,
      soloMode: false,
      idleShutdownMode: 'policy',
      critiqueMode: 'required',
      artifactRetentionDays: 30,
      settingsOverrides: {
        spawn: { approvedCapacity: 5 },
        notifications: { browser: true },
      },
    },
    lane: {
      id: 'lane-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      targetUrl: 'http://127.0.0.1:4173',
      critiqueMode: 'off',
      settingsOverrides: {
        critique: { mode: 'visual-required' },
        urlOpening: { defaultMode: 'in-app' },
      },
    },
    actionOverride: {
      spawn: { approvedCapacity: 1 },
      cleanup: { dryRunDefault: false },
    },
  });

  assert.equal(effective.settings.spawn.spawnPolicy, 'ask');
  assert.equal(effective.settings.spawn.approvedCapacity, 1);
  assert.equal(effective.settings.spawn.soloMode, false);
  assert.equal(effective.settings.spawn.idleShutdownMode, 'policy');
  assert.equal(effective.settings.critique.mode, 'visual-required');
  assert.equal(effective.settings.critique.visualBrowserMode, 'visual-required');
  assert.equal(effective.settings.evidence.retentionDays, 30);
  assert.equal(effective.settings.cleanup.retentionDays, 30);
  assert.equal(effective.settings.cleanup.dryRunDefault, false);
  assert.equal(effective.settings.notifications.browser, true);
  assert.equal(effective.settings.privateAccess.preferredMode, 'local');
  assert.equal(effective.settings.urlOpening.defaultMode, 'in-app');
  assert.deepEqual(
    effective.sourcesApplied.map((source) => `${source.scope}:${source.source}`),
    [
      'global:defaults',
      'project:settingsOverrides',
      'session:fields',
      'session:settingsOverrides',
      'lane:fields',
      'lane:settingsOverrides',
      'action:oneTimeOverride',
    ],
  );
});

test('settings override sanitizer rejects unknown and prototype-polluting fields', () => {
  assert.equal(sanitizeSettingsOverrides({ privateAccess: { preferredMode: 'auto' } }).privateAccess.preferredMode, 'auto');
  assert.throws(
    () => sanitizeSettingsOverrides({ provider: { apiKey: 'secret-value' } }),
    (error) => error.status === 422 && /not supported/.test(error.message),
  );
  assert.throws(
    () => sanitizeSettingsOverrides(JSON.parse('{"__proto__":{"polluted":true}}')),
    (error) => error.status === 422 && /prototype-pollution/.test(error.message),
  );
  assert.throws(
    () => sanitizeSettingsOverrides({ privateAccess: { preferredMode: 'funnel' } }),
    (error) => error.status === 422 && /must be one of/.test(error.message),
  );
});

test('registry persists scoped settings overrides and audits updates', async () => {
  await withTempRegistry(async (registry) => {
    const project = registry.createProject({
      name: 'Effective Settings Project',
      settingsOverrides: {
        privateAccess: { preferredMode: 'local' },
      },
    }, { approved: true });
    const session = registry.createSession(project.id, {
      name: 'Effective Settings Session',
      approvedCapacity: 6,
      settingsOverrides: {
        notifications: { browser: true },
      },
    }, { approved: true });
    const lane = registry.createLane(session.id, {
      title: 'Effective Settings Lane',
      executorType: 'mock',
      targetUrl: 'http://127.0.0.1:4173',
      settingsOverrides: {
        urlOpening: { defaultMode: 'in-app' },
      },
    }, { approved: true });

    const laneEffective = registry.getEffectiveSettings({ laneId: lane.id });
    assert.equal(laneEffective.scope.projectId, project.id);
    assert.equal(laneEffective.scope.sessionId, session.id);
    assert.equal(laneEffective.scope.laneId, lane.id);
    assert.equal(laneEffective.settings.spawn.approvedCapacity, 6);
    assert.equal(laneEffective.settings.notifications.browser, true);
    assert.equal(laneEffective.settings.privateAccess.preferredMode, 'local');
    assert.equal(laneEffective.settings.urlOpening.defaultMode, 'in-app');

    assert.throws(
      () => registry.updateSettingsOverrides({
        scope: 'session',
        locator: session.id,
        settingsOverrides: { spawn: { spawnPolicy: 'auto' } },
        actor: 'dashboard',
        approved: false,
      }),
      (error) => error.status === 409 && /requires explicit approval/.test(error.message),
    );

    const updated = registry.updateSettingsOverrides({
      scope: 'session',
      locator: session.id,
      settingsOverrides: {
        spawn: {
          spawnPolicy: 'auto',
          approvedCapacity: 7,
        },
      },
      actor: 'dashboard',
      approved: true,
    });
    assert.equal(updated.settings.spawn.spawnPolicy, 'auto');
    assert.equal(updated.settings.spawn.approvedCapacity, 7);
    assert.equal(registry.auditEvents.some((event) => event.type === 'settings_overrides_updated'), true);
  });
});
