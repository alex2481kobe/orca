import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OrcaRegistry } from '../src/registry.js';
import { buildNextActionEnvelope } from '../src/agent-tools.js';
import {
  classifyOrchestratorTurn,
  filterToolsForTurnPolicy,
} from '../src/orchestrator-turn-policy.js';

async function withRegistry() {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-turn-policy-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry();
  registry.stopScheduler();
  const project = registry.createProject({ name: 'Turn Policy' }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, { name: 'chat', leader: 'codex' }, { actor: 'test', approved: true });
  const cleanup = async () => {
    if (typeof registry.drainPendingWrites === 'function') await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 25 });
  };
  return { registry, project, session, cleanup };
}

async function sendWithPolicyLease(registry, session, message) {
  const nextAction = buildNextActionEnvelope(registry, {
    role: 'orchestrator',
    projectId: session.projectId,
    sessionId: session.id,
  });
  return registry.sendOrchestratorMessage(session.id, {
    message,
    executorType: 'codex',
    permissionsProfile: 'auto-edit',
    baseUrl: 'http://127.0.0.1:3001',
    discoveryUrl: 'http://127.0.0.1:3001/api/agent-tools/discovery',
    nextActionUrl: `http://127.0.0.1:3001/api/agent-tools/next-action?role=orchestrator&projectId=${session.projectId}&sessionId=${session.id}`,
  }, {
    actor: 'test',
    approved: true,
    nextAction,
  });
}

function tokenForLane(registry, laneId) {
  return registry.laneRuntimeEnv.get(String(laneId))?.ORCA_TOOL_LEASE_TOKEN || '';
}

function assertLeaseTool(result, toolId, expected) {
  const tools = new Set(result.lease?.allowedTools || []);
  assert.equal(tools.has(toolId), expected, `${toolId} expected ${expected ? 'granted' : 'blocked'}`);
}

test('turn policy classifier maps common orchestrator intents to strategies', () => {
  assert.equal(classifyOrchestratorTurn({ message: 'Just checking in.' }).intent, 'answer');
  assert.equal(classifyOrchestratorTurn({ message: 'What happened with the agent?' }).intent, 'status');

  const plan = classifyOrchestratorTurn({ message: 'Scope a plan for the workflow, plan only and do not implement.' });
  assert.equal(plan.intent, 'plan');
  assert.equal(plan.executionStrategy, 'plan_only');

  const self = classifyOrchestratorTurn({ message: 'Fix the typo yourself without executor agents.' });
  assert.equal(self.intent, 'execute');
  assert.equal(self.executionStrategy, 'orchestrator_self');

  const delegated = classifyOrchestratorTurn({ message: 'Implement the feature with two executor agents in parallel.' });
  assert.equal(delegated.intent, 'execute');
  assert.equal(delegated.executionStrategy, 'executor_lanes');

  const loop = classifyOrchestratorTurn({ message: 'Create a loop daemon that can resume after rate limits.' });
  assert.equal(loop.intent, 'loop');
  assert.equal(loop.executionStrategy, 'loop');
});

test('non-objective answer turns get no Orca tool lease', async () => {
  const { registry, session, cleanup } = await withRegistry();
  try {
    const result = await sendWithPolicyLease(registry, session, 'Just checking in.');
    assert.equal(result.turnPolicy.intent, 'answer');
    assert.equal(result.turnPolicy.toolMode, 'none');
    assert.equal(result.lease, null);
    assert.equal(tokenForLane(registry, result.lane.id), '');
    assert.doesNotMatch(result.lane.taskPrompt, /ORCA_TOOL_LEASE_TOKEN/);
    assert.equal(result.allowedTools.length, 0);
  } finally {
    await cleanup();
  }
});

test('status turns receive read-only tools but cannot spawn or mutate workflow', async () => {
  const { registry, session, cleanup } = await withRegistry();
  try {
    const result = await sendWithPolicyLease(registry, session, 'What happened with the agent?');
    assert.equal(result.turnPolicy.intent, 'status');
    assert.equal(result.turnPolicy.toolMode, 'read_only');
    assertLeaseTool(result, 'orchestrator.status', true);
    assertLeaseTool(result, 'lane.get', true);
    assertLeaseTool(result, 'lane.create', false);
    assertLeaseTool(result, 'task.bulk_add', false);
    assertLeaseTool(result, 'session.plan.update', false);
    assert.match(result.lane.taskPrompt, /Read-only Orca status tools/);
    assert.throws(
      () => registry.validateToolLease(tokenForLane(registry, result.lane.id), { toolId: 'lane.create', sessionId: session.id }),
      (error) => error?.status === 403 && /does not grant this tool/.test(error?.message || ''),
    );
  } finally {
    await cleanup();
  }
});


test('self-execution turns allow own-lane handoff and block executor spawning', async () => {
  const { registry, session, cleanup } = await withRegistry();
  try {
    const result = await sendWithPolicyLease(registry, session, 'Fix the typo yourself without executor agents.');
    assert.equal(result.turnPolicy.executionStrategy, 'orchestrator_self');
    assertLeaseTool(result, 'lane.submit', true);
    assertLeaseTool(result, 'approval.request', true);
    assertLeaseTool(result, 'lane.create', false);
    assertLeaseTool(result, 'task.bulk_add', false);
    assert.match(result.lane.taskPrompt, /self-execution turn/);
  } finally {
    await cleanup();
  }
});


test('audit turns can verify existing work but cannot start fresh executors', async () => {
  const { registry, session, cleanup } = await withRegistry();
  try {
    const result = await sendWithPolicyLease(registry, session, 'Audit the finished lanes and verify evidence.');
    assert.equal(result.turnPolicy.intent, 'audit');
    assert.equal(result.turnPolicy.executionStrategy, 'audit_only');
    assertLeaseTool(result, 'audit.findings.record', true);
    assertLeaseTool(result, 'evidence.list', true);
    assertLeaseTool(result, 'lane.create', false);
    assertLeaseTool(result, 'task.bulk_add', false);
    assert.match(result.lane.taskPrompt, /audit turn/);
  } finally {
    await cleanup();
  }
});

test('tool filtering never grants tools outside both role and policy', () => {
  const policy = classifyOrchestratorTurn({ message: 'What happened with the agent?' });
  const filtered = filterToolsForTurnPolicy(policy, ['orchestrator.status', 'lane.create', 'provider.secret.set']);
  assert.deepEqual(filtered, ['orchestrator.status']);
});
