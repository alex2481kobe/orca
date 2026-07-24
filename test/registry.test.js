import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
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

// v2 orchestrator-native container: registerOrchestrator creates the project
// keyed by cwd (process.cwd() is always an approved repo root) and returns the
// orc_ container record that createLane now takes as its first arg. There are no
// session records; the orchestrator RECORD is the container (getSession(orc.id)
// returns its launchable container-seam view). Pass cwd to point the container at
// a specific (e.g. git) repo root.
async function makeOrchestrator(registry, { actor = 'test', title = 'Orch', cwd = process.cwd() } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd, actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
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

test('createProject/createLane accept and ignore a legacy settingsOverrides input', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({
      name: 'Legacy settings project',
      settingsOverrides: { flow: { template: 'orchestrator-executor-audit' } },
    }, { actor: 'test', approved: true });
    assert.ok(project.id);
    assert.equal(project.settingsOverrides, undefined, 'settingsOverrides is not stored');

    const { orchestrator } = await makeOrchestrator(registry);
    const lane = registry.createLane(orchestrator.id, {
      title: 'Legacy settings lane',
      executorType: 'mock',
      settingsOverrides: { flow: { fixRouting: 'new-agent' } },
    }, { actor: 'test', approved: true });
    assert.ok(lane.id);
    assert.equal(lane.settingsOverrides, undefined, 'settingsOverrides is not stored');
    // ...and the legacy input does NOT leak into the flow config.
    assert.equal(registry.getLaneFlowConfig(registry.getLane(lane.id)).fixRouting, 'same-agent');

    // The live seam: a validated `flow` field on the lane.
    const flowLane = registry.createLane(orchestrator.id, {
      title: 'Flow lane',
      executorType: 'mock',
      flow: { fixRouting: 'new-agent', maxAuditLoops: 4 },
    }, { actor: 'test', approved: true });
    const resolved = registry.getLaneFlowConfig(registry.getLane(flowLane.id));
    assert.equal(resolved.fixRouting, 'new-agent');
    assert.equal(resolved.maxAuditLoops, 4);
    assert.equal(resolved.requireAuditPass, true, 'unset fields fall back to defaults');

    // A bad flow value is refused rather than silently dropped.
    assert.throws(() => registry.createLane(orchestrator.id, {
      title: 'Bad flow lane',
      executorType: 'mock',
      flow: { fixRouting: 'telepathy' },
    }, { actor: 'test', approved: true }), (error) => error.status === 422);
  } finally {
    await cleanup();
  }
});

