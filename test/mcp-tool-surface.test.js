// v2 MCP tool-surface snapshot: guards the agent tool contract against accidental
// drift. Two layers — (1) the raw TOOL_DEFINITIONS table, and (2) what the MCP
// server actually advertises over tools/list — both must keep exposing the core
// v2 tools. Spawn pattern mirrors orca-mcp-server.test.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { TOOL_DEFINITIONS } from '../src/agent-tools/tool-definitions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'mcp-server.js');

// The v2 tools that must never silently vanish from the contract. Values are the
// underscored names an MCP client sees (the server maps "." -> "__").
const CORE_V2_TOOLS = {
  'orchestrator.register': 'orchestrator__register',
  'orchestrator.update': 'orchestrator__update',
  'orchestrator.resign': 'orchestrator__resign',
  'executor.spawn': 'executor__spawn',
  'lane.list': 'lane__list',
  'lane.get': 'lane__get',
  'lane.terminal.tail': 'lane__terminal__tail',
  'audit.accept': 'audit__accept',
  'audit.request_fix': 'audit__request_fix',
};

// Drive the MCP server: write JSON-RPC lines, resolve once the awaited id lands.
function runMcp(env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [serverPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map();
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && msg.id !== null) responses.set(msg.id, msg);
        } catch { /* ignore non-JSON */ }
        const expectedIds = requests.filter((r) => r.id !== undefined).map((r) => r.id);
        if (expectedIds.every((id) => responses.has(id))) {
          child.kill();
          resolve(responses);
        }
      }
    });
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('mcp server timeout')); }, 8000);
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

test('TOOL_DEFINITIONS exposes exactly the current tool set including the core v2 tools', () => {
  // Snapshot the total surface so adding/removing a tool is a deliberate, visible
  // change rather than silent drift. v2 (KEYSTONE): orchestrator.enroll removed
  // (39 -> 38); the orchestrator record is the only container, no session enroll.
  // Model-A cleanup: session.worktree_policy.update removed with its deleted
  // /api/sessions route (38 -> 37); worktree isolation is per-lane by default.
  assert.equal(TOOL_DEFINITIONS.length, 37);

  const byId = new Map(TOOL_DEFINITIONS.map((tool) => [tool.id, tool]));
  for (const id of Object.keys(CORE_V2_TOOLS)) {
    const tool = byId.get(id);
    assert.ok(tool, `core v2 tool ${id} must exist in TOOL_DEFINITIONS`);
    assert.equal(tool.implemented, true, `${id} must be implemented`);
    assert.equal(typeof tool.route, 'string', `${id} must declare a route`);
    // Every core v2 tool is part of the orchestrator's toolkit.
    assert.equal(tool.roles.includes('orchestrator'), true, `${id} must be available to the orchestrator role`);
  }
});

test('MCP tools/list advertises the core v2 tools to an orchestrator with underscored names', async () => {
  const responses = await runMcp(
    { ORCA_ROLE: 'orchestrator' },
    [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
  );

  const tools = responses.get(1).result.tools;
  const names = tools.map((t) => t.name);

  // No dotted names ever cross the MCP boundary.
  assert.ok(!names.some((n) => n.includes('.')), 'MCP tool names must not contain dots');

  // Every core v2 tool must be advertised under its underscored name.
  for (const underscored of Object.values(CORE_V2_TOOLS)) {
    assert.ok(names.includes(underscored), `tools/list must expose ${underscored}`);
  }

  // Snapshot the advertised count: every orchestrator-callable tool plus the
  // permission_prompt gateway the server always appends.
  const orchestratorCallable = TOOL_DEFINITIONS.filter(
    (tool) => tool.implemented && tool.route && tool.roles.includes('orchestrator'),
  ).length;
  assert.equal(orchestratorCallable, 35);
  assert.equal(names.includes('permission_prompt'), true, 'permission gateway is always advertised');
  assert.equal(tools.length, orchestratorCallable + 1, 'orchestrator surface = callable tools + permission gateway');
});
