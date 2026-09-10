import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OrcaRegistry } from '../src/registry.js';
import { buildOrchestratorMcpConfigs, MCP_SERVER_PATH } from '../src/mcp-orchestrator-bootstrap.js';

// The runtime-layout tests build stand-in executables with a #!/bin/sh line.
const POSIX_ONLY = process.platform === 'win32' ? 'needs /bin/sh stand-in executables' : false;

async function withIsolatedRegistry() {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-mcp-bootstrap-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry();
  const cleanup = async () => {
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 25 });
  };
  return { registry, cleanup };
}

// v2 orchestrator-native helper: register an orchestrator RECORD keyed by cwd
// (the project is created implicitly). The orchestrator id (orc_...) is the lane
// container id used everywhere a scoping sessionId used to be.
async function makeOrchestratorContainer(registry, { actor = 'test', title = 'Orch' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor, title },
    { leaseId: lease.id },
  );
  return orchestrator;
}

async function writeExecutable(file, body, mode = 0o755) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  await fs.chmod(file, mode);
}

// A stand-in "node" that only answers --version, so a test can lay out any
// runtime (version directories, aliases, spaces) without installing Node.
const fakeNode = (file, version) => writeExecutable(file, `#!/bin/sh\necho ${version}\n`);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function activeLeaseIdsFor(registry, actor) {
  return registry.listToolLeases({ activeOnly: true })
    .filter((lease) => lease.kind !== 'refresh' && lease.role === 'orchestrator' && lease.actor === actor)
    .map((lease) => lease.id);
}

// Every string anywhere in the bootstrap output: commands, snippets, prose.
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => allStrings(item, out));
  return out;
}

