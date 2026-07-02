// Server-owned orchestrator turn policy. This is the single source of truth for
// how a dashboard chat turn is classified and which workflow tools it may use.

export const ORCHESTRATOR_TURN_POLICY_VERSION = 1;

export const TURN_INTENTS = Object.freeze([
  'answer',
  'status',
  'plan',
  'audit',
  'execute',
  'loop',
]);

export const EXECUTION_STRATEGIES = Object.freeze([
  'none',
  'plan_only',
  'audit_only',
  'orchestrator_self',
  'executor_lanes',
  'auto',
  'loop',
]);

const POLICY_TOOL_FAMILIES = Object.freeze({
  read: [
    'session.describe',
    'session.list',
    'session.next_action',
    'executor.capabilities',
    'orchestrator.thread.get',
    'orchestrator.status',
    'lane.list',
    'lane.get',
    'lane.terminal.tail',
    'approval.list',
    'task.list',
    'backlog.status',
    'event.replay',
    'loop.list',
    'loop.describe',
    'evidence.list',
    'evidence.latest',
    'project.list',
    'project.describe',
    'settings.describe_effective',
    'tailscale.status',
    'orca.setup_guide',
  ],
  ownership: [
    'orchestrator.enroll',
    'orchestrator.resign',
  ],
  memory: [
    'session.memory.get',
    'session.memory.update',
    'event.drain',
    'event.ack',
  ],
  plan: [
    'session.plan.update',
    'task.add',
    'task.bulk_add',
    'task.update',
    'task.delete',
    'capacity.request',
    'capacity.set_policy',
    'session.worktree_policy.update',
    'settings.update',
  ],
  selfExecute: [
    'lane.submit',
    'approval.request',
    'lane.controls.update',
    'critique.bundle.create',
    'critique.findings.record',
    'critique.waive',
    'evidence.capture_screenshot',
    'evidence.capture_video',
  ],
  delegate: [
    'lane.create',
    'lane.retry',
    'lane.shutdown',
    'lane.delete',
  ],
  audit: [
    'audit.queue_one',
    'audit.queue_all_ready',
    'audit.findings.record',
    'audit.accept',
    'audit.request_fix',
    'audit.block',
    'approval.respond',
  ],
  loop: [
    'loop.create',
    'loop.update',
  ],
  projectSetup: [
    'project.create',
    'project.quick_link.upsert',
    'project.quick_link.delete',
    'project.quick_link.health',
    'provider.list',
    'provider.health',
  ],
});

