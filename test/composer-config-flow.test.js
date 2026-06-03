import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OrcaRegistry } from '../src/registry.js';
import { buildExecutorCommandArgs } from '../src/executor/command-builder.js';

// Proves the composer's model / reasoning / speed / branch choices are not just
// UI: they flow chat → orchestrator lane → the ACTUAL executed CLI command, for
// both codex and claude, on the first message AND when changed mid-chat.

async function withRegistry() {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-flow-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry();
  registry.stopScheduler(); // never spawn a real process during the test
  const cleanup = async () => {
    if (typeof registry.drainPendingWrites === 'function') await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 25 });
  };
  return { registry, cleanup };
}

// Latest orchestrator-owned lane for a session (each chat turn spawns a new one).
function latestOrchestratorLane(registry, sessionId) {
  return registry.listLanes(sessionId)
    .filter((lane) => lane.owner === 'orchestrator')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

async function send(registry, sessionId, overrides) {
  return registry.sendOrchestratorMessage(sessionId, {
    message: 'build the thing',
    permissionsProfile: 'auto-edit',
    ...overrides,
  }, { actor: 'test', approved: true });
}

test('codex: chat model/reasoning/speed reach the executed command, and changing mid-chat changes it', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const project = registry.createProject({ name: 'Flow Codex' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'chat', leader: 'codex' }, { actor: 'test', approved: true });

    // First message: gpt-5.4 / xhigh / fast.
    await send(registry, session.id, { executorType: 'codex', model: 'gpt-5.4', intelligenceProfile: 'xhigh', speed: 'fast' });
    const lane1 = latestOrchestratorLane(registry, session.id);
    assert.equal(lane1.executorType, 'codex');
    assert.equal(lane1.model, 'gpt-5.4');
    assert.equal(lane1.intelligenceProfile, 'xhigh');
    assert.equal(lane1.speed, 'fast');
    const cmd1 = buildExecutorCommandArgs('codex', lane1);
    assert.ok(cmd1.includes('--model') && cmd1.includes('gpt-5.4'), 'codex command carries the model');
    assert.ok(cmd1.includes('model_reasoning_effort="xhigh"'), 'codex command carries xhigh effort');
    assert.ok(cmd1.includes('features.fast_mode=true'), 'codex fast speed → fast_mode flag');

    // Mid-chat change: gpt-5.5 / low / standard. New turn → new lane → new command.
    await send(registry, session.id, { executorType: 'codex', model: 'gpt-5.5', intelligenceProfile: 'low', speed: 'standard' });
    const lane2 = latestOrchestratorLane(registry, session.id);
    assert.notEqual(lane2.id, lane1.id, 'a mid-chat message spawns a fresh lane');
    assert.equal(lane2.model, 'gpt-5.5');
    assert.equal(lane2.intelligenceProfile, 'low');
    assert.equal(lane2.speed, 'standard');
    const cmd2 = buildExecutorCommandArgs('codex', lane2);
    assert.ok(cmd2.includes('gpt-5.5'), 'changed model reaches the command');
    assert.ok(cmd2.includes('model_reasoning_effort="low"'), 'changed effort reaches the command');
    assert.ok(!cmd2.includes('features.fast_mode=true'), 'standard speed → no fast_mode flag');
  } finally {
    await cleanup();
  }
});

test('claude: chat model/reasoning reach the executed command (incl. max), and changing mid-chat changes it', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const project = registry.createProject({ name: 'Flow Claude' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'chat', leader: 'claude' }, { actor: 'test', approved: true });

    // First message: opus / max (max is a real claude effort).
    await send(registry, session.id, { executorType: 'claude', model: 'opus', intelligenceProfile: 'max' });
    const lane1 = latestOrchestratorLane(registry, session.id);
    assert.equal(lane1.executorType, 'claude');
    assert.equal(lane1.model, 'opus');
    assert.equal(lane1.intelligenceProfile, 'max');
    const cmd1 = buildExecutorCommandArgs('claude', lane1);
    assert.ok(cmd1.includes('--model') && cmd1.includes('opus'), 'claude command carries the model');
    assert.ok(cmd1.includes('--effort') && cmd1.includes('max'), 'claude command carries the max effort');

    // Mid-chat change: sonnet / high.
    await send(registry, session.id, { executorType: 'claude', model: 'sonnet', intelligenceProfile: 'high' });
    const lane2 = latestOrchestratorLane(registry, session.id);
    assert.notEqual(lane2.id, lane1.id);
    assert.equal(lane2.model, 'sonnet');
    assert.equal(lane2.intelligenceProfile, 'high');
    const cmd2 = buildExecutorCommandArgs('claude', lane2);
    assert.ok(cmd2.includes('sonnet'), 'changed model reaches the command');
    const effIdx = cmd2.indexOf('--effort');
    assert.equal(cmd2[effIdx + 1], 'high', 'changed effort reaches the command');
  } finally {
    await cleanup();
  }
});

test('codex never emits the claude-only "max" effort even if asked', async () => {
  // The codex reasoning picker doesn't offer max; if a max value somehow arrives,
  // the command builder must drop it (codex has no max effort).
  const lane = { taskPrompt: 'x', model: 'gpt-5.5', intelligenceProfile: 'max', permissionsProfile: 'auto-edit', speed: 'standard' };
  const cmd = buildExecutorCommandArgs('codex', lane);
  assert.ok(!cmd.some((a) => String(a).includes('model_reasoning_effort')), 'codex drops the unsupported max effort');
});

test('branch picked in chat is threaded into the orchestrator prompt', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const project = registry.createProject({ name: 'Flow Branch' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'chat', leader: 'codex' }, { actor: 'test', approved: true });
    await send(registry, session.id, { executorType: 'codex', model: 'gpt-5.5', intelligenceProfile: 'high', branch: 'feature/new-thing' });
    const lane = latestOrchestratorLane(registry, session.id);
    assert.equal(lane.branch, 'feature/new-thing', 'branch is stored on the lane');
    assert.ok(/feature\/new-thing/.test(lane.taskPrompt), 'branch is included in the agent prompt');
  } finally {
    await cleanup();
  }
});
