import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

// Regression: a chat/lane that runs in a session's vetted repoRoot (an approved
// ORCA_REPO_ROOTS path that is NOT under the server's cwd) must be allowed to
// launch. The bug surfaced remotely as "failed to launch codex adapter: workdir
// is outside allowed execution roots" because the executor's allowed EXECUTION
// roots defaulted to [process.cwd()] only, ignoring the approved repo roots.
test('executor allowed roots include the approved repo roots (no WORKDIR_ROOTS env)', async () => {
  const prevCwd = process.cwd();
  const prevRepoRoots = process.env.ORCA_REPO_ROOTS;
  const prevCodexRoots = process.env.ORCA_CODEX_WORKDIR_ROOTS;
  const cwdDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-cwd-'));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-proj-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-outside-'));
  process.chdir(cwdDir);
  process.env.ORCA_REPO_ROOTS = projectDir;        // the user's project folder
  delete process.env.ORCA_CODEX_WORKDIR_ROOTS;     // the real deployment doesn't set this
  const registry = new OrcaRegistry({ autoAudit: false });
  registry.stopScheduler();
  try {
    const adapter = registry.getExecutorForType('codex');
    // A lane in the approved repoRoot resolves (was throwing before the fix).
    const resolved = await adapter._resolveWorkdir(projectDir);
    assert.equal(path.resolve(resolved), path.resolve(projectDir));
    // A path outside every approved root is still rejected (defense intact).
    await assert.rejects(
      () => adapter._resolveWorkdir(outsideDir),
      /outside allowed execution roots/,
    );
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    process.chdir(prevCwd);
    if (prevRepoRoots === undefined) delete process.env.ORCA_REPO_ROOTS; else process.env.ORCA_REPO_ROOTS = prevRepoRoots;
    if (prevCodexRoots !== undefined) process.env.ORCA_CODEX_WORKDIR_ROOTS = prevCodexRoots;
    await fs.rm(cwdDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});