async function withEnv(overrides, fn) {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('builder emits Claude Desktop JSON and Codex TOML pointing at the MCP server', () => {
  const out = buildOrchestratorMcpConfigs({
    baseUrl: 'http://127.0.0.1:3000',
    leaseToken: 'lease-xyz',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    nodePath: '/usr/local/bin/node',
  });

  // Claude Desktop shape: mcpServers.orca with command/args/env.
  const orca = out.clients.claudeDesktop.config.mcpServers.orca;
  assert.equal(orca.command, '/usr/local/bin/node');
  assert.deepEqual(orca.args, [MCP_SERVER_PATH]);
  assert.equal(orca.env.ORCA_ROLE, 'orchestrator');
  assert.equal(orca.env.ORCA_TOOL_LEASE_TOKEN, 'lease-xyz');
  assert.equal(orca.env.ORCA_AGENT_TOOLS_BASE_URL, 'http://127.0.0.1:3000');
  assert.equal(orca.env.ORCA_PROJECT_ID, 'proj-1');
  assert.equal(orca.env.ORCA_SESSION_ID, 'sess-1');

  // Codex TOML shape: tables + env with quoted values.
  const toml = out.clients.codex.snippet;
  assert.match(toml, /\[mcp_servers\.orca\]/);
  assert.match(toml, /command = "\/usr\/local\/bin\/node"/);
  assert.match(toml, /\[mcp_servers\.orca\.env\]/);
  assert.match(toml, /ORCA_TOOL_LEASE_TOKEN = "lease-xyz"/);
  assert.match(toml, /ORCA_ROLE = "orchestrator"/);

  // Dashboard URL (in-app browser path) and instructions are present.
  assert.equal(out.dashboardUrl, 'http://127.0.0.1:3000');
  assert.ok(out.instructions.length >= 2);
});

test('bootstrap never offers a launcher that needs orca-mcp on PATH', () => {
  const out = buildOrchestratorMcpConfigs({
    baseUrl: 'http://127.0.0.1:3000',
    leaseToken: 'lease-xyz',
    nodePath: '/usr/local/bin/node',
  });
  // orca-mcp resolves only after `npm link` in a checkout (the package is not
  // published), so a config launched through it cannot run as printed.
  assert.equal('globalInstall' in out, false, 'the PATH-launched globalInstall block is still emitted');
  assert.deepEqual(allStrings(out).filter((text) => text.includes('orca-mcp')), [], 'output still mentions orca-mcp');
  // Every client launches the absolute node + bundled bridge.
  assert.equal(out.clients.claudeDesktop.config.mcpServers.orca.command, '/usr/local/bin/node');
  assert.deepEqual(out.clients.claudeDesktop.config.mcpServers.orca.args, [MCP_SERVER_PATH]);
  assert.match(out.clients.codex.snippet, /command = "\/usr\/local\/bin\/node"/);
  // The package is private/unpublished: never tell users to `npm i -g orca`.
  assert.ok(!out.instructions.some((line) => /npm i -g orca/.test(line)), 'no fake npm i -g orca claim');
});

test('builder emits ready-to-run claude/codex "mcp add" CLI one-liners', () => {
  const out = buildOrchestratorMcpConfigs({
    baseUrl: 'http://127.0.0.1:3000',
    leaseToken: 'lease-xyz',
    projectId: 'p1',
    nodePath: '/usr/local/bin/node',
  });
  const claude = out.clients.claudeCli.command;
  assert.match(claude, /^claude mcp add -s user orca /);
  assert.match(claude, /-e ORCA_TOOL_LEASE_TOKEN=lease-xyz/);
  assert.match(claude, /-e ORCA_ROLE=orchestrator/);
  assert.match(claude, /-- \/usr\/local\/bin\/node /);
  const codex = out.clients.codexCli.command;
  assert.match(codex, /^codex mcp add orca /);
  assert.match(codex, /--env ORCA_AGENT_TOOLS_BASE_URL=http:\/\/127\.0\.0\.1:3000/);
});

test('every emitted Claude Code command registers at user scope; Codex commands carry no scope flag', () => {
  const out = buildOrchestratorMcpConfigs({
    baseUrl: 'http://127.0.0.1:3000',
    leaseToken: 'lease-xyz',
    nodePath: '/usr/local/bin/node',
  });
  const strings = allStrings(out);
  const claudeCommands = strings.filter((text) => /^claude mcp add\b/.test(text));
  const codexCommands = strings.filter((text) => /^codex mcp add\b/.test(text));
  assert.ok(claudeCommands.length > 0 && codexCommands.length > 0, 'found no emitted mcp add commands to check');
  // `claude mcp add` defaults to LOCAL scope: one directory, silently.
  for (const command of claudeCommands) {
    assert.match(command, /^claude mcp add -s user orca /, `local-scope Claude command emitted: ${command.slice(0, 60)}`);
  }
  for (const command of codexCommands) {
    assert.match(command, /^codex mcp add orca /);
    assert.doesNotMatch(command, /\s(?:-s|--scope)\b/, 'codex mcp add has no scope flag');
  }
});

test('emitted CLI commands survive a real shell, including paths with spaces and quotes', { skip: POSIX_ONLY }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-mcp-argv-'));
  try {
    const stubDir = path.join(dir, 'stub bin');
    const argvFile = path.join(dir, 'argv');
    // Stand-in claude/codex: record argv NUL-separated, exactly as the shell passed it.
    const stub = '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done > "$ARGV_OUT"\n';
    await writeExecutable(path.join(stubDir, 'claude'), stub);
    await writeExecutable(path.join(stubDir, 'codex'), stub);
    const nodePath = '/Applications/My Node/bin/node';
    const serverPath = "/Users/someone/Orca's Checkout/src/mcp-server.js";
    const out = buildOrchestratorMcpConfigs({
      baseUrl: 'http://127.0.0.1:3000',
      leaseToken: "lease 'xyz'",
      projectId: 'p1',
      nodePath,
      serverPath,
    });
    const argvOf = (command) => {
      const run = spawnSync('/bin/sh', ['-c', command], {
        env: { PATH: `${stubDir}:/usr/bin:/bin`, ARGV_OUT: argvFile },
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      return readFileSync(argvFile, 'utf8').split('\0').slice(0, -1);
    };
    const env = [
      'ORCA_AGENT_TOOLS_BASE_URL=http://127.0.0.1:3000',
      "ORCA_TOOL_LEASE_TOKEN=lease 'xyz'",
      'ORCA_ROLE=orchestrator',
      'ORCA_PROJECT_ID=p1',
    ];
    assert.deepEqual(argvOf(out.clients.claudeCli.command), [
      'mcp', 'add', '-s', 'user', 'orca', ...env.flatMap((entry) => ['-e', entry]), '--', nodePath, serverPath,
    ]);
    assert.deepEqual(argvOf(out.clients.codexCli.command), [
      'mcp', 'add', 'orca', ...env.flatMap((entry) => ['--env', entry]), '--', nodePath, serverPath,
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('bootstrap instructions carry no dead or self-contradicting setup steps', () => {
  const out = buildOrchestratorMcpConfigs({
    baseUrl: 'http://127.0.0.1:3000',
    leaseToken: 't',
    nodePath: '/usr/local/bin/node',
  });
  const prose = [...out.instructions, ...Object.values(out.clients).map((client) => client.merge || '')].join('\n');
  for (const dead of [/orca-mcp/, /npm link/, /globalInstall/, /insert "-s user"/i, /no --scope/i, /orchestrator__update/]) {
    assert.doesNotMatch(prose, dead);
  }
  assert.match(out.clients.claudeCli.merge, /user scope/i);
});

test('package.json exposes the orca-mcp standalone bin pointing at the MCP server', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const pkg = JSON.parse(await fs.readFile(path.join(here, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.bin && pkg.bin['orca-mcp'], 'orca-mcp bin declared');
  const target = path.join(here, '..', pkg.bin['orca-mcp']);
  const source = await fs.readFile(target, 'utf8');
  assert.match(source.split('\n')[0], /^#!.*node/, 'bin target has a node shebang so it runs standalone');
});

test('builder omits path-param env when unscoped', () => {
  const out = buildOrchestratorMcpConfigs({ baseUrl: 'http://127.0.0.1:3000', leaseToken: 't' });
  const env = out.clients.claudeDesktop.config.mcpServers.orca.env;
  assert.ok(!('ORCA_PROJECT_ID' in env));
  assert.ok(!('ORCA_SESSION_ID' in env));
});

test('TOML escapes backslashes and quotes in paths (Windows-safe)', () => {
  const out = buildOrchestratorMcpConfigs({
    baseUrl: 'http://127.0.0.1:3000',
    leaseToken: 't',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  });
  assert.match(out.clients.codex.snippet, /command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/);
});

test('builder rejects malformed launcher paths before emitting MCP snippets', () => {
  assert.throws(
    () => buildOrchestratorMcpConfigs({
      baseUrl: 'http://127.0.0.1:3000',
      leaseToken: 't',
      nodePath: '/usr/bin/node\n--eval=bad',
    }),
    (error) => error.status === 422 && /control characters/.test(error.message),
  );
  assert.throws(
    () => buildOrchestratorMcpConfigs({
      baseUrl: 'http://127.0.0.1:3000',
      leaseToken: 't',
      nodePath: 'node',
    }),
    (error) => error.status === 422 && /absolute executable path/.test(error.message),
  );
});

test('a bootstrap that fails validation leaves the previous lease active and mints nothing', { skip: POSIX_ONLY }, async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const root = process.cwd();
    const directory = path.join(root, 'a-directory');
    await fs.mkdir(directory);
    const notExecutable = path.join(root, 'plain', 'node');
    await writeExecutable(notExecutable, '#!/bin/sh\necho v22.0.0\n', 0o644);
    const notNode = path.join(root, 'not-node', 'node');
    await writeExecutable(notNode, '#!/bin/sh\necho hello\n');
    const tooOld = path.join(root, 'old', 'node');
    await fakeNode(tooOld, 'v16.20.2');
    const cases = [
      ['/usr/bin/node\n--eval=bad', /control characters/],
      ['node', /absolute executable path/],
      [path.join(root, 'no such dir', 'node'), /does not exist/],
      [directory, /is not a file/],
      [notExecutable, /is not executable/],
      [notNode, /did not report a Node\.js version/],
      [tooOld, /v16\.20\.2.*18\.18\.0/],
    ];

    const first = registry.createOrchestratorMcpBootstrap({ actor: 'same-client', nodePath: process.execPath });
    for (const [nodePath, message] of cases) {
      assert.throws(
        () => registry.createOrchestratorMcpBootstrap({ actor: 'same-client', nodePath }),
        (error) => error.status === 422 && message.test(error.message),
        `nodePath ${JSON.stringify(nodePath)} was not refused with ${message}`,
      );
      // Minting with this actor would revoke `first`. A refused bootstrap must not
      // have got that far: the working client's lease still validates, and no
      // orphan lease (whose token nobody ever received) was minted in its place.
      const still = registry.validateToolLease(first.leaseToken, { role: 'orchestrator', toolId: 'orchestrator.register' });
      assert.equal(still.active, true);
      assert.equal(registry.inspectAgentCredential(first.refreshToken).active, true, 'the working client\'s credential survives');
      assert.deepEqual(activeLeaseIdsFor(registry, 'same-client'), [first.lease.id], `after nodePath ${JSON.stringify(nodePath)}`);
    }
  } finally {
    await cleanup();
  }
});

test('a Node that crashes on --version is refused with the reason it crashed', { skip: POSIX_ONLY }, async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    // Shaped like a Homebrew node whose shared library an upgrade removed: dyld
    // prints the missing library and aborts before Node prints anything.
    const broken = path.join(process.cwd(), 'broken', 'node');
    await writeExecutable(broken, '#!/bin/sh\necho "dyld[1]: Library not loaded: /opt/homebrew/opt/llhttp/lib/libllhttp.9.3.dylib" >&2\nkill -ABRT $$\n');
    assert.throws(
      () => registry.createOrchestratorMcpBootstrap({ actor: 'broken-node', nodePath: broken }),
      (error) => error.status === 422
        && /did not report a Node\.js version/.test(error.message)
        && /SIGABRT/.test(error.message)
        && /Library not loaded/.test(error.message),
    );
    assert.deepEqual(activeLeaseIdsFor(registry, 'broken-node'), []);
  } finally {
    await cleanup();
  }
});

test('an explicitly selected Node alias is kept verbatim and follows its target deterministically', { skip: POSIX_ONLY }, async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const root = process.cwd();
    const versionNode = (version) => path.join(root, 'versions', version, 'bin', 'node');
    for (const version of ['v20.11.1', 'v22.3.0', 'v16.20.2']) await fakeNode(versionNode(version), version);
    const aliasDir = path.join(root, 'My Node Alias'); // a space, on purpose
    await fs.mkdir(aliasDir);
    const link = path.join(aliasDir, 'current');
    const repoint = async (version) => {
      await fs.rm(link, { force: true });
      await fs.symlink(path.join(root, 'versions', version), link);
    };
    const alias = path.join(link, 'bin', 'node');

    await repoint('v20.11.1');
    const first = registry.createOrchestratorMcpBootstrap({ actor: 'alias-client', nodePath: alias });
    assert.equal(first.bootstrap.nodePath, alias, 'the selected alias was replaced');
    assert.equal(first.bootstrap.clients.claudeDesktop.config.mcpServers.orca.command, alias);
    assert.match(first.bootstrap.clients.claudeCli.command, new RegExp(` -- '${escapeRegExp(alias)}' `));
    assert.ok(first.bootstrap.runtime, 'bootstrap does not report which Node runtime it selected');
    assert.equal(first.bootstrap.runtime.source, 'explicit');
    assert.equal(first.bootstrap.runtime.version, 'v20.11.1');
    assert.equal(first.bootstrap.runtime.realPath, realpathSync(versionNode('v20.11.1')));
    assert.deepEqual(first.bootstrap.runtime.warnings, []);

    // The alias moves: the config keeps naming the alias; the report names the new target.
    await repoint('v22.3.0');
    const second = registry.createOrchestratorMcpBootstrap({ actor: 'alias-client', nodePath: alias });
    assert.equal(second.bootstrap.nodePath, alias);
    assert.equal(second.bootstrap.runtime.version, 'v22.3.0');
    assert.equal(second.bootstrap.runtime.realPath, realpathSync(versionNode('v22.3.0')));

    // Moved to an unsupported Node, or to nothing: refused, and the working lease survives.
    await repoint('v16.20.2');
    assert.throws(
      () => registry.createOrchestratorMcpBootstrap({ actor: 'alias-client', nodePath: alias }),
      (error) => error.status === 422 && /v16\.20\.2/.test(error.message),
    );
    await repoint('gone');
    assert.throws(
      () => registry.createOrchestratorMcpBootstrap({ actor: 'alias-client', nodePath: alias }),
      (error) => error.status === 422 && /does not exist/.test(error.message),
    );
    assert.equal(registry.validateToolLease(second.leaseToken, { role: 'orchestrator' }).active, true);
    assert.deepEqual(activeLeaseIdsFor(registry, 'alias-client'), [second.lease.id]);
  } finally {
    await cleanup();
  }
});

test('with no nodePath, bootstrap prefers a PATH alias of the running Node over its version-pinned real path', { skip: POSIX_ONLY }, async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const root = process.cwd();
    const stableDir = path.join(root, 'stable bin');
    await fs.mkdir(stableDir);
    const alias = path.join(stableDir, 'node');
    await fs.symlink(process.execPath, alias);

    const viaAlias = await withEnv(
      { PATH: `${stableDir}${path.delimiter}${process.env.PATH}` },
      () => registry.createOrchestratorMcpBootstrap({ actor: 'default-a' }),
    );
    assert.equal(viaAlias.bootstrap.nodePath, alias, `emitted ${viaAlias.bootstrap.nodePath} instead of the PATH alias`);
    assert.equal(viaAlias.bootstrap.clients.claudeDesktop.config.mcpServers.orca.command, alias);
    assert.equal(viaAlias.bootstrap.runtime.source, 'path-alias');
    assert.equal(viaAlias.bootstrap.runtime.realPath, realpathSync(process.execPath));
    assert.equal(viaAlias.bootstrap.runtime.version, process.version);

    // No PATH entry resolves to the running Node: fall back to it, and say so.
    const emptyDir = path.join(root, 'empty');
    await fs.mkdir(emptyDir);
    const fallback = await withEnv({ PATH: emptyDir }, () => registry.createOrchestratorMcpBootstrap({ actor: 'default-b' }));
    assert.equal(fallback.bootstrap.nodePath, process.execPath);
    assert.equal(fallback.bootstrap.runtime.source, 'daemon-runtime');
  } finally {
    await cleanup();
  }
});

test("a version-pinned Node, or one inside another agent tool's directory, is honored with an explicit warning", { skip: POSIX_ONLY }, async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const root = process.cwd();
    const pinned = path.join(root, 'node-versions', 'v22.3.0', 'installation', 'bin', 'node');
    await fakeNode(pinned, 'v22.3.0');
    const pinnedOut = registry.createOrchestratorMcpBootstrap({ actor: 'warn-a', nodePath: pinned });
    assert.equal(pinnedOut.bootstrap.nodePath, pinned, 'an explicit choice is still honored');
    const pinnedWarnings = pinnedOut.bootstrap.runtime?.warnings || [];
    assert.ok(pinnedWarnings.some((line) => /v22\.3\.0/.test(line) && /version/i.test(line)), 'no pinned-version warning');
    assert.ok(pinnedOut.bootstrap.instructions.some((line) => pinnedWarnings.some((w) => line.includes(w))), 'the warning is not in the instructions');

    const fakeHome = path.join(root, 'home');
    const codexAlias = path.join(fakeHome, '.codex', 'fnm', 'aliases', 'default', 'bin', 'node');
    await fakeNode(codexAlias, 'v24.14.1');
    const codexOut = await withEnv({ HOME: fakeHome }, () => registry.createOrchestratorMcpBootstrap({ actor: 'warn-b', nodePath: codexAlias }));
    assert.equal(codexOut.bootstrap.nodePath, codexAlias);
    const codexWarnings = codexOut.bootstrap.runtime?.warnings || [];
    assert.ok(codexWarnings.some((line) => /Codex/.test(line)), 'no warning that Codex owns this Node');
    assert.ok(!codexWarnings.some((line) => /v24\.14\.1/.test(line)), 'an alias is not a pinned version');
  } finally {
    await cleanup();
  }
});

