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

    const project = registry.createProject({ name: 'Cleanup Project' });
    const session = registry.createSession(project.id, { name: 'Cleanup Session' });
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
    const project = registry.createProject({ name: 'Retention Project' });
    const session = registry.createSession(project.id, {
      name: 'Retention Session',
      artifactRetentionDays: 5,
    });

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
    const project = registry.createProject({ name: 'MCP Project' });
    const session = registry.createSession(project.id, { name: 'MCP Session' });

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

    const codexLane = await registry.createLane(session.id, {
      title: 'Codex Lane',
      executorType: 'codex',
      mcpToolIds: ['all-tool', 'codex-tool', 'claude-tool'],
    }, { actor: 'test', approved: true });

    const claudeLane = await registry.createLane(session.id, {
      title: 'Claude Lane',
      executorType: 'claude',
      mcpToolIds: ['all-tool', 'codex-tool', 'claude-tool'],
    }, { actor: 'test', approved: true });

    const mockLane = await registry.createLane(session.id, {
      title: 'Mock Lane',
      executorType: 'mock',
      mcpToolIds: ['all-tool', 'codex-tool', 'claude-tool'],
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
  } finally {
    await cleanup();
  }
});

test('Codex and Claude lanes accept executor overrides and command payloads', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const project = registry.createProject({ name: 'Executor Project' });
    const session = registry.createSession(project.id, {
      name: 'Executor Session',
      leader: 'codex',
    });

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

test('executor CLI reinstall command validation is executor-specific and safe', async () => {
  const restore = restoreEnv({
    COMMAND_DECK_CODEX_BINARY: process.env.COMMAND_DECK_CODEX_BINARY,
    COMMAND_DECK_CLAUDE_BINARY: process.env.COMMAND_DECK_CLAUDE_BINARY,
    COMMAND_DECK_CODEX_REINSTALL_COMMAND: process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND,
    COMMAND_DECK_CLAUDE_REINSTALL_COMMAND: process.env.COMMAND_DECK_CLAUDE_REINSTALL_COMMAND,
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

      process.env.COMMAND_DECK_CODEX_REINSTALL_COMMAND = 'npm install lodash';
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
