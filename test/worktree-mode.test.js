import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorktreeMode, commandTargetsExecutorFirstToken } from '../src/registry-lane-config.js';

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

// commandTargetsExecutorFirstToken gates lane commands for first-class CLI
// executors: the command must actually start with a token that names that CLI
// (accounting for the binary alias, e.g. composer-cli -> cursor-agent). Used by
// firstClassCliTokenAllowed in src/registry-lane-create.js.
test('commandTargetsExecutorFirstToken: first token must name the target CLI', () => {
  // Direct name match.
  assert.equal(commandTargetsExecutorFirstToken('codex', ['codex']), true);
  assert.equal(commandTargetsExecutorFirstToken('claude', ['claude']), true);
  // Alias: composer-cli runs the `cursor-agent` binary.
  assert.equal(commandTargetsExecutorFirstToken('composer-cli', ['cursor-agent']), true);
  assert.equal(commandTargetsExecutorFirstToken('gemini-cli', ['gemini']), true);
  // A first token for a different tool is rejected.
  assert.equal(commandTargetsExecutorFirstToken('codex', ['claude']), false);
  assert.equal(commandTargetsExecutorFirstToken('claude', ['rm']), false);
  // Only the first token is inspected; later tokens are irrelevant here.
  assert.equal(commandTargetsExecutorFirstToken('codex', ['codex', 'exec', '--foo']), true);
  // Empty/degenerate inputs are permissive (validation happens elsewhere).
  assert.equal(commandTargetsExecutorFirstToken('codex', []), true);
  assert.equal(commandTargetsExecutorFirstToken('', ['anything']), true);
  assert.equal(commandTargetsExecutorFirstToken('codex', 'notarray'), false);
});
