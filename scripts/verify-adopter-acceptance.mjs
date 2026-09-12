#!/usr/bin/env node
// ADOPTER ACCEPTANCE — "clone it, run ONE documented command, get a working daemon."
//
// docs/adopter-acceptance.md is the same walkthrough for a person. This is the
// machine-runnable half, and it deliberately drives the CLI the way the README
// tells a reader to, rather than importing src/server.js and calling startServer:
// the first-run flow IS the CLI now (config file, fence, state directory,
// instance lock, detached daemon), and none of that is exercised by starting a
// server in-process.
//
// What it proves, in order:
//   1. `setup --roots … --connect claude` writes the config, starts the daemon,
//      and registers the MCP server at user scope — in ONE command.
//   2. `status` finds that daemon from a different directory, by its lock.
//   3. `connect` wired the client to THAT daemon, not to whatever holds :3000.
//   4. `doctor` reports on the daemon this installation manages.
//   5. the generated client config actually drives the loop: register a
//      orchestrator -> spawn a lane -> read its output -> audit it.
//   6. `stop` stops it, and `status` then says so.
//
// It is hermetic: a temp HOME, a temp state directory, a temp fence root and an
// ephemeral port. It never reads or writes the caller's ~/.claude.json,
// ~/.codex/, ~/Library, or any daemon it did not start.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoDir, 'src', 'orca-cli.js');

