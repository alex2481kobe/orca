import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(here, '..', 'src', 'registry.js');

// Regression guard: constructing an OrcaRegistry starts the scheduler loop. That
// loop must NOT keep the Node process alive on its own (its heartbeat timer is
// unref'd) — otherwise every bare `import('./src/server.js')` load-check leaks a
// zombie process that never exits. A real server stays alive via its listening
// socket, not the scheduler timer. Here we construct a registry and assert the
// process still exits promptly without calling stopScheduler().
test('constructing the registry does not keep the process alive (scheduler timer is unref-ed)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-leak-'));
  const code = `import(${JSON.stringify(registryPath)}).then((m) => { const r = new m.OrcaRegistry(); void r; });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: tempDir,
    stdio: 'ignore',
  });

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 8000);
    child.on('exit', () => { clearTimeout(timer); resolve(true); });
  });

  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  assert.equal(exited, true, 'registry process should exit on its own within 8s; the scheduler timer must be unref-ed');
});
