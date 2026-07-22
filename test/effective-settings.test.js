import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import {
  buildEffectiveSettings,
  sanitizeSettingsOverrides,
} from '../src/effective-settings.js';

async function withTempRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-effective-settings-'));
  let registry = null;
  process.chdir(tempDir);
  try {
    registry = new OrcaRegistry();
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

  assert.equal(effective.contractVersion, 'orca.effective-settings.v1');
  assert.equal(effective.settings.spawn.spawnPolicy, 'within_capacity');
  assert.equal(effective.settings.spawn.approvedCapacity, 2);
  assert.equal(effective.settings.spawn.soloMode, true);
  assert.equal(effective.settings.spawn.idleShutdownMode, 'immediate');
  assert.equal(effective.settings.spawn.worktreeMode, 'auto');
  assert.equal(effective.settings.critique.mode, 'suggested');
  assert.equal(effective.settings.critique.visualBrowserMode, 'visual-required');
  assert.equal(effective.settings.provider.secretPriority[0], 'os-credential');
  assert.equal(effective.settings.privateAccess.preferredMode, 'auto');
  assert.equal(effective.settings.privateAccess.funnelAllowed, false);
  assert.equal(effective.settings.urlOpening.defaultMode, 'external');
  assert.equal(effective.settings.mobile.pwaStaticCacheOnly, true);
  assert.equal(JSON.stringify(effective).includes('apiKey'), false);
  // Agent-flow engine defaults.
  assert.equal(effective.settings.flow.template, 'orchestrator-executor');
  assert.equal(effective.settings.flow.auditTier, 'orchestrator');
  assert.equal(effective.settings.flow.fixRouting, 'same-agent');
  assert.equal(effective.settings.flow.maxAuditLoops, 2);
  assert.equal(effective.settings.flow.requireAuditPass, true);
});

test('agent-flow settings layer and validate per scope', () => {
  const effective = buildEffectiveSettings({
    session: {
      id: 's1',
      settingsOverrides: { flow: { template: 'orchestrator-executor-audit', auditTier: 'separate-auditor', requireAuditPass: true } },
    },
    lane: {
      id: 'l1',
      sessionId: 's1',
      settingsOverrides: { flow: { fixRouting: 'new-agent', maxAuditLoops: 4 } },
    },
  });
  assert.equal(effective.settings.flow.template, 'orchestrator-executor-audit');
  assert.equal(effective.settings.flow.auditTier, 'separate-auditor');
  assert.equal(effective.settings.flow.requireAuditPass, true);
  assert.equal(effective.settings.flow.fixRouting, 'new-agent');
  assert.equal(effective.settings.flow.maxAuditLoops, 4);

  // Invalid flow values are rejected by the sanitizer.
  assert.throws(() => sanitizeSettingsOverrides({ flow: { template: 'nonsense' } }), (e) => e.status === 422);
  assert.throws(() => sanitizeSettingsOverrides({ flow: { maxAuditLoops: 99 } }), (e) => e.status === 422);
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
      worktreeMode: 'shared',
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
  assert.equal(effective.settings.spawn.worktreeMode, 'shared');
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

// v2 orchestrator-native container: registerOrchestrator creates the project
// keyed by cwd and returns the orc_ container id. The "session" scope of the
// effective-settings stack now maps to that orchestrator container via the
// getSession() seam (lane.sessionId === orchestrator.id).
async function makeOrchestrator(registry, { actor = 'test', title = 'Orch' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
}

// PORTED from the Model-A session-scoped version. In v3 the orchestrator RECORD
// is the container: its spawn capacity is set through updateOrchestrator (the seam
// then feeds it into the "session:fields" layer), and durable settingsOverrides
// live at project + lane scope. Arbitrary session-scoped settingsOverrides have no
// backing record on the ephemeral container seam, so the container-level override
// (privateAccess + notifications) is asserted at PROJECT scope — the durable
// container scope in v3 — while the update/audit path is exercised there too.
test('registry persists scoped settings overrides and audits updates', async () => {
  await withTempRegistry(async (registry) => {
    const { orchestrator, lease } = await makeOrchestrator(registry);
    const projectId = orchestrator.projectId;

    // Container-level (project) overrides are durable on the project record.
    registry.updateSettingsOverrides({
      scope: 'project',
      locator: projectId,
      settingsOverrides: {
        privateAccess: { preferredMode: 'local' },
        notifications: { browser: true },
      },
      actor: 'dashboard',
      approved: true,
    });

    // Container capacity now lives on the orchestrator record; the seam feeds it
    // into the effective-settings "session:fields" layer.
    registry.updateOrchestrator(orchestrator.id, { approvedCapacity: 6 }, { leaseId: lease.id });

    const lane = registry.createLane(orchestrator.id, {
      title: 'Effective Settings Lane',
      executorType: 'mock',
      targetUrl: 'http://127.0.0.1:4173',
      settingsOverrides: {
        urlOpening: { defaultMode: 'in-app' },
      },
    }, { approved: true });

    const laneEffective = registry.getEffectiveSettings({ laneId: lane.id });
    assert.equal(laneEffective.scope.projectId, projectId);
    assert.equal(laneEffective.scope.sessionId, orchestrator.id);
    assert.equal(laneEffective.scope.laneId, lane.id);
    assert.equal(laneEffective.settings.spawn.approvedCapacity, 6);
    assert.equal(laneEffective.settings.notifications.browser, true);
    assert.equal(laneEffective.settings.privateAccess.preferredMode, 'local');
    assert.equal(laneEffective.settings.urlOpening.defaultMode, 'in-app');

    assert.throws(
      () => registry.updateSettingsOverrides({
        scope: 'project',
        locator: projectId,
        settingsOverrides: { spawn: { spawnPolicy: 'auto' } },
        actor: 'dashboard',
        approved: false,
      }),
      (error) => error.status === 409 && /requires explicit approval/.test(error.message),
    );

    const updated = registry.updateSettingsOverrides({
      scope: 'project',
      locator: projectId,
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
