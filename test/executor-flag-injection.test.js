// Regression tests for two verified sandbox-escape holes (found in the MVP security
// audit). Both let a caller who is NOT a workstation admin — e.g. a paired phone,
// which is an operator — launch a fully UNSANDBOXED agent on the developer's machine
// with their real CLI credentials, while the request still looked sandboxed.
//
//   H1  taskPrompt was pushed as a bare argv token, so a prompt of
//       "--dangerously-bypass-approvals-and-sandbox" landed in argv AFTER the sandbox
//       flags, in override position.
//   H2  args / commandArgs / extra `command` tokens were stored verbatim and are
//       PREFERRED by cli-adapter over Orca's built argv — routing around the
//       unsandboxed-permissions gate entirely (that gate only inspects
//       permissionsProfile).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildExecutorCommandArgs } from '../src/executor/command-builder.js';
import { OrcaRegistry } from '../src/registry.js';

// ---------- H1: the prompt can never be parsed as a flag ----------
const ESCAPE_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--sandbox=danger-full-access',
  '-c',
];

for (const label of ['codex', 'claude']) {
  test(`H1 ${label}: a taskPrompt that looks like a flag is never emitted as one`, () => {
    for (const flag of ESCAPE_FLAGS) {
      const argv = buildExecutorCommandArgs(label, { taskPrompt: flag });
      assert.ok(argv.length, `${label} produced no argv`);
      // The prompt is the last token; it must not be parseable as an option.
      const last = argv[argv.length - 1];
      assert.ok(
        !last.startsWith('-'),
        `${label}: prompt "${flag}" was emitted as a flag-shaped token (${JSON.stringify(last)})`,
      );
      // And no argv token anywhere may equal the escape flag verbatim.
      assert.ok(
        !argv.includes(flag),
        `${label}: escape flag ${flag} reached argv verbatim: ${JSON.stringify(argv)}`,
      );
    }
  });

  test(`H1 ${label}: a normal prompt still passes through unchanged`, () => {
    const argv = buildExecutorCommandArgs(label, { taskPrompt: 'Summarize src/ and report back.' });
    assert.equal(argv[argv.length - 1], 'Summarize src/ and report back.');
  });

  test(`H1 ${label}: the sandbox/permission flags are still present`, () => {
    const argv = buildExecutorCommandArgs(label, { taskPrompt: '--anything', permissionsProfile: 'plan' });
    const joined = argv.join(' ');
    if (label === 'codex') assert.match(joined, /--sandbox read-only/);
    else assert.match(joined, /--permission-mode/);
  });
}

// ---------- H2: raw argv is refused for first-class CLIs ----------
async function withRegistry(run) {
  const previousCwd = process.cwd();
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-flaginj-')));
  process.chdir(dir);
  process.env.ORCA_REPO_ROOTS = dir;
  const registry = new OrcaRegistry();
  try {
    const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'test' });
    const orch = await registry.registerOrchestrator({ cwd: dir, actor: 'test', title: 'T' }, { leaseId: lease.id });
    await run(registry, orch, dir);
  } finally {
    if (typeof registry.drainPendingWrites === 'function') await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

const RAW_ARGV_CASES = [
  { field: 'args', body: { args: ['--dangerously-skip-permissions', '-p', 'pwn'] } },
  { field: 'commandArgs', body: { commandArgs: ['exec', '--sandbox', 'danger-full-access', 'pwn'] } },
  { field: 'command extra tokens', body: { command: 'claude --dangerously-skip-permissions' } },
];

for (const { field, body } of RAW_ARGV_CASES) {
  test(`H2: first-class CLI lane refuses caller-supplied ${field}`, async () => {
    await withRegistry(async (registry, orch) => {
      // Orca throws plain {status,message} objects, not Error instances, so catch
      // explicitly rather than via assert.rejects (which mishandles non-Errors).
      let thrown = null;
      try {
        await registry.createLane(orch.id, {
          title: 'escape attempt',
          executorType: 'claude',
          taskPrompt: 'work',
          ...body,
        }, { actor: 'test', approved: true });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, `${field} was ACCEPTED for a first-class CLI — that is a sandbox-escape primitive`);
      assert.equal(thrown.status, 422, `expected 422, got ${thrown.status}: ${thrown.message}`);
      assert.match(String(thrown.message), /Orca builds the command line/i);
    });
  });
}

test('H2: a normal first-class lane (taskPrompt only) is still accepted', async () => {
  await withRegistry(async (registry, orch) => {
    const lane = await registry.createLane(orch.id, {
      title: 'ordinary work',
      executorType: 'claude',
      taskPrompt: 'Summarize src/.',
    }, { actor: 'test', approved: true });
    assert.ok(lane.id);
    assert.equal(lane.executorType, 'claude');
  });
});