test('bootstrap output discloses its refresh credential, how leases renew, and that re-issuing for the same actor replaces it', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const first = registry.createOrchestratorMcpBootstrap({ actor: 'disclosed-client', ttlMs: 60 * 60 * 1000, nodePath: process.execPath });
    const text = first.bootstrap.instructions.join('\n');
    assert.ok(text.includes(first.credential.id), 'instructions do not name the credential this config carries');
    assert.match(text, /renews while you use it/);
    assert.match(text, /after 1 hour with no use it lapses/);
    assert.match(text, /never rewrite the config or restart the client/);
    assert.match(text, /actor "disclosed-client"[^\n]*replaces this credential/);
    assert.match(text, /orca-cli\.js'? doctor/);
    assert.deepEqual(first.bootstrap.leaseLifecycle, {
      leaseId: first.lease.id,
      actor: 'disclosed-client',
      expiresAt: first.lease.expiresAt,
      renewable: true,
      credentialId: first.credential.id,
      leaseTtlMs: 60 * 60 * 1000,
      credentialExpiresAt: first.credential.expiresAt,
      replacedCredentialIds: [],
      replacedLeaseIds: [],
    });

    const second = registry.createOrchestratorMcpBootstrap({ actor: 'disclosed-client', nodePath: process.execPath });
    assert.deepEqual(second.bootstrap.leaseLifecycle.replacedCredentialIds, [first.credential.id]);
    assert.deepEqual(second.bootstrap.leaseLifecycle.replacedLeaseIds, [first.lease.id]);
    assert.ok(
      second.bootstrap.instructions.some((line) => line.includes(first.credential.id) && line.includes(first.lease.id) && /revoked/.test(line)),
      'the replacement this bootstrap made is not disclosed',
    );

    // Replacement is per actor: another actor's bootstrap revokes nothing.
    const other = registry.createOrchestratorMcpBootstrap({ actor: 'other-client', nodePath: process.execPath });
    assert.deepEqual(other.bootstrap.leaseLifecycle.replacedLeaseIds, []);
    assert.deepEqual(other.bootstrap.leaseLifecycle.replacedCredentialIds, []);
    assert.equal(registry.validateToolLease(second.leaseToken, { role: 'orchestrator' }).active, true);
    assert.ok(registry.exchangeRefreshCredential(second.refreshToken).leaseToken, 'the replacing credential issues leases');
  } finally {
    await cleanup();
  }
});

