// Lane 4 hardening: prompt no longer silently truncated at 4096, and the
// boot-time orphan reap refuses to kill a reused / non-executor pid.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { buildExecutorCommandArgs } from '../src/executor/command-builder.js';
import { lifecycleMethods } from '../src/registry-lifecycle.js';

test('a scope-controlled prompt over 4096 chars is passed to the CLI intact', () => {
  const bigPrompt = 'Edit ONLY these files: '
    + Array.from({ length: 400 }, (_, i) => `src/module-${i}.js`).join(', ')
    + '. Do NOT read docs/.';
  assert.ok(bigPrompt.length > 4096, 'fixture must exceed the old cap');
  for (const label of ['claude', 'codex']) {
    const args = buildExecutorCommandArgs(label, { taskPrompt: bigPrompt, permissionsProfile: 'plan' }, {});
    const joined = args.join(' ');
    assert.ok(joined.includes('src/module-399.js'), `${label}: prompt tail must survive`);
    assert.ok(joined.includes('Do NOT read docs/'), `${label}: prompt end must survive`);
  }
});

test('the orphan reap refuses to kill a non-executor / reused pid', () => {
  const reg = Object.assign({}, lifecycleMethods);
  // This node process is alive but is NOT a codex/claude/gemini executor.
  assert.equal(reg._reapOrphanedLaneProcess({ processMeta: { pid: process.pid } }), false);
  assert.ok(!process.killed, 'the reap must not have touched this process');
  // A dead/bogus pid is a no-op.
  assert.equal(reg._reapOrphanedLaneProcess({ processMeta: { pid: 2147480000 } }), false);
  // Missing processMeta is a safe no-op.
  assert.equal(reg._reapOrphanedLaneProcess({}), false);
});

test('the orphan reap leaves a live non-executor process (sleep) alone', async () => {
  const reg = Object.assign({}, lifecycleMethods);
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  try {
    assert.equal(reg._reapOrphanedLaneProcess({ processMeta: { pid: child.pid } }), false, 'sleep is not an executor — must not be reaped');
    assert.ok(!child.killed, 'the sleep process must still be alive');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* cleanup */ }
    try { child.kill('SIGKILL'); } catch { /* cleanup */ }
  }
});
