import assert from 'node:assert/strict';
import test from 'node:test';
import { renderLaneTree } from '../src/render-lane-tree.js';

test('render-lane-tree: draws a tree with connectors, states, and nested auditor', () => {
  const lanes = [
    { id: 'l1', title: 'Refactor cart totals', state: 'running', owner: 'executor', executorType: 'claude', model: 'sonnet', taskDescription: 'Extract tax calc', auditState: 'not_queued', branch: 'orca/lane-abc' },
    { id: 'l2', title: 'Wire payment webhook', state: 'ready_for_audit', owner: 'executor', executorType: 'codex', taskDescription: 'Stripe webhook', auditState: 'queued' },
    { id: 'a1', title: 'Audit · Wire payment webhook', state: 'auditing', owner: 'auditor', executorType: 'claude', auditTargetLaneId: 'l2' },
  ];
  const out = renderLaneTree({ name: 'Checkout revamp' }, lanes);
  assert.match(out, /Checkout revamp — 3 lanes/);
  assert.match(out, /├─/);
  assert.match(out, /└─/);
  assert.match(out, /Refactor cart totals {2}\[running\]/);
  assert.match(out, /claude · sonnet/);
  // auditor nests under its target, not as a top-level node.
  assert.match(out, /Audit · Wire payment webhook {2}\[auditing\] \(claude\)/);
  // top-level lane count is 2 (executors), auditor nested -> only 2 top connectors at col 0
  const topConnectors = out.split('\n').filter((line) => /^[├└]─ /.test(line));
  assert.equal(topConnectors.length, 2);
});

test('render-lane-tree: handles empty, long, and emoji content without throwing', () => {
  assert.match(renderLaneTree({ name: 'Empty' }, []), /no lanes yet/);
  const lanes = [{ id: 'x', title: '🚀'.repeat(80) + ' very long title that should be clipped', state: 'queued', owner: 'executor', executorType: 'mock', taskDescription: 'z'.repeat(500) }];
  const out = renderLaneTree({ name: 'Big' }, lanes);
  assert.match(out, /…/); // clipped
  assert.ok(out.split('\n').every((line) => Array.from(line).length < 120));
});