test('registry mints an orchestrator lease whose token validates for orchestrator tools', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const result = registry.createOrchestratorMcpBootstrap({ actor: 'desktop-app' });
    assert.ok(result.leaseToken, 'returns the plaintext lease token once');
    assert.equal(result.lease.role, 'orchestrator');
    assert.ok(result.lease.allowedTools.length >= 20, 'grants the full orchestrator toolset');
    assert.equal(result.lease.projectId, null, 'unscoped lease works session/project-wide');

    // The minted token must validate for an orchestrator tool (e.g. executor.spawn).
    const validated = registry.validateToolLease(result.leaseToken, {
      toolId: 'executor.spawn',
      role: 'orchestrator',
    });
    assert.equal(validated.active, true);

    // It must NOT validate as an executor role.
    assert.throws(
      () => registry.validateToolLease(result.leaseToken, { role: 'executor' }),
      (err) => err.status === 403,
    );

    // The config carries the refresh credential, never the lease, and points at the real server.
    const env = result.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env;
    assert.equal(env.ORCA_REFRESH_TOKEN, result.refreshToken);
    assert.equal(env.ORCA_TOOL_LEASE_TOKEN, undefined);
    assert.match(env.ORCA_AGENT_TOOLS_BASE_URL, /^http:\/\/127\.0\.0\.1:/);

    // An audit event records the bootstrap issuance.
    const audits = registry.listAuditEvents
      ? registry.listAuditEvents()
      : (registry.getAuditEvents ? registry.getAuditEvents() : []);
    if (Array.isArray(audits)) {
      assert.ok(audits.some((e) => e.type === 'orchestrator_mcp_bootstrap_created'));
    }
  } finally {
    await cleanup();
  }
});

