// Stage 4 security: a LaunchAgent must never hold the API token, and the loopback
// admin policy (no token = every local process is admin) is unchanged. So the
// daemon also takes its token from ORCA_API_TOKEN_FILE, an owner-only file the
// plist can name. A token file that is set but unusable refuses the start: it
// must never degrade into tokenless, loopback-is-admin mode.
//
// Daemons run on temp state (ORCA_STATE_DIR pinned), a temp HOME and free ports.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ROOT, cleanChildEnv, freePort } from './helpers/bridge-client.js';

const SERVER = path.join(ROOT, 'src', 'server.js');
const CLI = path.join(ROOT, 'src', 'orca-cli.js');
const TOKEN = 'token-file-test-0123456789abcdef';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(label) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `orca-token-${label}-`)));
  const dirs = { tmp, home: path.join(tmp, 'home'), project: path.join(tmp, 'project'), state: path.join(tmp, 'state'), token: path.join(tmp, 'api-token') };
  await fs.mkdir(dirs.home);
  await fs.mkdir(dirs.project);
  await fs.writeFile(dirs.token, `${TOKEN}\n`, { mode: 0o600 });
  return dirs;
}

function env(dirs, extra = {}) {
  const value = {
    ...cleanChildEnv(),
    HOME: dirs.home,
    ORCA_STATE_DIR: dirs.state,
    ORCA_REPO_ROOTS: dirs.project,
    ORCA_AUTO_AUDIT: 'false',
    ORCA_RATE_LIMIT_DISABLED: 'true',
    ORCA_CREDENTIAL_BACKEND: 'memory',
    ...extra,
  };
  delete value.XDG_CONFIG_HOME;
  delete value.XDG_STATE_HOME;
  return value;
}

function startDaemon(childEnv) {
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

async function waitListening(daemon, port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.output().includes(`Orca listening at http://127.0.0.1:${port}`)) return;
    if (daemon.child.exitCode !== null) throw new Error(`daemon exited:\n${daemon.output()}`);
    await sleep(50);
  }
  throw new Error(`daemon did not listen:\n${daemon.output()}`);
}

function runCli(args, childEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr, all: `${stdout}\n${stderr}` }));
  });
}

test('the daemon takes its API token from ORCA_API_TOKEN_FILE: loopback is no longer admin without it', { timeout: 60_000 }, async () => {
  const dirs = await fixture('daemon');
  const port = await freePort();
  const daemon = startDaemon(env(dirs, { PORT: String(port), ORCA_HOST: '127.0.0.1', ORCA_API_TOKEN_FILE: dirs.token }));
  try {
    await waitListening(daemon, port);
    const base = `http://127.0.0.1:${port}`;
    const anonymous = await fetch(`${base}/api/overview`);
    assert.equal(anonymous.status, 401, 'a loopback caller without the token is refused');
    const authed = await fetch(`${base}/api/overview`, { headers: { 'x-orca-token': TOKEN } });
    assert.equal(authed.status, 200);
    assert.equal(daemon.output().includes(TOKEN), false, 'the daemon never prints the token');
    assert.equal(daemon.output().includes('ORCA_API_TOKEN is not set'), false, 'no tokenless warning');
  } finally {
    daemon.child.kill('SIGTERM');
    await daemon.exited;
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('an unusable token file refuses the start instead of running without a token', { timeout: 60_000 }, async () => {
  const dirs = await fixture('refuse');
  try {
    const open = path.join(dirs.tmp, 'open-token');
    await fs.writeFile(open, `${TOKEN}\n`, { mode: 0o644 });
    await fs.chmod(open, 0o644);
    const empty = path.join(dirs.tmp, 'empty-token');
    await fs.writeFile(empty, '\n', { mode: 0o600 });
    for (const [file, why] of [
      [open, /can be read by other users/],
      [empty, /is empty/],
      [path.join(dirs.tmp, 'missing'), /does not exist/],
      ['relative/token', /absolute path/],
    ]) {
      const port = await freePort();
      const daemon = startDaemon(env(dirs, { PORT: String(port), ORCA_HOST: '127.0.0.1', ORCA_API_TOKEN_FILE: file }));
      const code = await Promise.race([daemon.exited, sleep(15_000).then(() => 'still running')]);
      if (code === 'still running') daemon.child.kill('SIGTERM');
      assert.equal(code, 1, `${file}: ${daemon.output()}`);
      assert.match(daemon.output(), why);
      assert.match(daemon.output(), /Refusing to start/);
      assert.equal(daemon.output().includes(TOKEN), false, 'the refusal never prints the token');
      assert.equal(fsSync.existsSync(path.join(dirs.state, 'daemon.lock')), false, 'nothing was locked or opened');
    }
  } finally {
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('service install names the token file in the plist, never the token; the lifecycle commands authenticate with it', { timeout: 120_000 }, async () => {
  const dirs = await fixture('cli');
  const port = await freePort();
  const childEnv = env(dirs, { PORT: String(port), ORCA_API_TOKEN_FILE: dirs.token });
  try {
    let run = await runCli(['service', 'install', '--dry-run', '--token-file', dirs.token], childEnv);
    assert.equal(run.code, 0, run.all);
    assert.ok(run.stdout.includes(`<key>ORCA_API_TOKEN_FILE</key>\n    <string>${dirs.token}</string>`), run.stdout);
    assert.equal(run.all.includes(TOKEN), false, 'the plist and the output never contain the token');

    const open = path.join(dirs.tmp, 'open-token');
    await fs.writeFile(open, `${TOKEN}\n`, { mode: 0o644 });
    await fs.chmod(open, 0o644);
    run = await runCli(['service', 'install', '--dry-run', '--token-file', open], childEnv);
    assert.equal(run.code, 2, run.all);
    assert.match(run.stderr, /can be read by other users/);

    // The daemon started with the token file; stop reads the same file to check
    // for running executors, so it needs no ORCA_API_TOKEN in its environment.
    run = await runCli(['start', '--wait', '30'], childEnv);
    assert.equal(run.code, 0, run.all);
    assert.equal(run.stdout.includes('Recommended: set an API token'), false, 'a token file satisfies the recommendation');
    run = await runCli(['stop'], childEnv);
    assert.equal(run.code, 0, run.all);
    assert.equal(run.all.includes(TOKEN), false);
  } finally {
    if (fsSync.existsSync(path.join(dirs.state, 'daemon.lock'))) await runCli(['stop', '--force'], childEnv);
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('resolveApiToken: ORCA_API_TOKEN wins; the file must be absolute, owner-only and non-empty', async () => {
  const { resolveApiToken } = await import('../src/api-token.js');
  const dirs = await fixture('unit');
  try {
    assert.deepEqual(resolveApiToken({}), { token: '', source: null, error: null });
    assert.equal(resolveApiToken({ ORCA_API_TOKEN: 'env', ORCA_API_TOKEN_FILE: dirs.token }).token, 'env');
    assert.deepEqual(resolveApiToken({ ORCA_API_TOKEN_FILE: dirs.token }), { token: TOKEN, source: 'ORCA_API_TOKEN_FILE', error: null });
    assert.match(resolveApiToken({ ORCA_API_TOKEN_FILE: 'relative' }).error, /absolute path/);
    assert.equal(resolveApiToken({ ORCA_API_TOKEN_FILE: dirs.tmp }).error.includes('not a regular file'), true);
  } finally {
    await fs.rm(dirs.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
