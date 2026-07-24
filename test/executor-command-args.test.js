// THE single place buildExecutorCommandArgs is asserted. These sandbox/permission
// strings ARE the security contract between Orca and each CLI (what the agent is
// allowed to touch), so they were previously asserted in three separate files —
// registry.test.js, executor-permissions.test.js and executor-hardening.test.js —
// which meant three places to update and three chances to disagree. The
// prompt-integrity and orphan-reap cases stay in executor-hardening.test.js;
// everything about the derived argv lives here.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildExecutorCommandArgs } from '../src/executor-factory.js';

const MCP_CONFIG_PATH = path.join(os.tmpdir(), 'orca-mcp.json');
const lane = (permissions) => ({ taskPrompt: 'do x', permissionsProfile: permissions, mcpConfigPath: '/tmp/m.json' });

test('buildExecutorCommandArgs derives safe argv from lane task prompt', () => {

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

  const codexTerminalArgs = buildExecutorCommandArgs('codex', {
    taskPrompt: 'Run in terminal mode',
    permissionsProfile: 'plan',
    presentationMode: 'terminal',
  });
  assert.deepEqual(codexTerminalArgs.slice(0, 2), ['--sandbox', 'read-only']);
  assert.equal(codexTerminalArgs.includes('exec'), false);
  assert.equal(codexTerminalArgs.includes('--json'), false);

  const claudeTerminalArgs = buildExecutorCommandArgs('claude', {
    taskPrompt: 'Run in terminal mode',
    permissionsProfile: 'plan',
    presentationMode: 'terminal',
  });
  assert.equal(claudeTerminalArgs.includes('--output-format'), false);
  assert.equal(claudeTerminalArgs.includes('stream-json'), false);
});

test('codex sandbox governance maps from lane permissions', () => {
  // --full-auto is deprecated (codex 0.134+); force/bypass maps to workspace-write.
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
  // This is the wiring behind the approval relay: a governed Claude lane calls
  // mcp__orca__permission_prompt, which drives approval.request/list/respond.
  const governed = buildExecutorCommandArgs('claude', lane('default'));
  assert.ok(governed.includes('--permission-prompt-tool'));
  assert.ok(governed.includes('mcp__orca__permission_prompt'));

  // An explicitly unsandboxed lane has nothing to ask permission for.
  const bypass = buildExecutorCommandArgs('claude', lane('bypassPermissions'));
  assert.ok(!bypass.includes('--permission-prompt-tool'));
});
