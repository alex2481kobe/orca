import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandDeckRegistry } from '../src/registry.js';

async function withIsolatedRegistry() {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-registry-test-'));
  process.chdir(tempDir);

  const registry = new CommandDeckRegistry();
  const cleanup = async () => {
    registry.stopScheduler();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { force: true, recursive: true });
  };

  return { registry, cleanup, tempDir };
}

function restoreEnv(previous) {
  const snapshot = { ...previous };
  return () => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in snapshot)) {
        delete process.env[key];
      }
    });
    Object.entries(snapshot).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  };
}

test('cleanup schedule and cleanup artifacts use retention + approval', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    assert.equal(registry.getCleanupSchedule().enabled, false);
    assert.throws(() => registry.updateCleanupSchedule({ enabled: true, intervalHours: 999 }, { approved: true }), (error) => error.status === 422);

    const updated = registry.updateCleanupSchedule({
      enabled: true,
      intervalHours: 12,
      olderThanDays: 7,
      sessionId: null,
      dryRun: true,
    }, { approved: true });
    assert.equal(updated.enabled, true);
    assert.equal(updated.intervalHours, 12);
    assert.equal(updated.olderThanDays, 7);

    const project = registry.createProject({ name: 'Cleanup Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Cleanup Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'old lane',
      executorType: 'mock',
    }, { approved: true, actor: 'test' });

    const target = registry.getLane(lane.id);
    target.state = 'done';
    target.completedAt = new Date(Date.now() - (12 * 24 * 60 * 60 * 1000)).toISOString();
    target.updatedAt = target.completedAt;

    const artifactDir = path.join(process.cwd(), 'artifacts', session.id, target.id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'evidence-test.log'), 'hello');

    const dryRunSummary = await registry.cleanupArtifacts({
      actor: 'test',
      approved: true,
      dryRun: true,
      sessionId: session.id,
      olderThanDays: 10,
    });
    assert.equal(dryRunSummary.dryRun, true);
    assert.equal(dryRunSummary.candidates, 1);
    assert.equal(dryRunSummary.removed, 0);

    const deleteSummary = await registry.cleanupArtifacts({
      actor: 'test',
      approved: true,
      sessionId: session.id,
      olderThanDays: 10,
      dryRun: false,
      confirmed: true,
    });
    assert.equal(deleteSummary.removed, 1);

    await assert.rejects(
      fs.access(path.join(artifactDir, 'evidence-test.log')),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    await cleanup();
  }
});

test('project and session mutations require policy approval', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    assert.throws(
      () => registry.createProject({ name: 'Unapproved Project' }),
      (error) => error.status === 409,
    );

    const project = registry.createProject({ name: 'Project with approval' }, { actor: 'test', approved: true });
    assert.equal(project.name, 'Project with approval');

    assert.throws(
      () => registry.createSession(project.id, { name: 'Unapproved Session' }),
      (error) => error.status === 409,
    );

    const session = registry.createSession(project.id, { name: 'Approved Session' }, { actor: 'test', approved: true });
    assert.equal(session.name, 'Approved Session');

    assert.throws(
      () => registry.updateProject(project.id, { name: 'No approval update' }),
      (error) => error.status === 409,
    );

    const renamed = registry.updateProject(project.id, { name: 'Renamed Project' }, { actor: 'test', approved: true });
    assert.equal(renamed.name, 'Renamed Project');
  } finally {
    await cleanup();
  }
});

test('scheduled cleanup tick runs artifacts cleanup when run-at is due', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Scheduled Cleanup Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Scheduled Cleanup Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'stale lane',
      executorType: 'mock',
    }, { approved: true, actor: 'test' });

    const target = registry.getLane(lane.id);
    target.state = 'done';
    target.completedAt = new Date(Date.now() - (10 * 24 * 60 * 60 * 1000)).toISOString();
    target.updatedAt = target.completedAt;

    const artifactDir = path.join(process.cwd(), 'artifacts', session.id, target.id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'evidence-test.log'), 'hello');

    const schedule = registry.updateCleanupSchedule({
      enabled: true,
      intervalHours: 0.001,
      olderThanDays: 1,
      sessionId: session.id,
      dryRun: false,
    }, { actor: 'test', approved: true });
    assert.equal(schedule.enabled, true);

    registry.cleanupSchedule.nextRunAt = new Date(Date.now() - 1000).toISOString();

    await registry.runCleanupSchedulerTick();

    await assert.rejects(
      fs.access(artifactDir),
      (error) => error.code === 'ENOENT',
    );

    const updatedSchedule = registry.getCleanupSchedule();
    assert.equal(updatedSchedule.lastRunAt !== null, true);
    assert.equal(updatedSchedule.nextRunAt !== schedule.nextRunAt, true);
  } finally {
    await cleanup();
  }
});