test('updateLaneControls lets user or agent set targetUrl + verificationCommand (and validates the URL)', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const { orchestrator: session } = await makeOrchestrator(registry);
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

test('project and lane mutations require policy approval', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    assert.throws(
      () => registry.createProject({ name: 'Unapproved Project' }),
      (error) => error.status === 409,
    );

    const project = registry.createProject({ name: 'Project with approval' }, { actor: 'test', approved: true });
    assert.equal(project.name, 'Project with approval');

    // v2 has no createSession; the equivalent container-scoped mutation gate is
    // createLane under an orchestrator container — it must also require approval.
    const { orchestrator } = await makeOrchestrator(registry);
    assert.throws(
      () => registry.createLane(orchestrator.id, { title: 'Unapproved Lane', executorType: 'mock' }),
      (error) => error.status === 409,
    );

    const lane = registry.createLane(
      orchestrator.id,
      { title: 'Approved Lane', executorType: 'mock' },
      { actor: 'test', approved: true },
    );
    assert.equal(lane.title, 'Approved Lane');

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

test('first-class CLI lanes accept executor overrides and command payloads', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const { orchestrator: session } = await makeOrchestrator(registry);

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
    const { orchestrator: session } = await makeOrchestrator(registry);

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

    const { orchestrator: session } = await makeOrchestrator(registry);
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
    const { orchestrator: session } = await makeOrchestrator(registry);

    assert.throws(() => registry.createLane(session.id, {
      title: 'Unsupported executor',
      executorType: 'openai-orchestrator',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' }), (error) => error.status === 422);
  } finally {
    await cleanup();
  }
});

test('Lane workdirs default to the container repo root and reject traversal/symlink escapes', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    // v2: the container is the orchestrator record; its repo root is the registered
    // cwd (process.cwd() here — a non-git dir, so lanes run directly in it). The
    // synthetic per-session workspace of Model-A is gone; the execution boundary is
    // now the container's repo root (an approved root).
    const { orchestrator: session } = await makeOrchestrator(registry);
    const container = registry.getSession(session.id);
    const repoRoot = container.repoRoot;
    assert.equal((await fs.stat(repoRoot)).isDirectory(), true);

    // Default workdir is the container repo root itself.
    const defaultLane = registry.createLane(session.id, {
      title: 'Default workspace lane',
      executorType: 'codex',
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });
    assert.equal(defaultLane.workdir, repoRoot);
    assert.equal((await fs.stat(defaultLane.workdir)).isDirectory(), true);

    // An absolute workdir inside an approved root is accepted.
    const subDir = path.join(repoRoot, 'feature-run');
    await fs.mkdir(subDir, { recursive: true });
    const absoluteLane = registry.createLane(session.id, {
      title: 'Absolute workspace lane',
      executorType: 'codex',
      workdir: subDir,
      mcpToolIds: [],
    }, { approved: true, actor: 'test' });
    assert.equal(absoluteLane.workdir, subDir);
    assert.equal((await fs.stat(absoluteLane.workdir)).isDirectory(), true);

    // A relative-traversal workdir is refused.
    assert.throws(
      () => registry.createLane(session.id, {
        title: 'Escaping workspace lane',
        executorType: 'codex',
        workdir: '../outside',
        mcpToolIds: [],
      }, { approved: true, actor: 'test' }),
      (error) => error.status === 422,
    );

    // A symlink that lives under the approved root but resolves OUTSIDE it is
    // refused (real-path escape guard), and nothing is created at the target.
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-outside-workdir-'));
    const symlinkWorkdir = path.join(repoRoot, 'link-outside');
    await fs.symlink(outsideDir, symlinkWorkdir, 'dir');
    try {
      assert.throws(
        () => registry.createLane(session.id, {
          title: 'Symlink escaping workspace lane',
          executorType: 'codex',
          workdir: symlinkWorkdir,
          mcpToolIds: [],
        }, { approved: true, actor: 'test' }),
        (error) => error.status === 422 && /resolves outside/.test(error.message),
      );
      assert.throws(
        () => registry.createLane(session.id, {
          title: 'Nested symlink escaping workspace lane',
          executorType: 'codex',
          workdir: path.join(symlinkWorkdir, 'pwn'),
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

test('lane controls update model, mode, intelligence, and audit event', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();

  try {
    const { orchestrator: session } = await makeOrchestrator(registry);
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
    const { orchestrator: session } = await makeOrchestrator(registry);
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
    const { orchestrator: session } = await makeOrchestrator(registry);

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

test('MCP config is generated per-lane with a safe path and only Orca\'s own server', async () => {
  const previousEnv = { ...process.env };
  const restore = restoreEnv(previousEnv);
  process.env.ORCA_CODEX_ALLOWED_BINARIES = 'codex';
  process.env.ORCA_CLAUDE_ALLOWED_BINARIES = 'claude';
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { orchestrator: session } = await makeOrchestrator(registry);

    const lane = registry.createLane(session.id, {
      title: 'MCP lane',
      executorType: 'codex',
      command: 'codex --version',
    }, { actor: 'test', approved: true });

    // A lane only gets an MCP config once it has a lease: the custom-tool CRUD is
    // gone, so Orca's own workflow server is the ONLY server a lane ever sees.
    registry.laneRuntimeEnv.set(String(lane.id), {
      ORCA_TOOL_LEASE_TOKEN: 'test-lease-token',
      ORCA_AGENT_TOOLS_BASE_URL: 'http://127.0.0.1:3000',
      ORCA_ROLE: 'executor',
    });

    const adapter = registry.getExecutorForType('codex');
    const runtimeDir = path.join(process.cwd(), 'artifacts', session.id, lane.id);
    await fs.mkdir(runtimeDir, { recursive: true });
    const { configPath, servers } = await adapter._buildMcpConfig(runtimeDir, registry.getLane(lane.id));
    assert.equal(typeof configPath, 'string');
    assert.equal(configPath.startsWith(runtimeDir), true);
    assert.equal(typeof servers, 'object');
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(parsed.laneId, lane.id);
    assert.equal(parsed.executorType, 'codex');
    assert.deepEqual(Object.keys(parsed.mcpServers), ['orca']);
    assert.equal(parsed.mcpServers.orca.env.ORCA_LANE_ID, lane.id);
    assert.equal(parsed.mcpServers.orca.env.ORCA_TOOL_LEASE_TOKEN, 'test-lease-token');

    // A lane with no lease gets no config file at all.
    const noLeaseLane = registry.createLane(session.id, {
      title: 'No lease lane',
      executorType: 'codex',
      command: 'codex --version',
    }, { actor: 'test', approved: true });
    const runtimeDir2 = path.join(process.cwd(), 'artifacts', session.id, noLeaseLane.id);
    await fs.mkdir(runtimeDir2, { recursive: true });
    const noConfig = await adapter._buildMcpConfig(runtimeDir2, registry.getLane(noLeaseLane.id));
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
      onAgentEvent: (lane, agentEvent) => registry.appendLaneAgentEvent(lane, agentEvent),
      onComplete: () => {},
      onFail: () => {},
      onStop: () => {},
      defaultWorkingDir: process.cwd(),
    });
    adapter.enforceAllowedBinary = false;
    adapter.allowedBinaries = [process.execPath];
    adapter.defaultBinary = process.execPath;
    adapter.workdirRoots = [process.cwd()];

    const { orchestrator: session } = await makeOrchestrator(registry);
    const lane = registry.createLane(session.id, {
      title: 'terminal artifact lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    const target = registry.getLane(lane.id);
    target.workdir = process.cwd();
    target.executorBinary = process.execPath;
    target.commandArgs = [
      '-e',
      'process.stdout.write("stdout-line\\n");process.stderr.write("stderr-line\\n")',
      'mcp_servers.orca.env.ORCA_TOOL_LEASE_TOKEN="secret-token"',
    ];

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
    assert.equal(terminal.includes('secret-token'), false, 'terminal header redacts token-shaped command args');
    assert.equal(JSON.stringify(target.processMeta).includes('secret-token'), false, 'process metadata stores redacted launch args');
    assert.equal(target.agentEvents.some((event) => event.type === 'command.output' && event.content === 'stdout-line'), true);
  } finally {
    restore();
    await cleanup();
  }
});

test('manual executor stop records a structured agent.stopped event', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { orchestrator: session } = await makeOrchestrator(registry);
    const executorLane = registry.createLane(session.id, {
      title: 'Executor to stop',
      executorType: 'mock',
      owner: 'dashboard',
    }, { actor: 'dashboard', approved: true });

    await registry.stopLane(executorLane.id, { actor: 'dashboard', approved: true });
    const stopped = registry.getLane(executorLane.id);
    assert.equal(stopped.agentEvents.some((event) => event.type === 'agent.stopped'), true);
  } finally {
    await cleanup();
  }
});

test('Recovery flips orphaned running lanes to failed with explicit reason', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { orchestrator: session } = await makeOrchestrator(registry);
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

test('Lane terminal artifacts include process/MCP/changed-files metadata', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { orchestrator: session } = await makeOrchestrator(registry);
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

    // v2: the container's repo root IS the orchestrator's registered cwd, so point
    // it at the git repo directly.
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });

    assert.equal(registry.getSession(session.id).repoRoot, repoDir);

    const lane = registry.createLane(session.id, {
      title: 'feature lane',
      executorType: 'mock',
      branch: 'feature/cleanup',
      worktreeMode: 'isolated',
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
      worktreeMode: 'isolated',
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

test('pruneInMemoryRecords preserves un-integrated isolated worktrees, reaps only after integrate/discard', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  const prevCap = process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
  try {
    const repoDir = path.join(process.cwd(), 'prune-repo');
    await fs.mkdir(repoDir, { recursive: true });
    const { spawnSync } = await import('node:child_process');
    const g = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 't@local'); g('config', 'user.name', 'T');
    await fs.writeFile(path.join(repoDir, 'README.md'), 'hi');
    g('add', 'README.md'); g('commit', '-qm', 'init');

    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });
    const a = registry.createLane(session.id, { title: 'a', executorType: 'mock', branch: 'a', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    const b = registry.createLane(session.id, { title: 'b', executorType: 'mock', branch: 'b', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    const c = registry.createLane(session.id, { title: 'c', executorType: 'mock', branch: 'c', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    assert.ok(a.worktreePath && b.worktreePath && c.worktreePath);

    for (const [lane, when] of [[a, '2020-01-01T00:00:00.000Z'], [b, '2020-03-01T00:00:00.000Z'], [c, '2020-06-01T00:00:00.000Z']]) {
      const t = registry.getLane(lane.id); t.state = 'done'; t.completedAt = when;
    }

    // Cap at 1 terminal lane/session. USER POLICY: an isolated lane's worktree
    // holds un-integrated work, so pruning must NOT reap it — all three lanes AND
    // their checkouts survive even though the cap is exceeded.
    process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = '1';
    registry.pruneInMemoryRecords();
    for (const lane of [a, b, c]) {
      assert.ok(registry.getLane(lane.id), `un-integrated isolated lane ${lane.title} must be preserved`);
      assert.equal((await fs.stat(lane.worktreePath)).isDirectory(), true, `${lane.title} worktree preserved on disk`);
    }

    // Integrate a and b (integratedAt set) — they leave the protected set and are
    // now subject to the cap. With two reapable lanes and cap 1, the OLDEST (a) is
    // dropped and its worktree reclaimed; b (newer, integrated) is kept; c stays
    // protected as un-integrated.
    const aPath = a.worktreePath;
    registry.getLane(a.id).integratedAt = '2020-02-01T00:00:00.000Z';
    registry.getLane(b.id).integratedAt = '2020-04-01T00:00:00.000Z';
    registry.pruneInMemoryRecords();
    assert.equal(registry.getLane(a.id), undefined, 'oldest integrated lane is prunable');
    await assert.rejects(fs.access(aPath), (e) => e.code === 'ENOENT', 'reaped lane worktree removed from disk');
    assert.ok(registry.getLane(b.id), 'newer integrated lane kept under the cap');
    assert.equal((await fs.stat(b.worktreePath)).isDirectory(), true, 'kept lane worktree survives');
    assert.ok(registry.getLane(c.id), 'un-integrated lane still protected');
    assert.equal((await fs.stat(c.worktreePath)).isDirectory(), true, 'protected worktree survives');
  } finally {
    if (prevCap === undefined) delete process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION;
    else process.env.ORCA_MAX_TERMINAL_LANES_PER_SESSION = prevCap;
    await cleanup();
  }
});

// Small git-repo fixture helper for the worktree lifecycle tests below.
async function makeGitRepo(dirName) {
  const { spawnSync } = await import('node:child_process');
  const repoDir = path.join(process.cwd(), dirName);
  await fs.mkdir(repoDir, { recursive: true });
  const g = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@local'); g('config', 'user.name', 'T');
  await fs.writeFile(path.join(repoDir, 'README.md'), 'hi');
  g('add', 'README.md'); g('commit', '-qm', 'init');
  return { repoDir, g };
}

test('removeLaneWorktree refuses to discard uncommitted work unless force:true', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { repoDir } = await makeGitRepo('discard-repo');
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });
    const lane = registry.createLane(session.id, { title: 'dirty', executorType: 'mock', branch: 'feat', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    assert.ok(lane.worktreePath);
    registry.getLane(lane.id).state = 'done';
    // Leave uncommitted work in the worktree.
    await fs.writeFile(path.join(lane.worktreePath, 'scratch.txt'), 'unsaved work');

    // Safe by default: refuses with a client-actionable 409 + reason.
    await assert.rejects(
      registry.removeLaneWorktree(lane.id, { approved: true }),
      (e) => e.status === 409 && e.uncommittedChanges >= 1 && /uncommitted/i.test(e.message),
      'discard must refuse dirty worktree without force',
    );
    assert.equal((await fs.stat(lane.worktreePath)).isDirectory(), true, 'worktree still on disk after refusal');

    // force:true discards it.
    const forced = await registry.removeLaneWorktree(lane.id, { approved: true, force: true });
    assert.equal(forced.removed, true);
    assert.equal(forced.forced, true);
    await assert.rejects(fs.access(lane.worktreePath), (e) => e.code === 'ENOENT', 'force discard removes worktree');
  } finally {
    await cleanup();
  }
});

test('integrateLane merges an accepted isolated lane branch into the base branch', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { repoDir, g } = await makeGitRepo('integrate-repo');
    const baseBranch = g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });
    const lane = registry.createLane(session.id, { title: 'feature', executorType: 'mock', branch: 'feat', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    assert.ok(lane.worktreePath && lane.branch === 'feat');

    // Commit work inside the lane worktree.
    const { spawnSync } = await import('node:child_process');
    const gw = (...args) => spawnSync('git', args, { cwd: lane.worktreePath, encoding: 'utf8' });
    await fs.writeFile(path.join(lane.worktreePath, 'feature.txt'), 'new feature');
    gw('add', 'feature.txt'); gw('commit', '-qm', 'add feature');

    // Not accepted yet -> integrate refuses.
    await assert.rejects(registry.integrateLane(lane.id), (e) => e.status === 409, 'must be audit-accepted first');

    registry.getLane(lane.id).state = 'done';
    registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });

    const result = await registry.integrateLane(lane.id);
    assert.equal(result.integrated, true, 'merge should succeed');
    assert.equal(result.baseBranch, baseBranch);
    assert.equal(result.branch, 'feat');
    // The feature file is now merged into the base checkout.
    assert.equal((await fs.stat(path.join(repoDir, 'feature.txt'))).isFile(), true, 'feature merged into base branch');
    assert.ok(registry.getLane(lane.id).integratedAt, 'lane marked integrated');
  } finally {
    await cleanup();
  }
});

test('integrateLane rejects non-isolated (direct/shared) lanes', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { repoDir } = await makeGitRepo('integrate-direct-repo');
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });
    // direct: runs in the repo checkout, no worktree to merge back.
    const lane = registry.createLane(session.id, { title: 'inplace', executorType: 'mock', worktreeMode: 'direct' }, { actor: 'test', approved: true });
    registry.getLane(lane.id).state = 'done';
    registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });
    await assert.rejects(
      registry.integrateLane(lane.id),
      (e) => e.status === 422 && /isolated/i.test(e.message),
      'direct lane cannot be integrated',
    );
  } finally {
    await cleanup();
  }
});

