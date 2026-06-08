import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutorCommandArgs } from '../src/executor-factory.js';

const lane = (permissions) => ({ taskPrompt: 'do x', permissionsProfile: permissions, mcpConfigPath: '/tmp/m.json' });

test('codex sandbox governance maps from lane permissions', () => {
  // --full-auto is deprecated (codex 0.134+) -> force/auto maps to workspace-write.
  const force = buildExecutorCommandArgs('codex', lane('bypass'));
  assert.ok(!force.includes('--full-auto'), 'must not use deprecated --full-auto');
  assert.ok(force.includes('--sandbox') && force.includes('workspace-write'));
  assert.ok(force.includes('--skip-git-repo-check'));

  const plan = buildExecutorCommandArgs('codex', lane('plan'));
  assert.ok(plan.includes('--sandbox') && plan.includes('read-only'));

  const governed = buildExecutorCommandArgs('codex', lane('workspace'));
  assert.ok(governed.includes('--sandbox') && governed.includes('workspace-write'));
});

test('claude governed lanes route permission prompts through the Orca MCP tool', () => {
  const governed = buildExecutorCommandArgs('claude', lane('default'));
  assert.ok(governed.includes('--permission-prompt-tool'));
  assert.ok(governed.includes('mcp__orca__permission_prompt'));

  const bypass = buildExecutorCommandArgs('claude', lane('bypassPermissions'));
  assert.ok(!bypass.includes('--permission-prompt-tool'));
});