test('scheduled cleanup tick waits until next run time', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Scheduled Cleanup Holdoff Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Scheduled Cleanup Holdoff Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'stale lane',
      executorType: 'mock',
    }, { approved: true, actor: 'test' });

    const target = registry.getLane(lane.id);
    target.state = 'done';
    target.completedAt = new Date(Date.now() - (10 * 24 * 60 * 60 * 1000)).toISOString();
    target.updatedAt = target.completedAt;

    const artifactDir = path.join(process.cwd(), 'artifacts', session.id, target.id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'evidence-test.log'), 'hello');

    const schedule = registry.updateCleanupSchedule({
      enabled: true,
      intervalHours: 4,
      olderThanDays: 1,
      sessionId: session.id,
      dryRun: false,
    }, { actor: 'test', approved: true });

    registry.cleanupSchedule.nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await registry.runCleanupSchedulerTick();

    const stillThere = await fs.readdir(artifactDir);
    assert.equal(stillThere.length, 1);
    assert.equal(schedule.lastRunAt, null);
  } finally {
    await cleanup();
  }
});

test('cleanup artifacts and cleanup schedule require approval for manual invocation', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    await assert.rejects(
      () => registry.cleanupArtifacts({
        actor: 'dashboard',
        approved: false,
        dryRun: true,
        sessionId: null,
      }),
      (error) => error.status === 409,
    );

    await assert.rejects(
      () => registry.updateCleanupSchedule({
        enabled: true,
        intervalHours: 24,
        olderThanDays: 7,
      }, { actor: 'dashboard', approved: false }),
      (error) => error.status === 409,
    );

    const schedulerResult = await registry.cleanupArtifacts({
      actor: 'scheduler',
      skipApproval: true,
      dryRun: true,
      sessionId: null,
      olderThanDays: 7,
    });
    assert.equal(schedulerResult.dryRun, true);
    assert.equal(schedulerResult.removed, 0);
  } finally {
    await cleanup();
  }
});

test('cleanup artifacts require explicit confirmation for destructive cleanup', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Cleanup Confirmation Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Cleanup Confirmation Session' }, { actor: 'test', approved: true });

    const lane = registry.createLane(session.id, {
      title: 'old lane',
      executorType: 'mock',
    }, { approved: true, actor: 'test' });

    const target = registry.getLane(lane.id);
    target.state = 'done';
    target.completedAt = new Date(Date.now() - (12 * 24 * 60 * 60 * 1000)).toISOString();
    target.updatedAt = target.completedAt;

    const artifactDir = path.join(process.cwd(), 'artifacts', session.id, target.id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'evidence-test.log'), 'hello');

    await assert.rejects(
      () => registry.cleanupArtifacts({
        actor: 'test',
        approved: true,
        dryRun: false,
        sessionId: session.id,
        olderThanDays: 10,
      }),
      (error) => error.status === 409,
    );

    const dryRunSummary = await registry.cleanupArtifacts({
      actor: 'test',
      approved: true,
      dryRun: true,
      sessionId: session.id,
      olderThanDays: 10,
    });
    assert.equal(dryRunSummary.removed, 0);

    const deleteSummary = await registry.cleanupArtifacts({
      actor: 'test',
      approved: true,
      dryRun: false,
      confirmed: true,
      sessionId: session.id,
      olderThanDays: 10,
    });
    assert.equal(deleteSummary.removed, 1);
    await assert.rejects(
      fs.access(path.join(artifactDir, 'evidence-test.log')),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    await cleanup();
  }
});