test('createLane auto + read-only profile in a git repo resolves to direct (no worktree)', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { repoDir } = await makeGitRepo('auto-readonly-repo');
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });
    assert.equal(registry.getSession(session.id).repoRoot, repoDir);

    // Read-only work never needs a worktree even inside a git repo: auto -> direct,
    // and the lane runs in the repo checkout itself (worktreePath === repoRoot).
    const lane = registry.createLane(session.id, {
      title: 'read-only review',
      executorType: 'mock',
      worktreeMode: 'auto',
      permissionsProfile: 'read-only',
    }, { actor: 'test', approved: true });

    assert.equal(lane.worktreeMode, 'direct');
    assert.equal(lane.worktreePath, repoDir);
    assert.equal(lane.workdir, repoDir);
    assert.ok(!lane.worktreePath.includes('worktrees'), 'read-only auto lane gets no managed worktree');
  } finally {
    await cleanup();
  }
});

test('createLane auto writer resolves to isolated when another writer lane is already running', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { repoDir } = await makeGitRepo('auto-writer-repo');
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });

    // First writer lane: sole writer, so auto -> direct (edits the checkout).
    const first = registry.createLane(session.id, {
      title: 'first writer',
      executorType: 'mock',
      worktreeMode: 'auto',
      permissionsProfile: 'auto-edit',
    }, { actor: 'test', approved: true });
    assert.equal(first.worktreeMode, 'direct');
    // Make the first writer actively running so it counts against isolation.
    registry.getLane(first.id).state = 'running';

    // Second writer lane created while the first is running: writers now overlap,
    // so auto -> isolated and a real per-lane worktree is created.
    const second = registry.createLane(session.id, {
      title: 'second writer',
      executorType: 'mock',
      worktreeMode: 'auto',
      permissionsProfile: 'auto-edit',
    }, { actor: 'test', approved: true });

    assert.equal(second.worktreeMode, 'isolated');
    assert.ok(second.worktreePath.includes('worktrees'), 'isolated lane sits under sessions/worktrees');
    assert.notEqual(second.worktreePath, repoDir);
    assert.equal((await fs.stat(second.worktreePath)).isDirectory(), true, 'real worktree created on disk');
    assert.equal(second.repoRoot, repoDir);
  } finally {
    await cleanup();
  }
});

