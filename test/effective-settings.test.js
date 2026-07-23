import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import { buildEffectiveSettings } from '../src/effective-settings/resolve.js';
import { sanitizeSettingsOverrides } from '../src/effective-settings/schema.js';

async function withTempRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-effective-settings-'));
  let registry = null;
  process.chdir(tempDir);
  try {
    registry = new OrcaRegistry();
    await callback(registry);
  } finally {
    // drainPendingWrites() stops the scheduler loop, awaits its in-flight tick,
    // and flushes+awaits every pending fs write BEFORE we rm the temp dir — so no
    // persist write is still in flight at process exit (the teardown-crash class).
    if (registry && typeof registry.drainPendingWrites === 'function') {
      await registry.drainPendingWrites();
    }
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

// The resolved settings surface is intentionally flow-only: the agent-flow engine
// (registry-audit.js -> getLaneFlowConfig) is the sole runtime reader.
test('effective settings expose the flow-engine defaults without secrets', () => {
  const effective = buildEffectiveSettings();

  assert.equal(effective.contractVersion, 'orca.effective-settings.v1');
  assert.deepEqual(Object.keys(effective.settings), ['flow']);
  assert.equal(effective.settings.flow.template, 'orchestrator-executor');
  assert.equal(effective.settings.flow.auditTier, 'orchestrator');
  assert.equal(effective.settings.flow.fixRouting, 'same-agent');
  assert.equal(effective.settings.flow.maxAuditLoops, 2);
  assert.equal(effective.settings.flow.requireAuditPass, true);
  assert.equal(JSON.stringify(effective).includes('apiKey'), false);
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

  // Recognized flow fields with bad VALUES are still hard-rejected by the sanitizer.
  assert.throws(() => sanitizeSettingsOverrides({ flow: { template: 'nonsense' } }), (e) => e.status === 422);
  assert.throws(() => sanitizeSettingsOverrides({ flow: { maxAuditLoops: 99 } }), (e) => e.status === 422);
});

test('effective settings precedence applies project, session, lane, and action overrides', () => {
  const effective = buildEffectiveSettings({
    project: {
      id: 'project-1',
      slug: 'project-1',
      settingsOverrides: {
        flow: { template: 'orchestrator-executor-audit', maxAuditLoops: 1 },
        // Non-flow legacy group is carried on the record but dropped on resolve.
        privateAccess: { preferredMode: 'local' },
      },
    },
    session: {
      id: 'session-1',
      projectId: 'project-1',
      settingsOverrides: {
        flow: { auditTier: 'separate-auditor' },
      },
    },
    lane: {
      id: 'lane-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      settingsOverrides: {
        flow: { fixRouting: 'new-agent' },
      },
    },
    actionOverride: {
      flow: { maxAuditLoops: 5 },
    },
  });

  assert.deepEqual(Object.keys(effective.settings), ['flow']);
  assert.equal(effective.settings.flow.template, 'orchestrator-executor-audit');
  assert.equal(effective.settings.flow.auditTier, 'separate-auditor');
  assert.equal(effective.settings.flow.fixRouting, 'new-agent');
  // action override wins over the project's maxAuditLoops.
  assert.equal(effective.settings.flow.maxAuditLoops, 5);
  assert.deepEqual(
    effective.sourcesApplied.map((source) => `${source.scope}:${source.source}`),
    [
      'global:defaults',
      'project:settingsOverrides',
      'session:settingsOverrides',
      'lane:settingsOverrides',
      'action:oneTimeOverride',
    ],
  );
});

test('settings override sanitizer drops unknown groups and blocks prototype pollution', () => {
  // Unknown (non-flow) groups degrade gracefully to "no override" — accepted-and-ignored.
  assert.deepEqual(sanitizeSettingsOverrides({ privateAccess: { preferredMode: 'auto' } }), {});
  // Unknown keys within the known flow group are dropped, valid siblings survive.
  assert.deepEqual(
    sanitizeSettingsOverrides({ flow: { template: 'orchestrator-only', apiKey: 'secret-value' } }),
    { flow: { template: 'orchestrator-only' } },
  );
  // Prototype-pollution keys still HARD-fail (security is not relaxed).
  assert.throws(
    () => sanitizeSettingsOverrides(JSON.parse('{"__proto__":{"polluted":true}}')),
    (error) => error.status === 422 && /prototype-pollution/.test(error.message),
  );
  // Bad enum values on a recognized flow field still 422.
  assert.throws(
    () => sanitizeSettingsOverrides({ flow: { auditTier: 'nope' } }),
    (error) => error.status === 422 && /must be one of/.test(error.message),
  );
});

// v2 orchestrator-native container: registerOrchestrator creates the project keyed
// by cwd and returns the orc_ container id. Lanes hang off the orchestrator via the
// getSession() seam (lane.sessionId === orchestrator.id).
async function makeOrchestrator(registry, { actor = 'test', title = 'Orch' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
}

// The entanglement guard: createProject/createLane still ACCEPT a settingsOverrides
// input after the schema was reduced to flow-only. Non-flow groups are dropped
// (never throw); a flow override is retained on the record and resolves through.
test('createProject and createLane accept overrides, dropping non-flow groups', async () => {
  await withTempRegistry(async (registry) => {
    // createProject with a mixed override must not throw; only flow survives.
    const project = registry.createProject(
      {
        name: 'Flow Project',
        slug: 'flow-project',
        settingsOverrides: {
          flow: { template: 'orchestrator-executor-audit' },
          spawn: { spawnPolicy: 'auto' }, // legacy non-flow group -> dropped
        },
      },
      { actor: 'test', approved: true },
    );
    assert.deepEqual(project.settingsOverrides, { flow: { template: 'orchestrator-executor-audit' } });

    // createLane with a mixed override must not throw; only flow survives, and it
    // resolves through the layered effective-settings.
    const { orchestrator } = await makeOrchestrator(registry);
    const lane = registry.createLane(
      orchestrator.id,
      {
        title: 'Flow Lane',
        executorType: 'mock',
        settingsOverrides: {
          flow: { maxAuditLoops: 4, fixRouting: 'new-agent' },
          urlOpening: { defaultMode: 'in-app' }, // legacy non-flow group -> dropped
        },
      },
      { approved: true },
    );
    assert.deepEqual(lane.settingsOverrides, { flow: { maxAuditLoops: 4, fixRouting: 'new-agent' } });

    const laneEffective = registry.getEffectiveSettings({ laneId: lane.id });
    assert.equal(laneEffective.scope.laneId, lane.id);
    assert.deepEqual(Object.keys(laneEffective.settings), ['flow']);
    assert.equal(laneEffective.settings.flow.maxAuditLoops, 4);
    assert.equal(laneEffective.settings.flow.fixRouting, 'new-agent');
    // And getLaneFlowConfig (the sole runtime reader) sees the resolved value.
    assert.equal(registry.getLaneFlowConfig(lane).maxAuditLoops, 4);
  });
});
