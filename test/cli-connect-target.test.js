// `connect` and `doctor` must reach the daemon THIS installation owns.
//
// They used to default to DEFAULT_BASE_URL (http://127.0.0.1:3000). On a machine
// where any other Orca answers on that port, the documented one command
//
//   orca-cli.js setup --roots <dir> --state-dir <dir> --connect claude
//
// started a daemon on the configured port and then handed the client a config
// naming the OTHER daemon, and the other daemon's checkout. The bootstrap that
// issues that config revokes the previous credential for the same actor, so
// setting up one installation broke the already-connected clients of another.
// `doctor` then reported that other daemon as healthy and printed "Nothing is
// failing" — a true answer to the wrong question.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveDaemonUrl } from '../src/cli-lifecycle.js';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoDir, 'src', 'orca-cli.js');

const runCli = (args, env) => new Promise((resolve) => {
  const child = spawn('node', [cli, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.once('exit', (code) => resolve({ code, stdout, stderr }));
});

test('resolveDaemonUrl prefers an explicit --url, then the configured port, over the hardcoded default', () => {
  const explicit = resolveDaemonUrl({ url: 'http://127.0.0.1:4321/' }, { env: {}, home: os.tmpdir() });
  assert.equal(explicit.url, 'http://127.0.0.1:4321');
  assert.equal(explicit.source, '--url');

  // No daemon running: the answer is the port this installation would start on,
  // taken from its own environment — never a fixed 3000.
  const configured = resolveDaemonUrl({}, { env: { PORT: '45999' }, home: os.tmpdir() });
  assert.equal(configured.url, 'http://127.0.0.1:45999');
  assert.equal(configured.running, false);
  assert.notEqual(configured.url, 'http://127.0.0.1:3000');
});

test('connect targets the daemon holding this installation\'s state directory, not the default port', async () => {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-connect-target-')));
  const home = path.join(tmp, 'home');
  const stateDir = path.join(tmp, 'state');
  const roots = path.join(tmp, 'code');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(roots, { recursive: true });

  const daemon = spawn('node', [path.join(repoDir, 'src', 'server.js')], {
    env: {
      ...process.env,
      HOME: home,
      PORT: '0',
      ORCA_HOST: '127.0.0.1',
      ORCA_STATE_DIR: stateDir,
      ORCA_REPO_ROOTS: roots,
      ORCA_CREDENTIAL_BACKEND: 'memory',
      ORCA_RATE_LIMIT_DISABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`daemon did not report a URL:\n${out}`)), 30000);
      const scan = (chunk) => {
        out += chunk;
        const found = out.match(/listening at (http:\/\/\S+)/i);
        if (found) { clearTimeout(timer); resolve(found[1].replace(/\/$/, '')); }
      };
      daemon.stdout.on('data', scan);
      daemon.stderr.on('data', scan);
      daemon.once('exit', (code) => { clearTimeout(timer); reject(new Error(`daemon exited with ${code}:\n${out}`)); });
    });
    const port = new URL(baseUrl).port;
    assert.notEqual(port, '3000', 'this test is meaningless if the daemon happens to bind the default port');

    // The environment a `connect` run inherits from `setup` carries the state
    // directory, and nothing else that names the port.
    const env = { HOME: home, ORCA_STATE_DIR: stateDir, ORCA_AGENT_TOOLS_BASE_URL: '', ORCA_API_TOKEN: '' };

    const resolved = resolveDaemonUrl({}, { env: { ...env }, home });
    assert.equal(resolved.url, baseUrl, 'resolveDaemonUrl must find the daemon through the state directory lock');
    assert.equal(resolved.running, true);

    const printed = await runCli(['connect', 'claude', '--print'], env);
    assert.equal(printed.code, 0, `connect --print failed: ${printed.stderr}`);
    assert.match(
      printed.stdout,
      new RegExp(`127\\.0\\.0\\.1:${port}`),
      `the client config must name the daemon this installation owns (:${port}), not the default port — got:\n${printed.stdout}`,
    );
    assert.doesNotMatch(
      printed.stdout,
      /127\.0\.0\.1:3000/,
      'the client config must not name the hardcoded default port',
    );
  } finally {
    daemon.kill();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