test('integrateLane returns a 409 conflict when two isolated lanes edit the same file, and auto-aborts to a clean base', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { repoDir, g } = await makeGitRepo('integrate-conflict-repo');
    const baseBranch = g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });
    const { spawnSync } = await import('node:child_process');

    // Two isolated lanes, both branched off HEAD, both add the SAME new file with
    // different content -> an add/add conflict once the first is merged.
    const laneA = registry.createLane(session.id, { title: 'A', executorType: 'mock', branch: 'lane-a', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    const laneB = registry.createLane(session.id, { title: 'B', executorType: 'mock', branch: 'lane-b', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    assert.ok(laneA.worktreePath && laneB.worktreePath);

    const commitIn = async (worktreePath, content) => {
      await fs.writeFile(path.join(worktreePath, 'conflict.txt'), content);
      const gw = (...args) => spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8' });
      gw('add', 'conflict.txt');
      gw('commit', '-qm', `edit ${content}`);
    };
    await commitIn(laneA.worktreePath, 'from-A');
    await commitIn(laneB.worktreePath, 'from-B');

    for (const lane of [laneA, laneB]) {
      registry.getLane(lane.id).state = 'done';
      registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });
    }

    // First integration succeeds and lands conflict.txt=from-A on the base branch.
    const firstResult = await registry.integrateLane(laneA.id);
    assert.equal(firstResult.integrated, true);

    // Second integration collides on conflict.txt -> 409 with conflicts===true.
    await assert.rejects(
      registry.integrateLane(laneB.id),
      (e) => e.status === 409 && e.conflicts === true && e.baseBranch === baseBranch && e.branch === 'lane-b',
      'overlapping edits must surface a 409 conflict',
    );

    // Auto-abort left the base checkout clean: no half-merged state, no MERGE_HEAD.
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' });
    assert.equal(status.stdout.trim(), '', 'base branch has no leftover conflict markers');
    const mergeHead = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: repoDir, encoding: 'utf8' });
    assert.notEqual(mergeHead.status, 0, 'no merge is left in progress after abort');
    // conflict.txt still holds the cleanly-integrated first lane's content.
    assert.equal(await fs.readFile(path.join(repoDir, 'conflict.txt'), 'utf8'), 'from-A');
    // laneB was NOT marked integrated (the merge failed).
    assert.ok(!registry.getLane(laneB.id).integratedAt, 'conflicted lane is not marked integrated');
  } finally {
    await cleanup();
  }
});