test('registry scopes the lease to a project/orchestrator container when provided', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    // v2: the orchestrator RECORD is the container a lease scopes to (sessionId is
    // the orc_ id); getSession resolves it. No standalone session records.
    const orchestrator = await makeOrchestratorContainer(registry, { title: 'Bootstrap Orch' });
    const result = registry.createOrchestratorMcpBootstrap({ projectId: orchestrator.projectId, sessionId: orchestrator.id });
    assert.equal(result.lease.projectId, orchestrator.projectId);
    assert.equal(result.lease.sessionId, orchestrator.id);
    const env = result.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env;
    assert.equal(env.ORCA_PROJECT_ID, orchestrator.projectId);
    assert.equal(env.ORCA_SESSION_ID, orchestrator.id);

    // A bad project id is rejected.
    assert.throws(
      () => registry.createOrchestratorMcpBootstrap({ projectId: 'nope' }),
      (err) => err.status === 404,
    );
  } finally {
    await cleanup();
  }
});

test('registry replaces duplicate external MCP bootstrap leases for the same chat scope', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const orchestrator = await makeOrchestratorContainer(registry, { title: 'Replacement Orch' });
    const project = { id: orchestrator.projectId };
    const session = { id: orchestrator.id };
    const firstOrchestrator = registry.createOrchestratorMcpBootstrap({
      role: 'orchestrator',
      actor: 'same-orchestrator-chat',
      projectId: project.id,
      sessionId: session.id,
    });
    const secondOrchestrator = registry.createOrchestratorMcpBootstrap({
      role: 'orchestrator',
      actor: 'same-orchestrator-chat',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.notEqual(firstOrchestrator.lease.id, secondOrchestrator.lease.id);
    assert.throws(
      () => registry.validateToolLease(firstOrchestrator.leaseToken, {
        role: 'orchestrator',
        toolId: 'orchestrator.register',
        projectId: project.id,
        sessionId: session.id,
      }),
      (error) => error.status === 401 && /revoked/i.test(error.message),
    );
    const activeOrchestrators = registry.listToolLeases({ activeOnly: true })
      .filter((lease) => lease.kind !== 'refresh' && lease.role === 'orchestrator' && lease.actor === 'same-orchestrator-chat');
    assert.deepEqual(activeOrchestrators.map((lease) => lease.id), [secondOrchestrator.lease.id]);

    // The effective-scope replacement path (a session-only reconnect superseded by
    // a full project+session reconnect for the same actor) is role-agnostic; prove
    // it with the orchestrator role now that supervisor is gone.
    const sessionOnly = registry.createOrchestratorMcpBootstrap({
      role: 'orchestrator',
      actor: 'same-effective-scope-chat',
      sessionId: session.id,
    });
    assert.equal(sessionOnly.lease.projectId, project.id);
    assert.equal(sessionOnly.lease.sessionId, session.id);
    const fullScopeReconnect = registry.createOrchestratorMcpBootstrap({
      role: 'orchestrator',
      actor: 'same-effective-scope-chat',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.notEqual(sessionOnly.lease.id, fullScopeReconnect.lease.id);
    assert.throws(
      () => registry.validateToolLease(sessionOnly.leaseToken, {
        role: 'orchestrator',
        toolId: 'orchestrator.status',
        projectId: project.id,
        sessionId: session.id,
      }),
      (error) => error.status === 401 && /revoked/i.test(error.message),
    );
    const effectiveScopeActive = registry.listToolLeases({ activeOnly: true })
      .filter((lease) => lease.kind !== 'refresh' && lease.role === 'orchestrator' && lease.actor === 'same-effective-scope-chat');
    assert.deepEqual(effectiveScopeActive.map((lease) => lease.id), [fullScopeReconnect.lease.id]);
    // Issuing the full-scope config replaced the session-only config's credential,
    // which revokes the lease it issued; the audit names that lease and why.
    assert.equal(registry.auditEvents.some((event) =>
      event.type === 'agent_tool_lease_revoked'
      && event.evidence?.leaseId === sessionOnly.lease.id
      && event.evidence?.reason === 'replaced_by_new_setup'), true);
  } finally {
    await cleanup();
  }
});


test('MCP bootstrap mints an orchestrator but refuses the removed supervisor role (422)', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const container = await makeOrchestratorContainer(registry, { title: 'Fable Beta Orch' });
    const project = { id: container.projectId };
    const session = { id: container.id };

    // The orchestrator bootstrap still works and mints a full orchestrator lease.
    const orchestrator = registry.createOrchestratorMcpBootstrap({
      role: 'orchestrator',
      actor: 'fable-agent',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.equal(orchestrator.lease.role, 'orchestrator');
    const orchestratorLease = registry.validateToolLease(orchestrator.leaseToken, {
      role: 'orchestrator',
      toolId: 'orchestrator.register',
      projectId: project.id,
      sessionId: session.id,
    });
    assert.equal(orchestratorLease.active, true);

    // supervisor was removed from ROLES in v2; the bootstrap tier only mints an
    // orchestrator. Asking for supervisor now fails closed with 422 (the role
    // check runs before any lease is created). Lock it in.
    assert.throws(
      () => registry.createOrchestratorMcpBootstrap({
        role: 'supervisor',
        actor: 'fable-agent',
        projectId: project.id,
        sessionId: session.id,
      }),
      (error) => error.status === 422 && /orchestrator/.test(error.message),
    );
  } finally {
    await cleanup();
  }
});
