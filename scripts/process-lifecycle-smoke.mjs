#!/usr/bin/env node
/*
 * Command Deck process lifecycle smoke.
 *
 * Safe local process test for custom CLI provider execution: no shell,
 * validated binary/argv/workdir, stdout/stderr capture, process metadata,
 * clean success, and stop escalation metadata for a long-running child.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createExecutorAdapter } from '../src/executor-factory.js';

const log = (label, info = '') => console.log(`[process-lifecycle] ${label}${info ? ' — ' + info : ''}`);

const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-process-smoke-'));

function restoreEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in previousEnv)) delete process.env[key];
  });
  Object.entries(previousEnv).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
}

async function waitForProcessExit(child, timeoutMs = 5000) {
  if (!child) return;
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

try {
  process.env.COMMAND_DECK_ENABLE_CUSTOM_CLI = 'true';
  process.env.COMMAND_DECK_CLI_BINARY = process.execPath;
  process.env.COMMAND_DECK_CLI_ALLOWED_BINARIES = `${process.execPath},node`;
  process.env.COMMAND_DECK_CLI_WORKDIR_ROOTS = tempDir;
  process.env.COMMAND_DECK_CLI_ENV_WHITELIST = 'PATH,HOME,TMPDIR,LANG,LC_ALL,LC_CTYPE,USER,SHELL,TERM';
  process.env.COMMAND_DECK_STOP_ESCALATE_MS = '100';

  const logs = [];
  const completed = [];
  const failed = [];
  const stopped = [];
  const adapter = createExecutorAdapter('cli', {
    defaultWorkingDir: tempDir,
    onLog: async (_lane, message) => logs.push(String(message)),
    onComplete: async (lane) => completed.push(lane.id),
    onFail: async (lane, reason) => failed.push({ laneId: lane.id, reason }),
    onStop: async (lane, context) => stopped.push({ laneId: lane.id, context }),
  });

  const successLane = {
    id: 'process-success',
    sessionId: 'process-session',
    projectId: 'process-project',
    workdir: tempDir,
    executorBinary: process.execPath,
    commandArgs: ['--version'],
    env: {
      COMMAND_DECK_SAFE_SMOKE: '1',
      SHOULD_NOT_PASS: 'no',
    },
  };
  const success = await adapter.start(successLane);
  assert.equal(success.accepted, true, success.reason);
  await waitForProcessExit(success.runtime.process);
  assert.equal(successLane.processMeta.exitCode, 0);
  assert.equal(successLane.processMeta.binary, process.execPath);
  assert.deepEqual(successLane.processMeta.args, ['--version']);
  assert.equal(successLane.processMeta.cwd, tempDir);
  assert.equal(successLane.processMeta.envPolicy, 'allowlist');
  assert.equal(completed.includes(successLane.id), true);
  assert.equal(logs.some((item) => item.includes('adapter started')), true);

  const rejectedBinary = await adapter.start({
    id: 'process-reject-binary',
    sessionId: 'process-session',
    projectId: 'process-project',
    workdir: tempDir,
    executorBinary: '/bin/sh',
    commandArgs: ['-c', 'echo unsafe'],
  });
  assert.equal(rejectedBinary.accepted, false);
  assert.match(rejectedBinary.reason, /allowlist/i);

  const rejectedWorkdir = await adapter.start({
    id: 'process-reject-workdir',
    sessionId: 'process-session',
    projectId: 'process-project',
    workdir: os.tmpdir(),
    executorBinary: process.execPath,
    commandArgs: ['--version'],
  });
  assert.equal(rejectedWorkdir.accepted, false);
  assert.match(rejectedWorkdir.reason, /outside allowed execution roots/i);

  const longLane = {
    id: 'process-stop',
    sessionId: 'process-session',
    projectId: 'process-project',
    workdir: tempDir,
    executorBinary: process.execPath,
    commandArgs: ['-e', 'setTimeout(() => {}, 30000)'],
  };
  const longRun = await adapter.start(longLane);
  assert.equal(longRun.accepted, true, longRun.reason);
  assert.equal(typeof longLane.processMeta.pid, 'number');
  const stop = await adapter.stop(longLane.id, { actor: 'smoke', reason: 'process lifecycle smoke' });
  assert.equal(stop.stopped, true);
  assert.equal(stopped.some((item) => item.laneId === longLane.id), true);
  assert.equal(longLane.processMeta.stopRequestedBy, 'smoke');
  assert.match(longLane.processMeta.stopResult || '', /sigterm|sigkill|no_active_process/i);

  log('done', `success=${completed.length} failed=${failed.length} stopped=${stopped.length}`);
} finally {
  restoreEnv();
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}
