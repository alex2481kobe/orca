import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OrcaRegistry } from '../src/registry.js';
import { buildExecutorCommandArgs } from '../src/executor/command-builder.js';
import { detectSlashCommands } from '../src/registry-cli-info.js';

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

test('claude ultracode maps to the --settings toggle, not --effort', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const project = registry.createProject({ name: 'Flow Ultracode' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'chat', leader: 'claude' }, { actor: 'test', approved: true });
    await send(registry, session.id, { executorType: 'claude', model: 'opus', intelligenceProfile: 'ultracode' });
    const lane = latestOrchestratorLane(registry, session.id);
    assert.equal(lane.intelligenceProfile, 'ultracode');
    const cmd = buildExecutorCommandArgs('claude', lane);
    const sIdx = cmd.indexOf('--settings');
    assert.ok(sIdx >= 0, 'ultracode is enabled via --settings');
    assert.ok(/"ultracode"\s*:\s*true/.test(cmd[sIdx + 1]), 'settings JSON turns ultracode on');
    assert.ok(!cmd.includes('--effort'), 'ultracode does not pass an --effort flag (it is not a valid effort value)');
  } finally {
    await cleanup();
  }
});

test('a custom free-text model is passed through to the executed command (both CLIs)', () => {
  // Someone types an arbitrary model — it must reach --model verbatim.
  const claude = buildExecutorCommandArgs('claude', { taskPrompt: 'x', model: 'opus-4-6', intelligenceProfile: 'high', permissionsProfile: 'auto-edit' });
  assert.equal(claude[claude.indexOf('--model') + 1], 'opus-4-6', 'claude runs the custom model');
  const codex = buildExecutorCommandArgs('codex', { taskPrompt: 'x', model: 'gpt-5.5-custom', intelligenceProfile: 'high', permissionsProfile: 'auto-edit' });
  assert.equal(codex[codex.indexOf('--model') + 1], 'gpt-5.5-custom', 'codex runs the custom model');
});

test('a custom model entered in chat reaches the lane + command end-to-end', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const project = registry.createProject({ name: 'Custom Model' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'chat', leader: 'claude' }, { actor: 'test', approved: true });
    await send(registry, session.id, { executorType: 'claude', model: 'opus-4-6', intelligenceProfile: 'high' });
    const lane = latestOrchestratorLane(registry, session.id);
    assert.equal(lane.model, 'opus-4-6', 'custom model stored on the lane');
    assert.equal(buildExecutorCommandArgs('claude', lane).includes('opus-4-6'), true);
  } finally {
    await cleanup();
  }
});

test('a known foreign CLI model is corrected for the selected orchestrator executor', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const project = registry.createProject({ name: 'Foreign Model Guard' }, { actor: 'test', approved: true });
    const codexSession = registry.createSession(project.id, { name: 'codex chat', leader: 'codex' }, { actor: 'test', approved: true });

    await send(registry, codexSession.id, { executorType: 'codex', model: 'opus', intelligenceProfile: 'high' });
    const codexLane = latestOrchestratorLane(registry, codexSession.id);
    assert.equal(codexLane.executorType, 'codex');
    assert.notEqual(codexLane.model, 'opus', 'codex must not inherit claude opus from a stale hidden field');
    assert.ok(!buildExecutorCommandArgs('codex', codexLane).includes('opus'), 'codex command must not pass opus');

    const claudeSession = registry.createSession(project.id, { name: 'claude chat', leader: 'claude' }, { actor: 'test', approved: true });
    await send(registry, claudeSession.id, { executorType: 'claude', model: 'opus', intelligenceProfile: 'high' });
    const claudeLane = latestOrchestratorLane(registry, claudeSession.id);
    assert.equal(claudeLane.executorType, 'claude');
    assert.equal(claudeLane.model, 'opus', 'opus is still valid when claude is selected');
  } finally {
    await cleanup();
  }
});