let failed = false;
const step = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-acceptance-')));
const home = path.join(root, 'home');
const stateDir = path.join(root, 'state');
const projects = path.join(home, 'code');
const workDir = path.join(projects, 'demo-project');
await fs.mkdir(workDir, { recursive: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(path.join(workDir, 'README.md'), '# demo\n');

const port = await freePort();
// A hermetic environment: no inherited Orca settings, no inherited HOME.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  PORT: String(port),
  ORCA_HOST: '127.0.0.1',
  ORCA_CREDENTIAL_BACKEND: 'memory',
  ORCA_RATE_LIMIT_DISABLED: 'true',
  ORCA_AUTO_COMPLETE_MS: '1200',
};

const runCli = (args, extra = {}) => {
  const res = spawnSync('node', [cli, ...args], {
    env: { ...env, ...extra },
    encoding: 'utf8',
    // Run from a directory that is NOT the checkout and NOT a fence root, so
    // nothing can pass by resolving something relative to the caller's cwd.
    cwd: root,
    timeout: 180000,
  });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
};

console.log(`[acceptance] temp root ${root}, port ${port}`);

try {
  // ---- 0. the install actually resolves -----------------------------------
  // `npm ci` reporting success is not the same as a usable dependency tree. A
  // linked worktree shares the primary checkout's node_modules through a
  // symlink, and that link can resolve into an empty loop (it did: a tracked
  // node_modules symlink, checked out in the checkout it points AT). Nearly
  // every suite here uses only Node built-ins, so the tree looks fine until one
  // file reaches @lydell/node-pty and fails to load. Check the real dependency
  // before anything else, so a broken install fails loudly and early.
  const deps = spawnSync(
    'node',
    ['-e', "require.resolve('@lydell/node-pty'); process.stdout.write('ok')"],
    { cwd: repoDir, encoding: 'utf8', timeout: 30000 },
  );
  step('runtime dependencies resolve from this checkout', deps.status === 0 && deps.stdout === 'ok',
    deps.status === 0 ? '@lydell/node-pty' : String(deps.stderr || '').split('\n')[0].slice(0, 120));
  if (deps.status !== 0) {
    console.log('\n[acceptance] the dependency tree is broken; run `npm ci` (or repair the node_modules symlink FROM the worktree) before trusting anything below.');
  }

  // ---- 1. the ONE documented command -------------------------------------
  const setup = runCli([
    'setup',
    '--roots', projects,
    '--state-dir', stateDir,
    '--connect', 'claude',
  ]);
  step('setup --roots … --connect claude exits 0', setup.code === 0, setup.code === 0 ? '' : setup.out.trim().split('\n').slice(-4).join(' | '));
  step('setup starts the daemon on the configured port', setup.out.includes(`127.0.0.1:${port}`), `expected :${port}`);
  step('setup records the fence it was given', setup.out.includes(projects));
  step('setup registers the MCP server at user scope', /Registered "orca" for Claude Code at user scope/.test(setup.out));

  // ---- 2. status finds it from anywhere, by its lock ----------------------
  const status = runCli(['status']);
  step('status finds the running daemon', status.code === 0 && /Orca is running/.test(status.out), status.out.trim().split('\n')[0]);
  step('status names the state directory it was given', status.out.includes(stateDir));

  // ---- 3. connect wired the client to THIS daemon -------------------------
  // The regression this guards: connect defaulted to a hardcoded
  // http://127.0.0.1:3000, so on a machine where another Orca answers there the
  // one documented command produced a config for the WRONG daemon — and the
  // bootstrap that issues it revokes that daemon's credential for the same actor.
  const clientConfig = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'));
  const orca = clientConfig?.mcpServers?.orca;
  step('the client config exists at user scope in this HOME', Boolean(orca));
  const advertised = String(orca?.env?.ORCA_AGENT_TOOLS_BASE_URL || '');
  step('the client config names the daemon setup started', advertised.replace(/\/$/, '') === `http://127.0.0.1:${port}`, advertised || '(missing)');
  step('the client config carries a refresh credential, never the API token', Boolean(orca?.env?.ORCA_REFRESH_TOKEN));
  step('the client config launches this checkout\'s bridge', String(orca?.args?.[0] || '').startsWith(repoDir), String(orca?.args?.[0] || '(missing)').replace(repoDir, '<repo>'));

  // ---- 4. doctor reports on the daemon this installation manages ----------
  const doctor = runCli(['doctor']);
  step('doctor exits 0 with nothing failing', doctor.code === 0 && /Nothing is failing/.test(doctor.out), doctor.out.trim().split('\n').slice(-1)[0]);
  step('doctor checked this installation\'s daemon', doctor.out.includes(`http://127.0.0.1:${port}`));
  step('doctor confirms the client points at the daemon this machine manages', /ok\s+target/.test(doctor.out));

  // ---- 5. the generated config actually drives the loop -------------------
  const bridge = spawn(orca.command, orca.args, {
    env: { ...env, ...orca.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  bridge.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch { /* not a JSON-RPC line */ }
    }
  });
  let nextId = 0;
  const rpc = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const text = res?.result?.content?.[0]?.text ?? '';
    try { return { ok: !res?.result?.isError, data: JSON.parse(text) }; } catch { return { ok: !res?.result?.isError, data: text }; }
  };

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'adopter-acceptance', version: '1' },
  });
  step('the bridge from that config handshakes', Boolean(init?.result?.serverInfo));

  const reg = await call('orchestrator__register', { body: { cwd: workDir, title: 'Acceptance', actor: 'claude' } });
  const orchestratorId = reg.data?.id;
  step('register an orchestrator inside the fence', Boolean(orchestratorId), orchestratorId || JSON.stringify(reg.data).slice(0, 140));

  const spawned = await call('executor__spawn', {
    orchestratorId,
    body: { title: 'Scout', executorType: 'mock', approved: true, taskPrompt: 'read the README' },
  });
  const laneId = spawned.data?.id;
  step('spawn a lane', Boolean(laneId), laneId || JSON.stringify(spawned.data).slice(0, 160));

  // The refusal an adopter meets first, and the one the tool description must
  // already have told them about.
  const unapproved = await call('executor__spawn', {
    orchestratorId,
    body: { title: 'Unapproved', executorType: 'mock', taskPrompt: 'no approval' },
  });
  step('a spawn without approved:true is refused, and says so',
    !unapproved.ok || unapproved.data?.requiresApproval === true,
    String(unapproved.data?.error || unapproved.data).slice(0, 90));

  let state = '';
  for (let i = 0; i < 60; i += 1) {
    const got = await call('lane__get', { laneId });
    state = got.data?.state || '';
    if (['done', 'ready_for_audit', 'accepted', 'failed'].includes(state)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  step('the lane reaches a terminal state', ['done', 'ready_for_audit', 'accepted'].includes(state), `state=${state}`);

  const tail = await call('lane__terminal__tail', { laneId });
  step('the lane output is readable', JSON.stringify(tail.data).length > 2);

  const audited = await call('audit__findings__record', {
    laneId,
    body: { actor: 'acceptance', verdict: 'accepted', reviewedFiles: ['README.md'], findings: [] },
  });
  step('audit the lane to a verdict', audited.ok, audited.ok ? 'accepted' : String(audited.data?.error || audited.data).slice(0, 110));

  bridge.kill();

  // ---- 6. stop ------------------------------------------------------------
  const stop = runCli(['stop']);
  step('stop stops the daemon', stop.code === 0 && /stopped/i.test(stop.out), stop.out.trim().split('\n')[0]);
  const after = runCli(['status']);
  step('status then reports it is not running', /is not running/.test(after.out));
} finally {
  // Best effort: never leave a daemon behind if a step threw.
  runCli(['stop', '--force']);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

console.log(`\n[acceptance] ${failed ? 'FAILED' : 'OK'} — one documented command gives a working daemon a client can drive.`);
if (failed) process.exit(1);