test('cleanup default retention comes from session policy when olderThanDays is omitted', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Retention Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Retention Session',
      artifactRetentionDays: 5,
    }, { actor: 'test', approved: true });

    const lane = registry.createLane(session.id, {
      title: 'old lane',
      executorType: 'mock',
    }, { approved: true, actor: 'test' });

    const target = registry.getLane(lane.id);
    target.state = 'done';
    target.completedAt = new Date(Date.now() - (6 * 24 * 60 * 60 * 1000)).toISOString();
    target.updatedAt = target.completedAt;

    const artifactDir = path.join(process.cwd(), 'artifacts', session.id, target.id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'old.txt'), 'retention-check');

    const summaryDefaultRetention = await registry.cleanupArtifacts({
      actor: 'test',
      approved: true,
      sessionId: session.id,
      confirmed: true,
    });
    assert.equal(summaryDefaultRetention.removed, 1);
    await assert.rejects(
      fs.access(path.join(artifactDir, 'old.txt')),
      (error) => error.code === 'ENOENT',
    );

    const keptLane = registry.createLane(session.id, {
      title: 'newer lane',
      executorType: 'mock',
    }, { approved: true, actor: 'test' });
    const keptTarget = registry.getLane(keptLane.id);
    keptTarget.state = 'done';
    keptTarget.completedAt = new Date().toISOString();
    keptTarget.updatedAt = keptTarget.completedAt;
    const keptDir = path.join(process.cwd(), 'artifacts', session.id, keptTarget.id);
    await fs.mkdir(keptDir, { recursive: true });
    await fs.writeFile(path.join(keptDir, 'recent.txt'), 'recent');

    const summaryOverride = await registry.cleanupArtifacts({
      actor: 'test',
      approved: true,
      sessionId: session.id,
      olderThanDays: 30,
      confirmed: true,
    });
    assert.equal(summaryOverride.removed, 0);
    const keptFileText = await fs.readFile(path.join(keptDir, 'recent.txt'), 'utf8');
    assert.equal(keptFileText, 'recent');
  } finally {
    await cleanup();
  }
});

test('MCP tools are scoped by executor type', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'MCP Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'MCP Session' }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'all-tool',
      command: 'node',
      args: ['--version'],
      scope: ['all'],
      enabled: true,
    }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'codex-tool',
      command: 'node',
      args: ['--version'],
      scope: ['codex'],
      enabled: true,
    }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'claude-tool',
      command: 'node',
      args: ['--version'],
      scope: ['claude'],
      enabled: true,
    }, { actor: 'test', approved: true });

    await assert.rejects(() => registry.createLane(session.id, {
      title: 'Codex Lane',
      executorType: 'codex',
      mcpToolIds: ['all-tool', 'codex-tool', 'claude-tool'],
    }, { actor: 'test', approved: true }), (error) => error.status === 422);

    await assert.rejects(() => registry.createLane(session.id, {
      title: 'Claude Lane',
      executorType: 'claude',
      mcpToolIds: ['all-tool', 'codex-tool', 'claude-tool'],
    }, { actor: 'test', approved: true }), (error) => error.status === 422);

    const codexLane = await registry.createLane(session.id, {
      title: 'Codex Lane',
      executorType: 'codex',
      mcpToolIds: ['all-tool', 'codex-tool'],
    }, { actor: 'test', approved: true });

    const claudeLane = await registry.createLane(session.id, {
      title: 'Claude Lane',
      executorType: 'claude',
      mcpToolIds: ['all-tool', 'claude-tool'],
    }, { actor: 'test', approved: true });

    const mockLane = await registry.createLane(session.id, {
      title: 'Mock Lane',
      executorType: 'mock',
      mcpToolIds: ['all-tool'],
    }, { actor: 'test', approved: true });

    const codexToolNames = new Set((codexLane.mcpTools || []).map((item) => item.name));
    const claudeToolNames = new Set((claudeLane.mcpTools || []).map((item) => item.name));
    const mockToolNames = new Set((mockLane.mcpTools || []).map((item) => item.name));

    assert.ok(codexToolNames.has('all-tool'));
    assert.ok(codexToolNames.has('codex-tool'));
    assert.ok(!codexToolNames.has('claude-tool'));

    assert.ok(claudeToolNames.has('all-tool'));
    assert.ok(claudeToolNames.has('claude-tool'));
    assert.ok(!claudeToolNames.has('codex-tool'));

    assert.deepEqual([...mockToolNames], ['all-tool']);
  } finally {
    await cleanup();
  }
});