function safeText(value, max = 2000) {
  return String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

function compactText(value) {
  return safeText(value, 2000)
    .toLowerCase()
    .replace(/[^a-z0-9\s'?/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordsOf(compact) {
  return compact.split(/\s+/).filter(Boolean);
}

function hasAny(pattern, text) {
  return pattern.test(text);
}

function basePolicy(overrides = {}) {
  return sanitizeOrchestratorTurnPolicy({
    version: ORCHESTRATOR_TURN_POLICY_VERSION,
    intent: 'answer',
    objectiveRequired: false,
    promptMode: 'chat',
    toolMode: 'none',
    executionStrategy: 'none',
    allowedActionFamilies: [],
    spawnBudget: {
      executorLanes: 0,
      backlogTasks: 0,
      loops: 0,
      requiresObjective: true,
    },
    reason: 'No actionable project objective was detected.',
    ...overrides,
  });
}

export function classifyOrchestratorTurn({
  message = '',
  attachments = [],
} = {}) {
  const text = compactText(message);
  const words = wordsOf(text);
  const hasAttachment = Array.isArray(attachments) && attachments.length > 0;
  if (!text && !hasAttachment) return basePolicy();

  const explicitNoExecution = hasAny(/\b(do not|don't|without|no)\s+(implement|execute|edit|change|spawn|delegate|executor|subagent|run)\b|\b(plan only|scope only|no executor|without executor|without subagents)\b/, text);
  const explicitSelf = hasAny(/\b(do it yourself|you do it|orchestrator (do|handle)|single agent|no executor|without executor|without subagents)\b/, text);
  const explicitDelegate = !explicitNoExecution && hasAny(/\b(executor agents?|executors?|subagents?|workers?|parallel|fan out|delegate|split (it|this)|two agents|couple agents)\b/, text);
  const status = hasAny(/\b(status|what happened|where are we|what is running|what's running|why did|why is|stuck|blocked|failed|error|rate limit|auth|login|permission|token|queue|queued|working|progress)\b/, text);
  const loop = hasAny(/\b(loop|daemon|24\/7|soak|cadence|resume|pause|autonomous|always running|rate limit|usage limit)\b/, text);
  const audit = hasAny(/\b(audit|review|verify|validate|hardening|harden|security|red team|acceptance|evidence|critique)\b/, text);
  const plan = hasAny(/\b(plan|scope|organize|roadmap|break down|breakdown|decompose|tasks?|backlog|strategy|architect|design|suggest|what should|how should|outline)\b/, text);
  const execute = hasAny(/\b(build|fix|implement|create|run|start|launch|setup|set up|deploy|commit|push|update|change|delete|merge|rebase|install|debug|investigate|clean|refactor|write|modify|edit)\b/, text);
  const projectScope = hasAny(/\b(repo|repository|project|app|server|client|ui|dashboard|session|lane|agent|executor|orchestrator|supervisor|backlog|branch|commit|pr|test|bug|error|file|code|setting|settings|flow|contract)\b/, text);
  const requestShape = hasAny(/\b(can you|could you|would you|should we|do we|i need|i want|please|let's|lets|go ahead)\b/, text);

  if (status && !execute && !plan && !audit && !loop) {
    return basePolicy({
      intent: 'status',
      promptMode: 'status',
      toolMode: 'read_only',
      allowedActionFamilies: ['read'],
      reason: 'The user asked for status or blocker explanation, not new work.',
    });
  }

  if (!hasAttachment && !execute && !plan && !audit && !loop && !(projectScope && requestShape)) {
    if (words.length <= 20) return basePolicy();
  }

  if (loop) {
    return basePolicy({
      intent: 'loop',
      objectiveRequired: true,
      promptMode: 'orchestration',
      toolMode: 'loop',
      executionStrategy: 'loop',
      allowedActionFamilies: ['read', 'ownership', 'memory', 'plan', 'loop', 'delegate', 'audit', 'selfExecute'],
      spawnBudget: { executorLanes: 2, backlogTasks: 20, loops: 1, requiresObjective: true },
      reason: 'The user asked for durable loop or long-running agent workflow.',
    });
  }

  if ((plan || (projectScope && requestShape)) && explicitNoExecution) {
    return basePolicy({
      intent: 'plan',
      objectiveRequired: true,
      promptMode: 'orchestration',
      toolMode: 'planning',
      executionStrategy: 'plan_only',
      allowedActionFamilies: ['read', 'ownership', 'memory', 'plan'],
      spawnBudget: { executorLanes: 0, backlogTasks: 20, loops: 0, requiresObjective: true },
      reason: 'The user asked for planning/organization without execution.',
    });
  }

  if (audit && !execute && !explicitDelegate) {
    return basePolicy({
      intent: 'audit',
      objectiveRequired: true,
      promptMode: 'orchestration',
      toolMode: 'audit',
      executionStrategy: 'audit_only',
      allowedActionFamilies: ['read', 'ownership', 'memory', 'audit', 'selfExecute'],
      spawnBudget: { executorLanes: 0, backlogTasks: 0, loops: 0, requiresObjective: true },
      reason: 'The user asked for audit/review/verification of existing work.',
    });
  }

  if (execute || hasAttachment) {
    if (explicitSelf && !explicitDelegate) {
      return basePolicy({
        intent: 'execute',
        objectiveRequired: true,
        promptMode: 'orchestration',
        toolMode: 'self_execute',
        executionStrategy: 'orchestrator_self',
        allowedActionFamilies: ['read', 'ownership', 'memory', 'selfExecute', 'audit'],
        spawnBudget: { executorLanes: 0, backlogTasks: 0, loops: 0, requiresObjective: true },
        reason: 'The user asked the orchestrator to execute directly without executor agents.',
      });
    }
    if (explicitDelegate) {
      return basePolicy({
        intent: 'execute',
        objectiveRequired: true,
        promptMode: 'orchestration',
        toolMode: 'delegate',
        executionStrategy: 'executor_lanes',
        allowedActionFamilies: ['read', 'ownership', 'memory', 'plan', 'delegate', 'audit'],
        spawnBudget: { executorLanes: 4, backlogTasks: 40, loops: 0, requiresObjective: true },
        reason: 'The user asked to use executor agents/lanes.',
      });
    }
    return basePolicy({
      intent: 'execute',
      objectiveRequired: true,
      promptMode: 'orchestration',
      toolMode: 'auto',
      executionStrategy: 'auto',
      allowedActionFamilies: ['read', 'ownership', 'memory', 'plan', 'selfExecute', 'delegate', 'audit'],
      spawnBudget: { executorLanes: 2, backlogTasks: 20, loops: 0, requiresObjective: true },
      reason: 'The user gave an actionable implementation objective; the orchestrator may choose self-execution or executor lanes within budget.',
    });
  }

  return basePolicy({
    intent: plan || projectScope ? 'plan' : 'answer',
    objectiveRequired: Boolean(plan || projectScope),
    promptMode: plan || projectScope ? 'orchestration' : 'chat',
    toolMode: plan || projectScope ? 'planning' : 'none',
    executionStrategy: plan || projectScope ? 'plan_only' : 'none',
    allowedActionFamilies: plan || projectScope ? ['read', 'ownership', 'memory', 'plan'] : [],
    spawnBudget: plan || projectScope
      ? { executorLanes: 0, backlogTasks: 20, loops: 0, requiresObjective: true }
      : { executorLanes: 0, backlogTasks: 0, loops: 0, requiresObjective: true },
    reason: plan || projectScope
      ? 'The user asked for planning/organization, not implementation.'
      : 'No actionable project objective was detected.',
  });
}

export function sanitizeOrchestratorTurnPolicy(policy = {}) {
  const intent = TURN_INTENTS.includes(policy.intent) ? policy.intent : 'answer';
  const executionStrategy = EXECUTION_STRATEGIES.includes(policy.executionStrategy) ? policy.executionStrategy : 'none';
  const families = Array.isArray(policy.allowedActionFamilies) ? policy.allowedActionFamilies : [];
  const allowedFamilyNames = new Set(Object.keys(POLICY_TOOL_FAMILIES));
  const spawn = policy.spawnBudget && typeof policy.spawnBudget === 'object' ? policy.spawnBudget : {};
  return {
    version: ORCHESTRATOR_TURN_POLICY_VERSION,
    intent,
    objectiveRequired: Boolean(policy.objectiveRequired),
    promptMode: ['chat', 'status', 'orchestration'].includes(policy.promptMode) ? policy.promptMode : 'chat',
    toolMode: ['none', 'read_only', 'planning', 'audit', 'self_execute', 'delegate', 'auto', 'loop'].includes(policy.toolMode) ? policy.toolMode : 'none',
    executionStrategy,
    allowedActionFamilies: families
      .map((value) => String(value || '').trim())
      .filter((value, index, all) => allowedFamilyNames.has(value) && all.indexOf(value) === index),
    spawnBudget: {
      executorLanes: Math.max(0, Math.min(20, Number.parseInt(spawn.executorLanes, 10) || 0)),
      backlogTasks: Math.max(0, Math.min(200, Number.parseInt(spawn.backlogTasks, 10) || 0)),
      loops: Math.max(0, Math.min(5, Number.parseInt(spawn.loops, 10) || 0)),
      requiresObjective: spawn.requiresObjective !== false,
    },
    reason: safeText(policy.reason, 500),
  };
}

export function toolsForTurnPolicy(policy = {}) {
  const clean = sanitizeOrchestratorTurnPolicy(policy);
  const tools = new Set();
  for (const family of clean.allowedActionFamilies) {
    for (const toolId of POLICY_TOOL_FAMILIES[family] || []) tools.add(toolId);
  }
  return [...tools];
}

export function filterToolsForTurnPolicy(policy = {}, allowedTools = []) {
  const policyTools = new Set(toolsForTurnPolicy(policy));
  if (!policyTools.size) return [];
  return (Array.isArray(allowedTools) ? allowedTools : [])
    .map((toolId) => String(toolId || '').trim())
    .filter((toolId) => toolId && policyTools.has(toolId))
    .filter((toolId, index, all) => all.indexOf(toolId) === index);
}

export function renderTurnPolicyForPrompt(policy = {}) {
  const clean = sanitizeOrchestratorTurnPolicy(policy);
  const budget = clean.spawnBudget || {};
  const familyText = clean.allowedActionFamilies.length ? clean.allowedActionFamilies.join(', ') : 'none';
  return [
    'Server turn policy:',
    `- intent: ${clean.intent}`,
    `- execution strategy: ${clean.executionStrategy}`,
    `- tool mode: ${clean.toolMode}`,
    `- allowed action families: ${familyText}`,
    `- spawn budget: executorLanes=${budget.executorLanes || 0}, backlogTasks=${budget.backlogTasks || 0}, loops=${budget.loops || 0}`,
    `- reason: ${clean.reason || 'policy classified by server'}`,
    'Obey this policy even if a previous message suggested broader orchestration.',
  ].join('\n');
}
