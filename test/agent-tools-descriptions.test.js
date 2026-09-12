// THE TOOL DESCRIPTION CONTRACT.
//
// The 2026-09-10 hardening audit found that MCP tool descriptions were not
// enough to call a tool correctly without opening the source. The failures were
// real and repeatable: a lane silently ran no agent because `executorType`
// defaults to `mock`; a spawn was refused because the default policy requires
// `approved: true`; a Claude lane died at launch because `permissionsProfile:
// "read-only"` is a Codex sandbox that Claude receives verbatim as an invalid
// --permission-mode; a bad `model` reached the CLI unvalidated.
//
// The description surface is prose, so most of it cannot be machine-checked.
// What CAN be checked is that a description does not silently fall out of step
// with the code that refuses the call — and that is what rots. Every rule below
// derives its expectation from the enforcing module rather than from a list
// maintained here, so adding a gate or an executor type fails this test until
// the description says so.
//
// The MCP description an agent actually reads is `${summary} [${method} ${route}]`
// (src/mcp-server.js), so these rules are stated over `summary`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { TOOL_DEFINITIONS } from '../src/agent-tools/tool-definitions.js';
import { defaultPolicy } from '../src/registry-policy.js';
import { FIRST_CLASS_CLI_EXECUTOR_TYPES } from '../src/executor/constants.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Policy actions with no agent-facing tool. Nothing in TOOL_DEFINITIONS routes to
// them, so no description can be expected to mention their gate. If a tool is
// ever added for one, the completeness test below fails until it is moved out.
const NOT_AGENT_REACHABLE = new Set(['createProject', 'deleteProject', 'auditDoneLanes']);

const byId = new Map(TOOL_DEFINITIONS.map((tool) => [tool.id, tool]));

test('every tool summary is a usable sentence', () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(typeof tool.summary, 'string', `${tool.id}: summary must be a string`);
    assert.ok(tool.summary.trim().length > 0, `${tool.id}: summary must not be empty`);
    // A trailing quote is legitimate: several summaries end by quoting the exact
    // refusal string the caller will see.
    assert.match(tool.summary.trim(), /[.!?]["'’)\]]?$/, `${tool.id}: summary must end in a full stop`);
  }
});

// A body is the one thing the generated inputSchema cannot describe: every
// non-GET mutating tool gets a single opaque `body: {type:'object'}` property
// (src/mcp-server.js). If the summary does not name the fields, nothing does.
test('every tool that takes a request body names that body in its description', () => {
  for (const tool of TOOL_DEFINITIONS) {
    if (!tool.mutating || tool.method === 'GET') continue;
    assert.match(
      tool.summary,
      /\bbody\b/i,
      `${tool.id}: takes a request body that the generated inputSchema shows only as an untyped object, so the summary must name its fields (write "Body: {...}")`,
    );
  }
});

// The gate that produced the audit's most-reported refusal. `approved` is read
// from the request body, so an agent that does not know to send it gets a 409 it
// cannot act on.
test('every approval-gated tool says that it is approval-gated', () => {
  for (const tool of TOOL_DEFINITIONS) {
    if (!tool.policyAction) continue;
    const policy = defaultPolicy[tool.policyAction];
    assert.ok(policy, `${tool.id}: policyAction "${tool.policyAction}" is not in defaultPolicy`);
    if (!policy.requiresApproval) continue;
    assert.match(
      tool.summary,
      /\bapproved\b/,
      `${tool.id}: defaultPolicy.${tool.policyAction}.requiresApproval is true, so the default policy refuses this call with 409 unless the body carries "approved": true — the summary must say so`,
    );
  }
});

// The drift guard: a new approval gate in the policy table must be claimed by
// the tool that reaches it (or declared unreachable), so it cannot be added
// without a description change.
test('every approval-gated policy action is claimed by a tool or declared unreachable', () => {
  const claimed = new Set(TOOL_DEFINITIONS.map((tool) => tool.policyAction).filter(Boolean));
  for (const [action, policy] of Object.entries(defaultPolicy)) {
    if (!policy.requiresApproval) continue;
    if (NOT_AGENT_REACHABLE.has(action)) {
      assert.ok(
        !claimed.has(action),
        `policy action "${action}" is listed as not agent-reachable but a tool now declares it — remove it from NOT_AGENT_REACHABLE`,
      );
      continue;
    }
    assert.ok(
      claimed.has(action),
      `policy action "${action}" requires approval but no tool declares policyAction: "${action}" — add it to the tool that reaches it, or to NOT_AGENT_REACHABLE if no tool does`,
    );
  }
});