test('integrateLane reports nothing-to-merge for an isolated lane with no new commits', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { repoDir, g } = await makeGitRepo('integrate-empty-repo');
    const baseBranch = g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });

    // Isolated lane branched off HEAD, but nothing is committed in its worktree.
    const lane = registry.createLane(session.id, { title: 'empty', executorType: 'mock', branch: 'empty-lane', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    assert.ok(lane.worktreePath && lane.branch === 'empty-lane');
    registry.getLane(lane.id).state = 'done';
    registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });

    const result = await registry.integrateLane(lane.id);
    assert.equal(result.integrated, false);
    assert.equal(result.nothingToMerge, true);
    assert.equal(result.baseBranch, baseBranch);
    assert.equal(result.branch, 'empty-lane');
    // Idempotent success-ish: the lane is marked integrated so retention can reap it.
    assert.ok(registry.getLane(lane.id).integratedAt, 'nothing-to-merge still marks integratedAt');
  } finally {
    await cleanup();
  }
});

test('integrateLane with push:true propagates the merged commit to a bare origin remote', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { repoDir, g } = await makeGitRepo('integrate-push-repo');
    const baseBranch = g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    const { spawnSync } = await import('node:child_process');

    // Wire a bare repo as origin and publish the base branch (sets upstream so a
    // bare `git push` inside mergeLaneBranch has a target).
    const bareDir = path.join(process.cwd(), 'origin.git');
    spawnSync('git', ['init', '-q', '--bare', bareDir], { encoding: 'utf8' });
    g('remote', 'add', 'origin', bareDir);
    g('push', '-u', 'origin', baseBranch);

    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });
    const lane = registry.createLane(session.id, { title: 'pushable', executorType: 'mock', branch: 'push-lane', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    assert.ok(lane.worktreePath && lane.branch === 'push-lane');

    const gw = (...args) => spawnSync('git', args, { cwd: lane.worktreePath, encoding: 'utf8' });
    await fs.writeFile(path.join(lane.worktreePath, 'shipped.txt'), 'ship it');
    gw('add', 'shipped.txt');
    gw('commit', '-qm', 'add shipped feature');

    registry.getLane(lane.id).state = 'done';
    registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['reviewed'] });

    const result = await registry.integrateLane(lane.id, { push: true });
    assert.equal(result.integrated, true);
    assert.equal(result.pushed, true, `push should succeed (reason: ${result.pushReason || 'none'})`);

    // The merged commit reached the bare remote's base branch.
    const bareLog = spawnSync('git', ['-C', bareDir, 'log', '--format=%s', baseBranch], { encoding: 'utf8' });
    assert.equal(bareLog.status, 0);
    assert.ok(/add shipped feature/.test(bareLog.stdout), 'bare remote received the merged commit');
  } finally {
    await cleanup();
  }
});