test('terminal presentation mode reaches the orchestrator lane and drops structured CLI output flags', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const project = registry.createProject({ name: 'Terminal Presentation' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'terminal chat', leader: 'codex' }, { actor: 'test', approved: true });
    await send(registry, session.id, {
      executorType: 'codex',
      model: 'gpt-5.5',
      intelligenceProfile: 'high',
      executionMode: 'terminal',
    });
    const lane = latestOrchestratorLane(registry, session.id);
    assert.equal(lane.presentationMode, 'terminal');
    const cmd = buildExecutorCommandArgs('codex', lane);
    assert.equal(cmd[0], 'exec');
    assert.equal(cmd.includes('--json'), false, 'terminal mode keeps codex in native text presentation');

    const claudeCmd = buildExecutorCommandArgs('claude', {
      taskPrompt: 'hello',
      presentationMode: 'terminal',
      model: 'opus',
      intelligenceProfile: 'high',
      permissionsProfile: 'plan',
    });
    assert.equal(claudeCmd.includes('--output-format'), false, 'terminal mode keeps claude off stream-json');
    assert.equal(claudeCmd.includes('stream-json'), false);
  } finally {
    await cleanup();
  }
});

test('codex reasoning includes minimal but never max in the executed command', () => {
  const minimal = buildExecutorCommandArgs('codex', { taskPrompt: 'x', model: 'gpt-5.5', intelligenceProfile: 'minimal', permissionsProfile: 'auto-edit' });
  assert.ok(minimal.includes('model_reasoning_effort="minimal"'), 'codex honors minimal effort');
});

test('claude defaults to opus (highest), not sonnet, when the binary is present', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const claude = registry.getExecutorCapabilities('claude');
    if (claude.binaryExists && (claude.controls.model.values || []).includes('opus')) {
      assert.equal(claude.controls.model.defaultValue, 'opus', 'claude default model is opus');
    }
  } finally {
    await cleanup();
  }
});

test('claude exposes ultracode as a reasoning level in its capabilities', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const claude = registry.getExecutorCapabilities('claude');
    const values = claude.controls.intelligence.values;
    assert.ok(values.includes('ultracode'), 'claude reasoning includes ultracode');
    // "max" is parsed from claude --help, so only assert it when the binary is present.
    if (claude.binaryExists) assert.ok(values.includes('max'), 'claude reasoning includes max');
    const codexValues = registry.getExecutorCapabilities('codex').controls.intelligence.values;
    assert.ok(!codexValues.includes('ultracode'), 'codex does NOT expose ultracode');
    assert.ok(!codexValues.includes('max'), 'codex does NOT expose max');
  } finally {
    await cleanup();
  }
});

test('speed is dynamic: codex/claude expose fast, others do not', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    assert.equal(registry.getExecutorCapabilities('codex').controls.speed.supported, true);
    assert.equal(registry.getExecutorCapabilities('claude').controls.speed.supported, true);
    // mock has no fast mode → Speed control hidden.
    const mockSpeed = registry.getExecutorCapabilities('mock').controls.speed;
    assert.ok(!mockSpeed || mockSpeed.supported !== true, 'mock has no fast speed');
  } finally {
    await cleanup();
  }
});

test('codex fast speed → features.fast_mode flag', () => {
  const lane = { taskPrompt: 'x', model: 'gpt-5.5', intelligenceProfile: 'high', speed: 'fast', permissionsProfile: 'auto-edit' };
  const cmd = buildExecutorCommandArgs('codex', lane);
  assert.ok(cmd.includes('features.fast_mode=true'), 'codex fast → fast_mode feature');
});

test('claude fast speed → fastMode setting, merged with ultracode when both set', () => {
  // fast + normal effort: --effort high AND --settings {"fastMode":true}
  const a = buildExecutorCommandArgs('claude', { taskPrompt: 'x', model: 'sonnet', intelligenceProfile: 'high', speed: 'fast', permissionsProfile: 'auto-edit' });
  assert.equal(a[a.indexOf('--effort') + 1], 'high');
  assert.equal(JSON.parse(a[a.indexOf('--settings') + 1]).fastMode, true);
  // fast + ultracode: one settings object with both, no --effort.
  const b = buildExecutorCommandArgs('claude', { taskPrompt: 'x', model: 'opus', intelligenceProfile: 'ultracode', speed: 'fast', permissionsProfile: 'auto-edit' });
  const s = JSON.parse(b[b.indexOf('--settings') + 1]);
  assert.equal(s.ultracode, true);
  assert.equal(s.fastMode, true);
  assert.ok(!b.includes('--effort'), 'ultracode does not pass --effort');
});

