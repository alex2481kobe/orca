// Stage 5 requirement 6: one read-only `doctor` command. It checks the daemon is
// reachable, the client credential is valid, the MCP server is registered at user
// scope, the launcher Node is valid and the fence is configured -- and every
// failed check prints its fix. It must change nothing, anywhere.
//
// The daemon runs in-process on temp state; the doctor runs as a child process
// with a temp HOME, so it only ever reads the fixture client config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { ROOT, cleanChildEnv, freePort } from './helpers/bridge-client.js';

const CLI = path.join(ROOT, 'src', 'orca-cli.js');
const ADMIN = 'doctor-admin-token';

function runCli(args, { home, cwd, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...cleanChildEnv(), HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function doctor(ctx) {
  const run = await runCli(['doctor', '--json', ...(ctx.args || [])], ctx);
  let report = null;
  try { report = JSON.parse(run.stdout); } catch { /* asserted below */ }
  assert.ok(report, `doctor --json printed no JSON (exit ${run.code}):\n${run.stdout}\n${run.stderr}`);
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  return { ...run, report, byId };
}

const sha256 = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

let importCounter = 0;
async function withDoctorFixture(fn) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-doctor-')));
  const work = path.join(tmp, 'work');
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  await Promise.all([work, home, project].map((dir) => fs.mkdir(dir)));
  process.chdir(work);
  Object.assign(process.env, {
    ORCA_API_TOKEN: ADMIN,
    ORCA_AUTO_AUDIT: 'false',
    ORCA_RATE_LIMIT_DISABLED: 'true',
    ORCA_REPO_ROOTS: work,
    PORT: '0',
    ORCA_HOST: '127.0.0.1',
  });
  const moduleUrl = `${pathToFileURL(path.join(ROOT, 'src', 'server.js')).href}?doctor=${Date.now()}-${++importCounter}`;
  const { startServer, stopServer } = await import(moduleUrl);
  const server = await startServer(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = async (method, route, body) => {
    const init = { method, headers: { 'x-orca-token': ADMIN, accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${route}`, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const claudeJson = path.join(home, '.claude.json');
  const writeClaude = (value) => fs.writeFile(claudeJson, `${JSON.stringify(value, null, 2)}\n`);
  try {
    const boot = await admin('POST', '/api/mcp/orchestrator-bootstrap', { actor: 'doctor-test' });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const entry = { type: 'stdio', ...boot.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca };
    await fn({ base, admin, boot: boot.body, entry, home, project, claudeJson, writeClaude, ctx: { home, cwd: project } });
  } finally {
    await stopServer();
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    process.chdir(previousCwd);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('R6: doctor passes on a healthy install, prints no credential, and changes nothing', async () => {
  await withDoctorFixture(async ({ admin, entry, claudeJson, writeClaude, ctx }) => {
    await writeClaude({ numStartups: 3, mcpServers: { orca: entry } });
    const configBefore = await sha256(claudeJson);
    const leasesBefore = (await admin('GET', '/api/agent-tools/leases?activeOnly=false')).body;

    const run = await doctor(ctx);
    assert.equal(run.code, 0, run.stdout);
    for (const id of ['daemon', 'registration', 'launcher', 'credential', 'fence']) {
      assert.ok(run.byId[id], `doctor has a "${id}" check`);
      assert.notEqual(run.byId[id].status, 'fail', `${id}: ${JSON.stringify(run.byId[id])}`);
    }
    assert.equal(run.byId.daemon.status, 'pass');
    assert.equal(run.byId.credential.status, 'pass');
    assert.equal(run.byId.registration.status, 'pass');

    const secrets = Object.entries(entry.env).filter(([key]) => /TOKEN/.test(key)).map(([, value]) => value);
    for (const secret of [...secrets, ADMIN]) {
      assert.equal(run.stdout.includes(secret) || run.stderr.includes(secret), false, 'doctor must never print a credential');
    }
    assert.equal(await sha256(claudeJson), configBefore, 'doctor must not write the client config');
    assert.deepEqual((await admin('GET', '/api/agent-tools/leases?activeOnly=false')).body, leasesBefore,
      'doctor must not mint, renew or touch any lease or credential');

    const human = await runCli(['doctor'], ctx);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /daemon/);
  });
});

test('R6: every failed check prints its fix', async () => {
  await withDoctorFixture(async ({ admin, boot, entry, project, writeClaude, ctx }) => {
    const assertFix = (check, pattern) => {
      assert.ok(check, 'check is present');
      assert.ok(['fail', 'warn'].includes(check.status), JSON.stringify(check));
      assert.match(String(check.fix || ''), pattern, JSON.stringify(check));
    };

    await writeClaude({ mcpServers: {} });
    let run = await doctor(ctx);
    assert.equal(run.code, 1);
    assertFix(run.byId.registration, /connect claude/);

    const closed = `http://127.0.0.1:${await freePort()}`;
    await writeClaude({ mcpServers: { orca: { ...entry, env: { ...entry.env, ORCA_AGENT_TOOLS_BASE_URL: closed } } } });
    run = await doctor(ctx);
    assert.equal(run.byId.daemon.status, 'fail');
    assert.ok(run.byId.daemon.summary.includes(closed), run.byId.daemon.summary);
    assertFix(run.byId.daemon, /orca-cli\.js'? start/);

    await writeClaude({ mcpServers: { orca: { ...entry, command: '/nonexistent/bin/node' } } });
    run = await doctor(ctx);
    assert.equal(run.byId.launcher.status, 'fail');
    assertFix(run.byId.launcher, /connect claude/);

    await writeClaude({ mcpServers: { orca: entry }, projects: { [project]: { mcpServers: { orca: { command: 'node', args: ['/old/orca/src/mcp-server.js'] } } } } });
    run = await doctor(ctx);
    assertFix(run.byId.registration, /claude mcp remove orca -s local/);

    delete process.env.ORCA_REPO_ROOTS;
    await writeClaude({ mcpServers: { orca: entry } });
    run = await doctor(ctx);
    assert.equal(run.byId.fence.status, 'fail', 'no roots means setup-required: nothing can launch');
    assertFix(run.byId.fence, /setup --roots/);
    process.env.ORCA_REPO_ROOTS = process.cwd();

    // The shape of the entry on a workstation set up before refresh credentials: a
    // fixed lease, and a Node inside Codex's private directory.
    const codexNode = path.join(ctx.home, '.codex', 'fnm', 'aliases', 'default', 'bin', 'node');
    await fs.mkdir(path.dirname(codexNode), { recursive: true });
    await fs.symlink(process.execPath, codexNode);
    await writeClaude({
      mcpServers: {
        orca: {
          type: 'stdio',
          command: codexNode,
          args: entry.args,
          env: { ORCA_AGENT_TOOLS_BASE_URL: entry.env.ORCA_AGENT_TOOLS_BASE_URL, ORCA_ROLE: 'orchestrator', ORCA_TOOL_LEASE_TOKEN: boot.leaseToken },
        },
      },
    });
    run = await doctor(ctx);
    assert.equal(run.byId.launcher.status, 'warn', JSON.stringify(run.byId.launcher));
    assert.match(run.byId.launcher.summary, /Codex/);
    assert.equal(run.byId.credential.status, 'warn', JSON.stringify(run.byId.credential));
    assertFix(run.byId.credential, /connect claude/);

    assert.equal((await admin('DELETE', `/api/agent-tools/leases/${boot.credential.id}`)).status, 200);
    await writeClaude({ mcpServers: { orca: entry } });
    run = await doctor(ctx);
    assert.equal(run.code, 1);
    assert.equal(run.byId.credential.status, 'fail');
    assertFix(run.byId.credential, /connect claude/);
  });
});

test('connect: one command registers a refresh-credential config at user scope through the client CLI', async () => {
  await withDoctorFixture(async ({ base, home, writeClaude, ctx }) => {
    const bin = path.join(home, 'fake-bin');
    const log = path.join(home, 'fake-claude.log');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "---" "$@" >> "$FAKE_CLAUDE_LOG"\n', { mode: 0o755 });
    // Only the fake claude is reachable on this PATH, never a real one.
    const env = { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), FAKE_CLAUDE_LOG: log };

    const refused = await runCli(['connect', 'claude', '--url', base], { ...ctx, env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /ORCA_API_TOKEN/, 'an Orca with an API token needs it for setup, and says so');

    const run = await runCli(['connect', 'claude', '--url', base], { ...ctx, env: { ...env, ORCA_API_TOKEN: ADMIN } });
    assert.equal(run.code, 0, run.stderr);
    const calls = (await fs.readFile(log, 'utf8')).split('---\n').filter(Boolean).map((chunk) => chunk.trimEnd().split('\n'));
    assert.deepEqual(calls[0], ['mcp', 'remove', 'orca', '-s', 'user']);
    const add = calls[1];
    assert.deepEqual(add.slice(0, 6), ['mcp', 'add', '-s', 'user', 'orca', '-e']);
    const refreshArg = add.find((arg) => arg.startsWith('ORCA_REFRESH_TOKEN='));
    assert.ok(refreshArg, add.join(' '));
    assert.ok(add.includes(`ORCA_AGENT_TOOLS_BASE_URL=${base}`));
    assert.equal(add.some((arg) => arg.startsWith('ORCA_TOOL_LEASE_TOKEN=')), false, 'no lease in the config');
    assert.equal(add.some((arg) => arg.includes(ADMIN)), false, 'never the admin token');
    assert.equal(add.at(-1), path.join(ROOT, 'src', 'mcp-server.js'));
    assert.equal(run.stdout.includes(refreshArg.slice('ORCA_REFRESH_TOKEN='.length)), false, 'connect never prints the credential');
    assert.match(run.stdout, /Restart your Claude Code sessions/);

    // What it registered is a working config: doctor passes its credential.
    const dash = add.indexOf('--');
    const pairs = [];
    for (let index = 5; index < dash; index += 2) pairs.push(add[index + 1].split(/=(.*)/s).slice(0, 2));
    await writeClaude({ mcpServers: { orca: { type: 'stdio', command: add[dash + 1], args: add.slice(dash + 2), env: Object.fromEntries(pairs) } } });
    const checked = await doctor(ctx);
    assert.equal(checked.byId.credential.status, 'pass', JSON.stringify(checked.byId.credential));
  });
});

test('connect: a stopped daemon says where it looked and how to start it', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-connect-down-')));
  try {
    const closed = `http://127.0.0.1:${await freePort()}`;
    const run = await runCli(['connect', 'claude', '--url', closed], { home, cwd: home });
    assert.equal(run.code, 1);
    assert.ok(run.stderr.includes(closed), run.stderr);
    assert.match(run.stderr, /Fix: .*orca-cli\.js'? start/);
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

// ---- the toolchain Orca does not own -------------------------------------------
//
// `connect` and `service install` write a Node path into files Orca does not own:
// a client's MCP config, and a LaunchAgent that starts Orca at every login. On
// this workstation the Node that would be written lives inside ~/.codex — Codex's
// private directory, which Codex may upgrade or delete without telling anyone.
// Orca does not install or manage a toolchain. What it must do instead is say so
// before it writes the path down, in every place that would write it.

test('doctor names a Node that belongs to another tool, before connect or service install writes it down', async () => {
  await withDoctorFixture(async ({ entry, writeClaude, ctx, home }) => {
    await writeClaude({ mcpServers: { orca: entry } });

    // The Node the operator is about to hand to connect: inside Codex's directory.
    const foreign = path.join(home, '.codex', 'fnm', 'node-versions', 'v24.14.1', 'bin', 'node');
    const warned = await doctor({ ...ctx, args: ['--node', foreign] });
    const check = warned.byId.node;
    assert.ok(check, 'doctor has a "node" check');
    assert.equal(check.status, 'warn', JSON.stringify(check));
    assert.match(check.summary, /Codex's private directory/, JSON.stringify(check));
    assert.match(check.summary, /one installed Node version \(v24\.14\.1\)/, 'it also names the version pin');
    // It must say what actually breaks: the files Orca writes, not Orca itself.
    assert.match(check.summary, /LaunchAgent that starts Orca at every login/, JSON.stringify(check));
    assert.match(String(check.fix), /connect .*--node/, JSON.stringify(check));
    assert.match(String(check.fix), /service install --node/, JSON.stringify(check));

    // A Node the user maintains is not flagged, so the warning still means something.
    const clean = await doctor({ ...ctx, args: ['--node', '/usr/local/bin/node'] });
    assert.equal(clean.byId.node.status, 'pass', JSON.stringify(clean.byId.node));
  });
});

test('doctor checks EVERY registered client launcher, not just the first one it finds', async () => {
  await withDoctorFixture(async ({ entry, writeClaude, ctx, home }) => {
    // Claude Code points at a Node that is fine; Codex points at one inside its
    // own private directory. Checking only the first client would miss the second.
    await writeClaude({ mcpServers: { orca: entry } });
    const codexNode = path.join(home, '.codex', 'bin', 'node');
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    await fs.writeFile(path.join(home, '.codex', 'config.toml'), [
      '[mcp_servers.orca]',
      `command = ${JSON.stringify(codexNode)}`,
      `args = [${JSON.stringify(path.join(ROOT, 'src', 'mcp-server.js'))}]`,
      '',
    ].join('\n'));

    const run = await doctor(ctx);
    const launchers = run.report.checks.filter((check) => check.id.startsWith('launcher'));
    assert.equal(launchers.length, 2, `both clients are checked: ${JSON.stringify(run.report.checks.map((c) => c.id))}`);
    const codexCheck = launchers.find((check) => check.id.endsWith('codex'));
    assert.ok(codexCheck, 'the Codex launcher has its own check');
    assert.notEqual(codexCheck.status, 'pass', JSON.stringify(codexCheck));
    assert.match(String(codexCheck.summary + codexCheck.fix), /codex|Codex/, JSON.stringify(codexCheck));
  });
});
