import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRenderProjectOpen } from '../public/ui/home-disclosure.js';

// Guards the home-tree disclosure-persistence invariant: the 2s poll re-renders
// innerHTML, so open/closed state is recomputed from the operator's explicit
// collapses. Everything is open by default (a monitoring view); a project stays
// collapsed across polls only while the operator has it collapsed. New
// projects/agents that appear via a poll render open.

test('a project renders open by default (monitoring view)', () => {
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_a', collapsedPids: new Set() }), true);
});

test('a newly-appeared project (not previously seen) renders open', () => {
  const collapsedPids = new Set(['prj_b']); // only b was collapsed
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_new', collapsedPids }), true);
});

test('a project the operator collapsed stays collapsed across a poll re-render', () => {
  const collapsedPids = new Set(['prj_a']);
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_a', collapsedPids }), false);
});

test('collapsing every project keeps each one collapsed (no reopen)', () => {
  const collapsedPids = new Set(['prj_a', 'prj_b']);
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_a', collapsedPids }), false);
  assert.equal(shouldRenderProjectOpen({ pid: 'prj_b', collapsedPids }), false);
});
