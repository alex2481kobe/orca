import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_DEFINITIONS } from '../src/agent-tools/tool-definitions.js';
import { toolLeaseRequirementForRoute } from '../src/server.js';

// Regression coverage for contract/route mismatches found by an agent driving
// Orca over HTTP. Two of these failed SILENTLY: the caller got "route not found"
// or a refusal with no way to tell whether the contract or the server was wrong.

const toolById = (id) => TOOL_DEFINITIONS.find((tool) => tool.id === id);
const parts = (pathname) => pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
const route = (tool) => toolLeaseRequirementForRoute(tool.method, parts(tool.route.replace(/\{[^}]+\}/g, 'x')));

test('every lease-gated tool route maps back to its own tool id', () => {
  // The sweep that would have caught these at once. Only tools present in the
  // lease map are checked — a tool absent from it is not necessarily unrouted,
  // so asserting on absence here would produce false failures.
  const mismatches = [];
  for (const tool of TOOL_DEFINITIONS) {
    if (!tool.implemented || !tool.route || !tool.method) continue;
    const resolved = route(tool);
    if (resolved && resolved.toolId !== tool.id) {
      mismatches.push(`${tool.id} ${tool.method} ${tool.route} -> routed as ${resolved.toolId}`);
    }
  }
  assert.deepEqual(mismatches, [], `contract/route mismatches:\n${mismatches.join('\n')}`);
});

test('orchestrators can be listed, not just created', () => {
  // /api/health reports counts.orchestrators, but nothing could ENUMERATE them.
  // A cleanup sweep silently found nothing and reported "all clear" while five
  // lanes were still awaiting audit.
  const listed = toolLeaseRequirementForRoute('GET', parts('/api/orchestrators'));
  assert.ok(listed, 'GET /api/orchestrators must be routed');
  assert.equal(listed.toolId, 'orchestrator.list');

  const created = toolLeaseRequirementForRoute('POST', parts('/api/orchestrators'));
  assert.equal(created.toolId, 'orchestrator.register', 'POST must still register');

  assert.ok(toolById('orchestrator.list'), 'orchestrator.list must be in the contract');
});

test('lane.shutdown is declared at the route the server actually serves', () => {
  const tool = toolById('lane.shutdown');
  assert.ok(tool);
  assert.equal(route(tool)?.toolId, 'lane.shutdown');
});

test('audit.findings.record documents the verdict it requires', () => {
  // Posting findings without `verdict` is rejected, but the field was absent from
  // the summary, so an agent reading the contract could not discover it.
  const tool = toolById('audit.findings.record');
  assert.ok(tool);
  assert.match(tool.summary, /verdict/i);
  for (const value of ['accepted', 'fix_requested', 'blocked']) {
    assert.ok(tool.summary.includes(value), `summary must name the ${value} verdict`);
  }
});
