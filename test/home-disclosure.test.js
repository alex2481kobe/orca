import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRenderProjectOpen } from '../public/ui/home-disclosure.js';

// Guards the home-tree disclosure-persistence invariant: the 2s poll re-renders
// innerHTML, so open/closed state must be recomputed from the pre-render open
// set without a background refresh silently reopening what the operator closed.
// Re-points the coverage previously in the removed disclosure-persistence smoke.

test('fresh entry (nav / first paint) renders every project open', () => {
  const wasOpen = new Set();
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_a', wasOpen, freshEntry: true, hasSelection: false }), true);
});

test('poll refresh preserves a project the operator left open', () => {
  const wasOpen = new Set(['prj_a']);
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_a', wasOpen, freshEntry: false, hasSelection: false }), true);
});

test('poll refresh keeps a project the operator collapsed collapsed', () => {
  const wasOpen = new Set(['prj_b']); // a is closed, b is open
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_a', wasOpen, freshEntry: false, hasSelection: false }), false);
});

test('poll refresh does NOT reopen everything after the last project is collapsed', () => {
  // The regression: an empty open-set on a poll refresh must stay empty, not
  // fall back to "open all" (which made collapsing the final card pop it back open).
  const wasOpen = new Set();
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_a', wasOpen, freshEntry: false, hasSelection: false }), false);
});

test('a drilled-in (selected) project always renders open', () => {
  const wasOpen = new Set();
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_a', wasOpen, freshEntry: false, hasSelection: true }), true);
});