test('MCP tools can be queried by scope', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    await registry.createMcpTool({
      name: 'all-tool',
      command: 'node',
      args: ['--version'],
      scope: ['all'],
      enabled: true,
    }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'codex-tool',
      command: 'node',
      args: ['--version'],
      scope: ['codex'],
      enabled: true,
    }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'claude-tool',
      command: 'node',
      args: ['--version'],
      scope: ['claude'],
      enabled: true,
    }, { actor: 'test', approved: true });

    const allTools = registry.getMcpTools();
    const codexTools = registry.getMcpTools('codex');
    const claudeTools = registry.getMcpTools('claude');

    assert.equal(allTools.length, 3);
    assert.equal(codexTools.length, 2);
    assert.equal(claudeTools.length, 2);
    assert.ok(codexTools.every((tool) => tool.scope.includes('all') || tool.scope.includes('codex')));
    assert.ok(claudeTools.every((tool) => tool.scope.includes('all') || tool.scope.includes('claude')));
  } finally {
    await cleanup();
  }
});

test('Deleting an MCP tool detaches it from existing lane snapshots', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'MCP Snapshot Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'MCP Snapshot Session' }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'transient-tool',
      command: 'node',
      args: ['--version'],
      scope: ['all'],
      enabled: true,
    }, { actor: 'test', approved: true });

    const transientLane = await registry.createLane(session.id, {
      title: 'Transient Lane',
      executorType: 'mock',
      mcpToolIds: ['transient-tool'],
    }, { actor: 'test', approved: true });

    assert.equal(transientLane.mcpTools.length, 1);

    await registry.deleteMcpTool('transient-tool', { actor: 'test', approved: true });
    const refreshedLane = registry.getLane(transientLane.id);
    assert.equal(refreshedLane.mcpTools.length, 0);
  } finally {
    await cleanup();
  }
});

test('MCP tools can be updated when approved and require approval otherwise', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    await registry.createMcpTool({
      name: 'editable-tool',
      command: 'node',
      args: ['--version'],
      scope: ['all'],
      enabled: true,
    }, { actor: 'test', approved: true });

    const updated = await registry.updateMcpTool('editable-tool', {
      command: 'npx',
      args: ['foo'],
      scope: ['codex'],
      notes: 'updated via test',
      enabled: false,
    }, { actor: 'test', approved: true });

    assert.equal(updated.command, 'npx');
    assert.deepEqual(updated.args, ['foo']);
    assert.deepEqual(updated.scope, ['codex']);
    assert.equal(updated.notes, 'updated via test');
    assert.equal(updated.enabled, false);

    assert.throws(() => registry.updateMcpTool('editable-tool', {
      command: 'npm',
    }, { actor: 'test', approved: false }), (error) => error.status === 409);
  } finally {
    await cleanup();
  }
});

test('MCP tool validation rejects invalid names and command payloads', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    assert.throws(() => registry.createMcpTool({
        name: 'invalid name',
        command: 'node',
        scope: ['all'],
        enabled: true,
      }, {
        actor: 'test',
        approved: true,
      }), (error) => error.status === 422);

    await registry.createMcpTool({
      name: 'valid-tool',
      command: 'node',
      args: ['--version'],
      scope: ['all'],
      enabled: true,
    }, {
      actor: 'test',
      approved: true,
    });

    assert.throws(() => registry.updateMcpTool('valid-tool', {
        command: 'node || echo boom',
      }, {
        actor: 'test',
        approved: true,
      }), (error) => error.status === 422);

    assert.throws(() => registry.updateMcpTool('valid-tool', {
      scope: ['not-real'],
    }, {
      actor: 'test',
      approved: true,
    }), (error) => error.status === 422);
  } finally {
    await cleanup();
  }
});

test('MCP tool arguments are validated for command safety and length', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  const longArg = 'x'.repeat(300);

  try {
    assert.throws(() => registry.createMcpTool({
      name: 'bad-arg-tool',
      command: 'node',
      args: ['--version', 'foo|bar'],
      scope: ['all'],
      enabled: true,
    }, {
      actor: 'test',
      approved: true,
    }), (error) => error.status === 422);

    await registry.createMcpTool({
      name: 'valid-arg-tool',
      command: 'node',
      args: ['--version'],
      scope: ['all'],
      enabled: true,
    }, {
      actor: 'test',
      approved: true,
    });

    assert.throws(() => registry.updateMcpTool('valid-arg-tool', {
      args: [longArg],
    }, {
      actor: 'test',
      approved: true,
    }), (error) => error.status === 422);
  } finally {
    await cleanup();
  }
});