test('deleteLane refuses a running lane and removes a terminal lane worktree', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { repoDir } = await makeGitRepo('delete-lane-repo');
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });

    // A running lane cannot be deleted (would orphan its child) -> 422.
    const liveLane = registry.createLane(session.id, { title: 'live', executorType: 'mock', branch: 'live', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    registry.getLane(liveLane.id).state = 'running';
    await assert.rejects(
      registry.deleteLane(liveLane.id, { actor: 'test' }),
      (e) => e.status === 422 && /stop the lane/i.test(e.message),
      'a running lane must not be deletable',
    );
    assert.ok(registry.getLane(liveLane.id), 'refused delete leaves the lane in place');

    // A terminal (done) isolated lane deletes cleanly and its worktree is reaped.
    const doneLane = registry.createLane(session.id, { title: 'done', executorType: 'mock', branch: 'done', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    const doneWorktree = doneLane.worktreePath;
    assert.equal((await fs.stat(doneWorktree)).isDirectory(), true);
    registry.getLane(doneLane.id).state = 'done';

    const result = await registry.deleteLane(doneLane.id, { actor: 'test' });
    assert.equal(result.deleted, true);
    assert.equal(result.id, doneLane.id);
    assert.equal(registry.getLane(doneLane.id), undefined, 'deleted lane record is gone');
    await assert.rejects(fs.access(doneWorktree), (e) => e.code === 'ENOENT', 'terminal lane worktree removed from disk');
  } finally {
    await cleanup();
  }
});

test('touchOrchestrator refreshes lastSeenAt for the lease owner and rejects others (heartbeat)', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { orchestrator, lease } = await makeOrchestrator(registry);
    // Age the lease.
    registry.orchestrators.find((o) => o.id === orchestrator.id).lastSeenAt = '2020-01-01T00:00:00.000Z';
    const refreshed = registry.touchOrchestrator(orchestrator.id, { leaseId: lease.id });
    assert.ok(Date.parse(refreshed.lastSeenAt) > Date.parse('2020-01-01T00:00:00.000Z'), 'lastSeenAt refreshed');
    // A different lease cannot heartbeat someone else's orchestrator.
    assert.throws(() => registry.touchOrchestrator(orchestrator.id, { leaseId: 'someone-else' }), (e) => e.status === 403);
  } finally {
    await cleanup();
  }
});

test('createLane raises the taskPrompt cap and records a visible warning on truncation', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { orchestrator: session } = await makeOrchestrator(registry);
    // 9000 chars: previously truncated at 8000, now preserved in full.
    const mid = 'x'.repeat(9000);
    const midLane = registry.createLane(session.id, { title: 'mid', executorType: 'mock', taskPrompt: mid }, { actor: 'test', approved: true });
    assert.equal(midLane.taskPrompt.length, 9000, 'prompt under the new cap is preserved in full');
    assert.ok(!(midLane.warnings || []).some((w) => w.kind === 'task_prompt_truncated'), 'no truncation warning under cap');

    // Over the new cap: still truncated, but NOT silently — a visible warning is recorded.
    const huge = 'y'.repeat(100001);
    const hugeLane = registry.createLane(session.id, { title: 'huge', executorType: 'mock', taskPrompt: huge }, { actor: 'test', approved: true });
    assert.equal(hugeLane.taskPrompt.length, 100000, 'prompt clipped to the new cap');
    const warning = (hugeLane.warnings || []).find((w) => w.kind === 'task_prompt_truncated');
    assert.ok(warning, 'truncation records a visible warning');
    assert.match(warning.message, /truncated/i);
  } finally {
    await cleanup();
  }
});