test('a tool that declares a policyAction is actually gated on it in the source', () => {
  const sources = fs.readdirSync(srcDir)
    .filter((name) => name.startsWith('registry-') && name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(srcDir, name), 'utf8'))
    .join('\n');
  for (const tool of TOOL_DEFINITIONS) {
    if (!tool.policyAction) continue;
    assert.ok(
      sources.includes(`evaluateActionPolicy('${tool.policyAction}'`),
      `${tool.id}: declares policyAction "${tool.policyAction}", but no registry module evaluates it — the description would promise a gate that does not exist`,
    );
  }
});

// Enums live in the enforcing code, never in a list kept beside the prose. A
// description that names one of these fields must spell out the current values.
test('a description that names an enum field lists that enum\'s current values', () => {
  const enums = [
    // registry-executors.getSupportedExecutorTypes() is ['mock', ...FIRST_CLASS_…]
    // plus an operator-enabled 'cli'; the first-class set is the part every
    // description must carry.
    { field: 'executorType', values: ['mock', ...FIRST_CLASS_CLI_EXECUTOR_TYPES] },
    { field: 'verdict', values: ['accepted', 'fix_requested', 'blocked'] },
    { field: 'worktreeMode', values: ['auto', 'isolated'] },
  ];
  for (const tool of TOOL_DEFINITIONS) {
    for (const { field, values } of enums) {
      if (!tool.summary.includes(field)) continue;
      for (const value of values) {
        assert.ok(
          tool.summary.includes(value),
          `${tool.id}: names "${field}" but does not list its value "${value}" — the accepted set is enforced in code, so the description must match it`,
        );
      }
    }
  }
});

// "If two fields interact, say so in both." executor.spawn and
// lane.controls.update take the same three CLI-shaped fields, and each one has a
// failure mode that is invisible from the field name alone.
test('every tool taking permissionsProfile carries the cross-CLI caveat', () => {
  for (const tool of TOOL_DEFINITIONS) {
    if (!tool.summary.includes('permissionsProfile')) continue;
    assert.ok(
      tool.summary.includes('read-only') && tool.summary.includes('plan'),
      `${tool.id}: takes permissionsProfile, so it must say that "read-only" is a real Codex sandbox but reaches Claude verbatim as --permission-mode (use "plan" there) — a Claude lane given "read-only" dies at launch`,
    );
  }
});

test('every tool taking model says Orca does not validate it', () => {
  for (const tool of TOOL_DEFINITIONS) {
    if (!/\bmodel\b/.test(tool.summary)) continue;
    assert.match(
      tool.summary,
      /unvalidated|does not validate|not validate/i,
      `${tool.id}: passes model straight to the CLI as --model, so the summary must say Orca does not validate it (a bad name surfaces only as a failed lane)`,
    );
  }
});

// The default that made a lane silently run no agent.
test('executor.spawn names mock as the default and says it runs no real agent', () => {
  const spawn = byId.get('executor.spawn');
  assert.ok(spawn, 'executor.spawn must exist');
  assert.match(spawn.summary, /mock/, 'executor.spawn must name the mock executor type');
  assert.match(
    spawn.summary,
    /default when omitted|the default[^.]*omitted/i,
    'executor.spawn must say mock is what an omitted executorType becomes',
  );
  assert.match(
    spawn.summary,
    /runs no real agent/i,
    'executor.spawn must say the mock executor runs no real agent — the silent failure this text exists to prevent',
  );
});

// The description an agent reads is assembled, not stored. If that ever changes,
// every rule above stops describing the real surface.
test('the MCP description is still built from the summary and the route', () => {
  const server = fs.readFileSync(path.join(srcDir, 'mcp-server.js'), 'utf8');
  assert.ok(
    server.includes('${tool.summary} [${tool.method} ${tool.route}]'),
    'mcp-server.js no longer builds each tool description from summary + route, so the rules in this file no longer describe what an agent reads — update them to match the new surface',
  );
});