test('MCP tool validation enforces scope allowlist and single-token command', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    assert.throws(() => registry.createMcpTool({
      name: 'space-command-tool',
      command: 'node script.js',
      scope: ['codex'],
      enabled: true,
    }, {
      actor: 'test',
      approved: true,
    }), (error) => error.status === 422);

    assert.throws(() => registry.createMcpTool({
      name: 'invalid-scope-tool',
      command: 'node',
      scope: ['not-real'],
      enabled: true,
    }, {
      actor: 'test',
      approved: true,
    }), (error) => error.status === 422);

    const created = await registry.createMcpTool({
      name: 'scoped-tool',
      command: 'node',
      scope: ['codex', 'all'],
      enabled: true,
    }, {
      actor: 'test',
      approved: true,
    });
    assert.deepEqual(created.scope.sort(), ['all', 'codex']);
  } finally {
    await cleanup();
  }
});

test('Creating lanes rejects unknown or unauthorized MCP tool IDs', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Lane MCP Policy Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Lane MCP Policy Session' }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'scoped-codex-tool',
      command: 'node',
      scope: ['codex'],
      enabled: true,
      args: ['-v'],
    }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'scoped-claude-tool',
      command: 'node',
      scope: ['claude'],
      enabled: true,
      args: ['-v'],
    }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'disabled-claude-tool',
      command: 'node',
      scope: ['claude'],
      enabled: false,
      args: ['-v'],
    }, { actor: 'test', approved: true });

    assert.throws(() => registry.createLane(session.id, {
      title: 'Unknown MCP tool',
      executorType: 'codex',
      executorBinary: '/usr/bin/codex',
      mcpToolIds: ['ghost-tool'],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Disallowed MCP tool',
      executorType: 'codex',
      executorBinary: '/usr/bin/codex',
      mcpToolIds: ['scoped-claude-tool'],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Disabled MCP tool',
      executorType: 'codex',
      executorBinary: '/usr/bin/codex',
      mcpToolIds: ['disabled-claude-tool'],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Scope mismatch MCP tool',
      executorType: 'codex',
      executorBinary: '/usr/bin/codex',
      mcpToolIds: ['scoped-claude-tool'],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    const codexLane = await registry.createLane(session.id, {
      title: 'Valid codex with scoped tool',
      executorType: 'codex',
      executorBinary: '/usr/bin/codex',
      mcpToolIds: ['scoped-codex-tool'],
    }, { approved: true, actor: 'test' });
    assert.equal(codexLane.mcpTools.length, 1);
    assert.equal(codexLane.mcpTools[0].id, 'scoped-codex-tool');
  } finally {
    await cleanup();
  }
});

test('MCP tool command allowlist can be enforced via env override', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST: process.env.COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST,
  });

  try {
    process.env.COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST = 'node,python';
    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      assert.throws(() => registry.createMcpTool({
        name: 'blocked-tool',
        command: 'bun',
        scope: ['all'],
        enabled: true,
      }, {
        actor: 'test',
        approved: true,
      }), (error) => error.status === 422);

      const allowed = await registry.createMcpTool({
        name: 'allowed-tool',
        command: 'python',
        scope: ['all'],
        enabled: true,
      }, {
        actor: 'test',
        approved: true,
      });
      assert.equal(allowed.command, 'python');
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('Codex and Claude lanes accept executor overrides and command payloads', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Executor Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Executor Session',
      leader: 'codex',
    }, { actor: 'test', approved: true });

    const codexLane = registry.createLane(session.id, {
      title: 'Codex Lane',
      executorType: 'codex',
      command: 'codex --version',
      executorBinary: '/usr/bin/codex',
      workdir: process.cwd(),
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });

    const claudeLane = registry.createLane(session.id, {
      title: 'Claude Lane',
      executorType: 'claude',
      command: 'claude --version',
      executorBinary: '/usr/bin/claude',
      workdir: process.cwd(),
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });

    assert.equal(codexLane.executorType, 'codex');
    assert.equal(claudeLane.executorType, 'claude');
    assert.equal(codexLane.command, 'codex --version');
    assert.equal(claudeLane.command, 'claude --version');
  } finally {
    await cleanup();
  }
});

test('Codex and Claude lanes enforce binary/command executor targeting', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Executor Policy Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Executor Policy Session',
      leader: 'codex',
    }, { actor: 'test', approved: true });

    assert.throws(() => registry.createLane(session.id, {
      title: 'Invalid codex command',
      executorType: 'codex',
      command: 'claude --version',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Wrapper codex command',
      executorType: 'codex',
      command: 'env codex --version',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Invalid codex binary',
      executorType: 'codex',
      executorBinary: '/usr/bin/claude',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    const validLane = registry.createLane(session.id, {
      title: 'Valid codex override',
      executorType: 'codex',
      executorBinary: '/usr/local/bin/codex-runner',
      command: 'codex --help',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });
    assert.equal(validLane.executorType, 'codex');
    assert.equal(validLane.executorBinary, '/usr/local/bin/codex-runner');
  } finally {
    await cleanup();
  }
});