test('reapIdleLanes stops an idle running lane unless it opted out', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { orchestrator } = await makeOrchestrator(registry);
    const past = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min idle (> 15m window)

    // Default (idleShutdown true): idle past the window → reaped.
    const idle = registry.createLane(orchestrator.id, { title: 'idle', executorType: 'mock' }, { actor: 'test', approved: true });
    const idleLane = registry.getLane(idle.id);
    idleLane.state = 'running'; idleLane.lastActivityAt = past;
    assert.equal(idleLane.idleShutdown, true);

    // idleShutdown:false — never auto-reaped, even when idle.
    const policy = registry.createLane(orchestrator.id, { title: 'opted out', executorType: 'mock', idleShutdown: false }, { actor: 'test', approved: true });
    const policyLane = registry.getLane(policy.id);
    policyLane.state = 'running'; policyLane.lastActivityAt = past;
    assert.equal(policyLane.idleShutdown, false);

    // Recently active: not reaped.
    const fresh = registry.createLane(orchestrator.id, { title: 'fresh', executorType: 'mock' }, { actor: 'test', approved: true });
    const freshLane = registry.getLane(fresh.id);
    freshLane.state = 'running'; freshLane.lastActivityAt = new Date().toISOString();

    await registry.reapIdleLanes(Date.now());

    assert.equal(registry.getLane(idle.id).state, 'stopped', 'idle lane should be reaped');
    assert.equal(registry.getLane(policy.id).state, 'running', 'an idleShutdown:false lane must never be idle-reaped');
    assert.equal(registry.getLane(fresh.id).state, 'running', 'recently-active lane must not be reaped');

    // Disabled entirely when the window is 0.
    const prevWindow = registry.laneIdleTimeoutMs;
    registry.laneIdleTimeoutMs = 0;
    const idle2 = registry.createLane(orchestrator.id, { title: 'idle2', executorType: 'mock' }, { actor: 'test', approved: true });
    const idle2Lane = registry.getLane(idle2.id);
    idle2Lane.state = 'running'; idle2Lane.lastActivityAt = past;
    await registry.reapIdleLanes(Date.now());
    assert.equal(registry.getLane(idle2.id).state, 'running', 'idle-shutdown disabled when window <= 0');
    registry.laneIdleTimeoutMs = prevWindow;
  } finally {
    await cleanup();
  }
});

test('a direct lane runs in the repo checkout and its checkout is never removable', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const repoDir = path.join(process.cwd(), 'direct-mode-repo');
    await fs.mkdir(repoDir, { recursive: true });
    const { spawnSync } = await import('node:child_process');
    const g = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'test@local');
    g('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repoDir, 'README.md'), 'hello');
    g('add', 'README.md');
    g('commit', '-qm', 'init');

    // 'shared' and 'direct' are no longer modes a caller may request. A lone
    // writer under the default 'auto' resolves to direct: it runs in the
    // container's checkout with no managed worktree.
    const { orchestrator: session } = await makeOrchestrator(registry, { cwd: repoDir });
    const lane = registry.createLane(session.id, {
      title: 'direct mode lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });

    assert.equal(lane.worktreeMode, 'direct');
    assert.equal(lane.workdir, repoDir);
    assert.equal(lane.worktreePath, repoDir);
    assert.ok(!lane.worktreePath.includes('worktrees'), 'a direct lane must not create a managed worktree');

    // The guard that matters: Orca must never delete the user's repo checkout.
    registry.getLane(lane.id).state = 'done';
    await assert.rejects(
      registry.removeLaneWorktree(lane.id, { actor: 'test', approved: true }),
      (error) => error.status === 422 && /repo checkout/.test(error.message),
    );
  } finally {
    await cleanup();
  }
});
test('Orchestrator container refuses an out-of-bounds cwd but accepts non-git dirs', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    // v2: the container's repo root is the orchestrator's registered cwd. A cwd
    // outside the approved repo roots is rejected by registerOrchestrator.
    const outsideRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-repo-'));
    const { spawnSync } = await import('node:child_process');
    spawnSync('git', ['init', '-q'], { cwd: outsideRepo });
    spawnSync('git', ['config', 'user.email', 't@l'], { cwd: outsideRepo });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: outsideRepo });
    await fs.writeFile(path.join(outsideRepo, 'R'), 'x');
    spawnSync('git', ['add', 'R'], { cwd: outsideRepo });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: outsideRepo });
    try {
      await assert.rejects(
        () => makeOrchestrator(registry, { cwd: outsideRepo }),
        (error) => error.status === 422,
      );
      // A symlink under the approved root that resolves outside is also refused.
      const linkToOutside = path.join(process.cwd(), 'link-to-outside-repo');
      await fs.symlink(outsideRepo, linkToOutside, 'dir');
      await assert.rejects(
        () => makeOrchestrator(registry, { cwd: linkToOutside }),
        (error) => error.status === 422,
      );
    } finally {
      await fs.rm(outsideRepo, { recursive: true, force: true });
    }

    // A plain (non-git) directory within the approved root is ACCEPTED — agents
    // can spawn in any folder, git is not required (Codex behavior). A lane there
    // runs directly in the directory (no isolated worktree).
    const plainDir = path.join(process.cwd(), 'plain-non-git-dir');
    await fs.mkdir(plainDir, { recursive: true });
    const { orchestrator } = await makeOrchestrator(registry, { cwd: plainDir });
    assert.equal(registry.getSession(orchestrator.id).repoRoot, await fs.realpath(plainDir));
    const plainLane = registry.createLane(orchestrator.id, {
      title: 'plain lane',
      executorType: 'mock',
    }, { actor: 'test', approved: true });
    assert.equal(plainLane.workdir, await fs.realpath(plainDir), 'non-git lane should run in the folder');
    assert.equal(plainLane.worktreePath, await fs.realpath(plainDir), 'non-git lane has no separate worktree');
    assert.ok(!plainLane.worktreePath.includes('worktrees'), 'non-git lane should not get an isolated worktree');
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
      const { orchestrator: session } = await makeOrchestrator(disabled.registry);
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
      const { orchestrator: session } = await makeOrchestrator(enabled.registry);
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