test('permission modes are sourced from capabilities (dynamic, per CLI)', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const codex = registry.getExecutorCapabilities('codex').controls.permissions;
    const claude = registry.getExecutorCapabilities('claude').controls.permissions;
    assert.ok(Array.isArray(codex.values) && codex.values.length, 'codex modes come from caps');
    assert.ok(Array.isArray(claude.values) && claude.values.length, 'claude modes come from caps');
    // Models are dynamic too: free-text entry is always allowed, codex carries a catalog when present.
    assert.equal(registry.getExecutorCapabilities('codex').controls.model.freeText, true);
  } finally {
    await cleanup();
  }
});

test('slash commands are detected per CLI with valid shape; unknown types get none', () => {
  assert.deepEqual(detectSlashCommands('mock', 'mock'), [], 'no metadata → no slash commands');
  const codex = detectSlashCommands('codex', 'codex'); // may be [] on a cold cache (async-warmed)
  assert.ok(Array.isArray(codex));
  const MAPPINGS = new Set(['apply-local', 'dashboard-action', 'send-to-agent', 'interactive-only']);
  for (const c of codex) {
    assert.ok(typeof c.command === 'string' && c.command.startsWith('/'), 'command is a /slug');
    assert.ok(MAPPINGS.has(c.mapping), `valid mapping: ${c.mapping}`);
    assert.ok(typeof c.description === 'string' && c.description.length, 'has a description');
  }
});

test('slashCommands are exposed on CLI capabilities and absent for mock', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    assert.ok(Array.isArray(registry.getExecutorCapabilities('codex').controls.slashCommands));
    const mockSlash = registry.getExecutorCapabilities('mock').controls.slashCommands;
    assert.ok(!mockSlash || mockSlash.length === 0, 'mock has no slash commands');
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
    assert.match(lane.taskPrompt, /create or switch to it/);

    const remoteTurn = await send(registry, session.id, {
      executorType: 'codex',
      model: 'gpt-5.5',
      intelligenceProfile: 'high',
      branch: 'origin/main',
    });
    assert.equal(remoteTurn.lane.branch, 'origin/main', 'remote ref hint is stored on the lane');
    assert.match(remoteTurn.lane.taskPrompt, /Use git ref origin\/main as the base\/reference/);
    assert.match(remoteTurn.lane.taskPrompt, /create a local workflow branch from it/);
    assert.doesNotMatch(remoteTurn.lane.taskPrompt, /create or switch to it/);
  } finally {
    await cleanup();
  }
});

test('lightweight chat turns do not receive the full orchestration tool contract', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const project = registry.createProject({ name: 'Flow Greeting' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'chat', leader: 'codex' }, { actor: 'test', approved: true });
    await send(registry, session.id, { executorType: 'codex', message: 'HI' });
    const lane = latestOrchestratorLane(registry, session.id);

    assert.match(lane.taskPrompt, /conversational, not an actionable project objective/i);
    assert.doesNotMatch(lane.taskPrompt, /ORCA_TOOL_LEASE_TOKEN/);
    assert.doesNotMatch(lane.taskPrompt, /Executor capability matrix/);
    assert.doesNotMatch(lane.taskPrompt, /Next-action URL/);
    assert.match(lane.taskPrompt, /do not infer, use, or reveal the user's personal name/i);
  } finally {
    await cleanup();
  }
});

test('orchestrator prompts carry plain issue context for recent agent blockers', async () => {
  const { registry, cleanup } = await withRegistry();
  try {
    const project = registry.createProject({ name: 'Flow Blocker' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'chat', leader: 'codex' }, { actor: 'test', approved: true });
    const createdLane = registry.createLane(session.id, {
      title: 'Claude auth probe',
      executorType: 'claude',
      owner: 'orchestrator',
    }, { actor: 'test', approved: true });
    const failedLane = registry.getLane(createdLane.id);
    failedLane.state = 'failed';
    failedLane.exitReason = 'Claude authentication failed; run /login before retrying.';
    failedLane.completedAt = new Date().toISOString();
    failedLane.updatedAt = failedLane.completedAt;

    await send(registry, session.id, { executorType: 'codex', message: 'What happened with the agent?' });
    const lane = latestOrchestratorLane(registry, session.id);

    assert.match(lane.taskPrompt, /Operator issue context/);
    assert.match(lane.taskPrompt, /Claude auth probe/);
    assert.match(lane.taskPrompt, /Run the CLI login\/setup command on this workstation/);
    assert.doesNotMatch(lane.taskPrompt, /approve .*MCP tool/i);
  } finally {
    await cleanup();
  }
});
