// Coverage for the code that STOPS a wedged real agent — previously untested.
//
// Why this matters more than most tests: if this path silently regresses (someone
// drops `detached: true`, or breaks the SIGTERM->SIGKILL escalation timer), "stop"
// appears to succeed while the CLI agent and its whole child fan-out keep running —
// burning the adopter's rate limit and money, invisibly, with CI still green. The
// only existing assertion was a smoke regex (/sigterm|sigkill|no_active_process/)
// that passes even if the stop did nothing at all.
//
// Covers: (1) SIGTERM-ignoring child escalates to SIGKILL, (2) the whole detached
// PROCESS GROUP dies, not just the direct child, (3) the stale-heartbeat reaper in
// tick() kills a silent lane and reports it as a failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutorAdapter } from '../src/executor-factory.js';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitFor = async (predicate, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
};

async function withAdapter(run, { heartbeatTimeoutMs } = {}) {
  const previousEnv = { ...process.env };
  const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-stop-reap-')));
  process.env.ORCA_ENABLE_CUSTOM_CLI = 'true';
  process.env.ORCA_CLI_BINARY = process.execPath;
  process.env.ORCA_CLI_ALLOWED_BINARIES = `${process.execPath},node`;
  process.env.ORCA_CLI_WORKDIR_ROOTS = tempDir;
  process.env.ORCA_CLI_ENV_WHITELIST = 'PATH,HOME,TMPDIR,LANG,LC_ALL,LC_CTYPE,USER,SHELL,TERM';
  process.env.ORCA_STOP_ESCALATE_MS = '150'; // keep the escalation ladder quick
  const events = { stopped: [], failed: [] };
  const adapter = createExecutorAdapter('cli', {
    defaultWorkingDir: tempDir,
    ...(heartbeatTimeoutMs ? { heartbeatTimeoutMs } : {}),
    onLog: async () => {},
    onComplete: async () => {},
    onFail: async (lane, reason, kind) => { events.failed.push({ laneId: lane.id, reason: String(reason || ''), kind }); },
    onStop: async (lane, context) => { events.stopped.push({ laneId: lane.id, context }); },
  });
  try {
    await run({ adapter, tempDir, events });
  } finally {
    try { await adapter.stopAll?.('test teardown'); } catch { /* best effort */ }
    Object.keys(process.env).forEach((k) => { if (!(k in previousEnv)) delete process.env[k]; });
    Object.entries(previousEnv).forEach(([k, v]) => { process.env[k] = v; });
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('stop actually kills an agent that ignores SIGTERM', async () => {
  await withAdapter(async ({ adapter, tempDir, events }) => {
    const lane = {
      id: 'lane-sigterm-ignorer',
      sessionId: 'sess',
      projectId: 'proj',
      workdir: tempDir,
      executorBinary: process.execPath,
      // Ignore SIGTERM outright, then idle. Only SIGKILL can end this.
      commandArgs: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    };
    const started = await adapter.start(lane);
    assert.equal(started.accepted, true, started.reason);
    const pid = lane.processMeta?.pid;
    assert.ok(Number.isInteger(pid), 'no pid recorded');
    assert.ok(await waitFor(() => alive(pid)), 'child never came up');

    const result = await adapter.stop(lane.id, { actor: 'test', reason: 'unit' });
    assert.equal(result.stopped, true);
    // THE regression guard: the agent must actually be gone. Which rung of the
    // ladder finished it (pty hangup / SIGTERM to the group / escalated SIGKILL)
    // is an implementation detail and varies by wrapper, so assert the outcome and
    // that a real kill was recorded — not one specific mechanism.
    assert.ok(await waitFor(() => !alive(pid)), 'child survived stop() — a wedged agent would keep burning tokens');
    assert.match(String(lane.processMeta.stopResult || ''), /sigterm|sigkill|sighup/,
      `stop recorded no kill: ${lane.processMeta.stopResult}`);
    assert.ok(events.stopped.some((e) => e.laneId === lane.id), 'onStop never fired');
  });
});

test('stop kills the whole detached process group, not just the direct child', async () => {
  await withAdapter(async ({ adapter, tempDir }) => {
    const marker = path.join(tempDir, 'grandchild-pid.txt');
    // The adapter caps individual argv length, so the fan-out script lives in a file
    // rather than an inline -e (a real agent shells out the same way).
    const scriptPath = path.join(tempDir, 'fanout.cjs');
    await fs.writeFile(scriptPath, [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(marker)}, String(kid.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');
    const lane = {
      id: 'lane-with-grandchild',
      sessionId: 'sess',
      projectId: 'proj',
      workdir: tempDir,
      executorBinary: process.execPath,
      // Spawn a grandchild (what a real agent does when it runs git / node / a
      // browser) and record its pid, so we can prove the GROUP died — not just the
      // process Orca directly spawned.
      commandArgs: [scriptPath],
    };
    const started = await adapter.start(lane);
    assert.equal(started.accepted, true, started.reason);
    const parentPid = lane.processMeta?.pid;

    assert.ok(await waitFor(async () => {
      try { return (await fs.readFile(marker, 'utf8')).trim().length > 0; } catch { return false; }
    }), 'grandchild never started');
    const grandchildPid = Number((await fs.readFile(marker, 'utf8')).trim());
    assert.ok(Number.isInteger(grandchildPid) && alive(grandchildPid), 'grandchild not running');

    await adapter.stop(lane.id, { actor: 'test', reason: 'unit' });
    assert.ok(await waitFor(() => !alive(parentPid)), 'parent survived stop()');
    // THE POINT: an orphaned grandchild is what actually keeps burning an adopter's
    // quota after they hit "stop" — the kill must target the process GROUP.
    assert.ok(await waitFor(() => !alive(grandchildPid)),
      'grandchild SURVIVED stop() — the process-group kill regressed');
  });
});

test('tick() reaps a lane whose agent went silent past the heartbeat timeout', async () => {
  await withAdapter(async ({ adapter, tempDir, events }) => {
    const lane = {
      id: 'lane-silent',
      sessionId: 'sess',
      projectId: 'proj',
      workdir: tempDir,
      executorBinary: process.execPath,
      // Produce nothing at all, forever: the stale-heartbeat reaper's target.
      commandArgs: ['-e', 'setInterval(() => {}, 1000);'],
    };
    const started = await adapter.start(lane);
    assert.equal(started.accepted, true, started.reason);
    const pid = lane.processMeta?.pid;
    assert.ok(await waitFor(() => alive(pid)), 'child never came up');

    // Let the (tiny) heartbeat window lapse, then run the scheduler tick.
    await new Promise((r) => setTimeout(r, 250));
    await adapter.tick();

    assert.ok(await waitFor(() => !alive(pid)), 'silent lane was not reaped — it would run forever');
    assert.ok(events.failed.some((e) => e.laneId === lane.id),
      'reaping a stale lane must surface as a failure, not silently vanish');
  }, { heartbeatTimeoutMs: 120 });
});