test('Creating lanes rejects unsupported executor types', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Executor Type Policy Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Executor Type Policy Session',
      leader: 'codex',
    }, { actor: 'test', approved: true });

    assert.throws(() => registry.createLane(session.id, {
      title: 'Unsupported executor',
      executorType: 'openai-orchestrator',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);
  } finally {
    await cleanup();
  }
});

test('Lane workdirs default to the session workspace and reject traversal outside session boundary', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Workspace Boundaries Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Workspace Boundaries Session',
      leader: 'codex',
    }, { actor: 'test', approved: true });
    const sessionRecord = registry.getSession(session.id);

    const workspaceStats = await fs.stat(sessionRecord.worktreeRoot);
    assert.equal(workspaceStats.isDirectory(), true);

    const defaultLane = registry.createLane(session.id, {
      title: 'Default workspace lane',
      executorType: 'codex',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });
    assert.equal(defaultLane.workdir, sessionRecord.worktreeRoot);
    const defaultStat = await fs.stat(defaultLane.workdir);
    assert.equal(defaultStat.isDirectory(), true);

    const relativeLane = registry.createLane(session.id, {
      title: 'Relative workspace lane',
      executorType: 'codex',
      workdir: 'feature-run',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });
    assert.equal(relativeLane.workdir, path.join(sessionRecord.worktreeRoot, 'feature-run'));
    const relativeStat = await fs.stat(relativeLane.workdir);
    assert.equal(relativeStat.isDirectory(), true);

    await assert.rejects(
      () => registry.createLane(session.id, {
        title: 'Escaping workspace lane',
        executorType: 'codex',
        workdir: '../outside',
        mcpToolIds: [],
      }, { approved: true, actor: 'test' }),
      (error) => error.status === 422,
    );
  } finally {
    await cleanup();
  }
});

test('Unknown executor adapters report unsupported errors', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const adapter = registry.getExecutorForType('orchestrator');
    const result = await adapter.start({ id: 'lane-unknown', projectId: 'p', sessionId: 's' });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'orchestrator executor is not supported.');
  } finally {
    await cleanup();
  }
});