// Resolved once at load so the skip decision is honest: without a runnable claude
// this test REPORTS AS SKIPPED, instead of the old `console.warn(); return;` that
// reported a green pass while asserting nothing.
const CLAUDE_BINARY = process.env.ORCA_CLAUDE_BINARY || '/opt/homebrew/bin/claude';
const claudeIsRunnable = (() => {
  try {
    const probe = spawnSync(CLAUDE_BINARY, ['--version'], { encoding: 'utf8', timeout: 4000 });
    return probe.status === 0 && /\d+\.\d+/.test(probe.stdout || '');
  } catch {
    return false;
  }
})();

test('Real Claude CLI launches through the executor adapter and reports PID + exit', {
  skip: claudeIsRunnable ? false : `${CLAUDE_BINARY} is not runnable on this machine`,
}, async () => {
  const claudeBinary = CLAUDE_BINARY;
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

    const { orchestrator: session } = await makeOrchestrator(registry);
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
    const deadline = Date.now() + 1000;
    while (target.processMeta.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
    const { orchestrator: session } = await makeOrchestrator(registry);
    const lane = registry.createLane(session.id, { title: 'work', executorType: 'mock' }, { approved: true, actor: 'test' });
    const target = registry.getLane(lane.id);
    target.state = 'running';

    const result = registry.submitLane(lane.id, {
      actor: 'executor',
      summary: 'Implemented the feature',
      changedFiles: ['src/a.js', 'src/b.js'],
    });
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

test('assertAgentToolAllowed enforces the workflow state machine', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const { orchestrator: session } = await makeOrchestrator(registry);
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
    const { orchestrator: session } = await makeOrchestrator(registry);
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

// DELETED: 'updateSessionPlan stores goal and plan with audit' — updateSessionPlan
// was a Model-A session-container method (session plan/goal) and no longer exists
// in the orchestrator-native model. No orchestrator-level equivalent to port to.
//
// DELETED: 'saveSessionAttachment stores a file under session artifacts...' —
// saveSessionAttachment (session plan/attachments surface) was removed with the
// session container; there is no orchestrator-native attachment method to port to.


// DELETED: 'reinstall override rejects alternate registries, alias packages, and
// bare URLs' — the executor CLI reinstall/install surface was removed entirely.
// Orca does not install or update CLI tools; that is the user's responsibility.

// DELETED: 'deleteSession permanently removes an archived session and refuses
// active ones' — deleteSession + updateSession were Model-A session-container
// lifecycle methods and are gone in the orchestrator-native model (there are no
// session records to archive/delete). The project-level equivalent is covered by
// the 'deleteProject requires approval and archived state...' test below.

test('deleteProject requires approval and archived state before permanent removal', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Delete Project' }, { actor: 'test', approved: true });
    await assert.rejects(() => registry.deleteProject(project.id, { actor: 'test' }), (e) => e.status === 409 && e.requiresApproval);
    await assert.rejects(() => registry.deleteProject(project.id, { actor: 'test', approved: true }), (e) => e.status === 422);
    registry.updateProject(project.id, { state: 'archived' }, { actor: 'test', approved: true });
    const result = await registry.deleteProject(project.id, { actor: 'test', approved: true });
    assert.equal(result.deleted, true);
    assert.equal(registry.getProject(project.id), undefined);
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
