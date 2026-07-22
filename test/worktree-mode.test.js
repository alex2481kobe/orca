import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorktreeMode } from '../src/registry-lane-config.js';

// resolveWorktreeMode is the pure policy that turns a (possibly 'auto') worktree
// request + the current situation into a concrete mode. These tests pin the exact
// branch table in src/registry-lane-config.js so the auto-isolation policy can't
// silently drift.

test('resolveWorktreeMode: auto read-only work never needs a worktree -> direct', () => {
  // Read-only lanes make no edits, so even in a git repo they run in the checkout.
  assert.equal(
    resolveWorktreeMode({ requested: 'auto', repoIsGit: true, isReadOnly: true }),
    'direct',
  );
});

test('resolveWorktreeMode: auto in a non-git folder -> direct', () => {
  // No working tree to branch a worktree from, so auto degrades to direct.
  assert.equal(
    resolveWorktreeMode({ requested: 'auto', repoIsGit: false }),
    'direct',
  );
});

test('resolveWorktreeMode: auto sole writer edits the checkout in place -> direct', () => {
  // A single writer with no other active writers can safely edit the repo root.
  assert.equal(
    resolveWorktreeMode({
      requested: 'auto',
      repoIsGit: true,
      isReadOnly: false,
      activeWriterLanes: 0,
    }),
    'direct',
  );
});

test('resolveWorktreeMode: auto with an overlapping writer -> isolated', () => {
  // Once writers overlap, each writer needs its own worktree to avoid stepping
  // on the other's edits.
  assert.equal(
    resolveWorktreeMode({
      requested: 'auto',
      repoIsGit: true,
      isReadOnly: false,
      activeWriterLanes: 1,
    }),
    'isolated',
  );
});

test('resolveWorktreeMode: explicit modes are honored (isolated degrades on non-git)', () => {
  // Explicit 'isolated' truly needs a git working tree; on a non-git folder it
  // degrades to direct (there is nothing to branch a worktree from).
  assert.equal(
    resolveWorktreeMode({ requested: 'isolated', repoIsGit: false }),
    'direct',
  );
  // Explicit 'shared' just runs in the folder, so it applies even on non-git.
  assert.equal(
    resolveWorktreeMode({ requested: 'shared', repoIsGit: false }),
    'shared',
  );
  // Explicit 'direct' is always honored.
  assert.equal(
    resolveWorktreeMode({ requested: 'direct', repoIsGit: true, activeWriterLanes: 5 }),
    'direct',
  );
  // Explicit 'isolated' on a git repo is honored (not degraded).
  assert.equal(
    resolveWorktreeMode({ requested: 'isolated', repoIsGit: true }),
    'isolated',
  );
});