test('executor CLI info and managed reinstall require approval', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CLAUDE_BINARY: process.env.COMMAND_DECK_CLAUDE_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CLAUDE_REINSTALL_COMMAND: process.env.COMMAND_DECK_CLAUDE_REINSTALL_COMMAND,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CLAUDE_BINARY = '/usr/bin/claude';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = '["npm","install","-g","--yes","codex-cli"]';
    process.env.COMMAND_DECK_CLAUDE_REINSTALL_COMMAND = '["npm","install","-g","--yes","claude-cli"]';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const profiles = registry.getExecutorProfiles();
      assert.equal(profiles.codex.defaultBinary, '/usr/bin/codex');
      assert.equal(profiles.claude.defaultBinary, '/usr/bin/claude');

      const codexInfo = registry.getExecutorCliInfo('codex');
      assert.equal(codexInfo.type, 'codex');
      assert.equal(codexInfo.binary, '/usr/bin/codex');
      assert.equal(codexInfo.reinstall.available, true);
      assert.equal(codexInfo.reinstall.command[0], 'npm');

      const dryRun = await registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
      });
      assert.equal(dryRun.executed, false);
      assert.equal(dryRun.command[0], 'npm');

      await assert.rejects(
        () => registry.runExecutorCliReinstall('codex', {
          actor: 'test',
          approved: false,
          execute: false,
        }),
        (error) => error.status === 409,
      );
    } finally {
    await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall execute mode requires confirmation', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CODEX_REINSTALL_PACKAGES: process.env.COMMAND_DECK_CODEX_REINSTALL_PACKAGES,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      await assert.rejects(
        () => registry.runExecutorCliReinstall('codex', {
          actor: 'test',
          approved: true,
          execute: true,
        }),
        (error) => error.status === 409,
      );

      const planned = await registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
      });
      assert.equal(planned.executed, false);
      assert.equal(planned.command[0], 'npm');
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall has secure official-package defaults when no override is provided', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CLAUDE_BINARY: process.env.COMMAND_DECK_CLAUDE_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CLAUDE_REINSTALL_COMMAND: process.env.COMMAND_DECK_CLAUDE_REINSTALL_COMMAND,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CLAUDE_BINARY = '/usr/bin/claude';
    delete process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND;
    delete process.env.COMMAND_DECK_CLAUDE_REINSTALL_COMMAND;

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const codexInfo = registry.getExecutorCliInfo('codex');
      const claudeInfo = registry.getExecutorCliInfo('claude');
      assert.equal(codexInfo.reinstall.available, true);
      assert.equal(codexInfo.reinstall.command.includes('npm'), true);
      assert.equal(codexInfo.reinstall.command.includes('@openai/codex'), true);
      assert.equal(claudeInfo.reinstall.available, true);
      assert.equal(claudeInfo.reinstall.command.includes('npm'), true);
      assert.equal(claudeInfo.reinstall.command.includes('@anthropic/claude-code'), true);
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall command validation is executor-specific and safe', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CLAUDE_BINARY: process.env.COMMAND_DECK_CLAUDE_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CLAUDE_REINSTALL_COMMAND: process.env.COMMAND_DECK_CLAUDE_REINSTALL_COMMAND,
    COMMAND_DECK_CODEX_REINSTALL_PACKAGES: process.env.COMMAND_DECK_CODEX_REINSTALL_PACKAGES,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CLAUDE_BINARY = '/usr/bin/claude';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const validInfo = registry.getExecutorCliInfo('codex');
      assert.equal(validInfo.reinstall.available, true);
      assert.equal(validInfo.reinstall.command[0], 'npm');

      const planned = await registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
      });
      assert.equal(planned.executed, false);
      assert.equal(planned.command[0], 'npm');
      assert.equal(planned.command.includes('codex-cli'), true);

      process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install codex-fake';
      const blocked = await withIsolatedRegistry();
      try {
        const blockedInfo = blocked.registry.getExecutorCliInfo('codex');
        assert.equal(blockedInfo.reinstall.available, false);
        await assert.rejects(
          () => blocked.registry.runExecutorCliReinstall('codex', {
            actor: 'test',
            approved: true,
            execute: false,
          }),
          (error) => error.status === 422,
        );
      } finally {
        await blocked.cleanup();
      }

      process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';
      const info = registry.getExecutorCliInfo('codex');
      assert.equal(info.reinstall.available, true);

      const plannedSecond = await registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
      });
      assert.equal(plannedSecond.executed, false);
      assert.equal(plannedSecond.command[0], 'npm');
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall package allowlist can be overridden per executor', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CODEX_REINSTALL_PACKAGES: process.env.COMMAND_DECK_CODEX_REINSTALL_PACKAGES,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const defaultInfo = registry.getExecutorCliInfo('codex');
      assert.equal(defaultInfo.reinstall.available, true);

      process.env.COMMAND_DECK_CODEX_REINSTALL_PACKAGES = '@openai/codex';
      const customBlocked = await withIsolatedRegistry();
      try {
        const customBlockedInfo = customBlocked.registry.getExecutorCliInfo('codex');
        assert.equal(customBlockedInfo.reinstall.available, false);
        await assert.rejects(
          () => customBlocked.registry.runExecutorCliReinstall('codex', {
            actor: 'test',
            approved: true,
            execute: false,
          }),
          (error) => error.status === 422,
        );
      } finally {
        await customBlocked.cleanup();
      }

      process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes @openai/codex';
      process.env.COMMAND_DECK_CODEX_REINSTALL_PACKAGES = '@openai/codex';
      const scopedAllowed = await withIsolatedRegistry();
      try {
        const scopedInfo = scopedAllowed.registry.getExecutorCliInfo('codex');
        assert.equal(scopedInfo.reinstall.available, true);
        const scopedPlan = await scopedAllowed.registry.runExecutorCliReinstall('codex', {
          actor: 'test',
          approved: true,
          execute: false,
        });
        assert.equal(scopedPlan.executed, false);
        assert.equal(scopedPlan.command.includes('@openai/codex'), true);
      } finally {
        await scopedAllowed.cleanup();
      }
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall rejects URL-based package spec spoofing', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CODEX_REINSTALL_PACKAGES: process.env.COMMAND_DECK_CODEX_REINSTALL_PACKAGES,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes https://example.com/@openai/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_PACKAGES = '@openai/codex';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const info = registry.getExecutorCliInfo('codex');
      assert.equal(info.reinstall.available, false);
      await assert.rejects(
        () => registry.runExecutorCliReinstall('codex', {
          actor: 'test',
          approved: true,
          execute: false,
        }),
        (error) => error.status === 422,
      );
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall supports safe override command profiles and manager verbs', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const defaultPlan = await registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
      });
      assert.equal(defaultPlan.command[0], 'npm');
    assert.equal(defaultPlan.command.includes('codex-cli'), true);

      const overridePlan = await registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
        command: 'pnpm add -g codex-cli',
      });
      assert.equal(overridePlan.command[0], 'pnpm');
      assert.equal(overridePlan.command.includes('codex-cli'), true);

      await assert.rejects(
        () => registry.runExecutorCliReinstall('codex', {
          actor: 'test',
          approved: true,
          execute: false,
          command: 'npm uninstall codex-cli',
        }),
        (error) => error.status === 422,
      );

      await assert.rejects(
        () => registry.runExecutorCliReinstall('codex', {
          actor: 'test',
          approved: true,
          execute: false,
          command: 'npm install lodash',
        }),
        (error) => error.status === 422,
      );
  } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall supports trusted source-based reinstall commands', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS: process.env.COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes git+https://github.com/openai/codex.git';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const plan = await registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
      });
      assert.equal(plan.executed, false);
      assert.equal((plan.command || []).join(' ').includes('git+https://github.com/openai/codex.git'), true);
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall rejects untrusted source-based reinstall commands', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS: process.env.COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes git+https://github.com/untrusted/source.git';
    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      await assert.rejects(
        () => registry.runExecutorCliReinstall('codex', {
          actor: 'test',
          approved: true,
          execute: false,
        }),
        (error) => error.status === 422,
      );
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall can use a configured source repo allowlist override', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS: process.env.COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS = 'my-org/codex-fork,openai/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes git+https://github.com/my-org/codex-fork.git';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const plan = await registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
      });
      assert.equal(plan.executed, false);
      assert.equal((plan.command || []).join(' ').includes('git+https://github.com/my-org/codex-fork.git'), true);
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test('executor CLI reinstall preference for source commands is respected and surfaced', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS: process.env.COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS,
    COMMAND_DECK_CODEX_REINSTALL_PREFER_SOURCE: process.env.COMMAND_DECK_CODEX_REINSTALL_PREFER_SOURCE,
  });

  try {
    process.env.COMMAND_DECK_CODEX_BINARY = '/usr/bin/codex';
    delete process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND;
    process.env.COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS = 'my-org/codex-fork,openai/codex';
    process.env.COMMAND_DECK_CODEX_REINSTALL_PREFER_SOURCE = 'true';

    const preferred = await withIsolatedRegistry();
    try {
      const preferredInfo = preferred.registry.getExecutorCliInfo('codex');
      assert.equal(preferredInfo.reinstall.preferSource, true);
      assert.equal(preferredInfo.reinstall.sourceRepos[0], 'my-org/codex-fork');
      assert.equal(
        (preferredInfo.reinstall.command || []).join(' ').includes('git+https://github.com/my-org/codex-fork.git'),
        true,
      );
      const preferredPlan = await preferred.registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
      });
      assert.equal(preferredPlan.executed, false);
      assert.equal(
        (preferredPlan.command || []).join(' ').includes('git+https://github.com/my-org/codex-fork.git'),
        true,
      );
    } finally {
      await preferred.cleanup();
    }

    process.env.COMMAND_DECK_CODEX_REINSTALL_PREFER_SOURCE = 'false';
    process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install --yes @openai/codex';
    const fallback = await withIsolatedRegistry();
    try {
      const fallbackInfo = fallback.registry.getExecutorCliInfo('codex');
      assert.equal(fallbackInfo.reinstall.preferSource, false);
      assert.equal(
        (fallbackInfo.reinstall.command || []).includes('npm'),
        true,
      );
      assert.equal(
        (fallbackInfo.reinstall.command || []).includes('@openai/codex'),
        true,
      );
      assert.equal(
        (fallbackInfo.reinstall.sourceCommand || []).join(' ').includes('git+https://github.com/my-org/codex-fork.git'),
        true,
      );
    } finally {
      await fallback.cleanup();
    }
  } finally {
    restore();
  }
});
