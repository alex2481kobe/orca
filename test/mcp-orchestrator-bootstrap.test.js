import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OrcaRegistry } from '../src/registry.js';
import { buildOrchestratorMcpConfigs, MCP_SERVER_PATH } from '../src/mcp-orchestrator-bootstrap.js';

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

test('builder offers a source-free global-install (orca-mcp) launcher variant', () => {
  const out = buildOrchestratorMcpConfigs({
    baseUrl: 'http://127.0.0.1:3000',
    leaseToken: 'lease-xyz',
    nodePath: '/usr/local/bin/node',
  });
  // Primary config uses absolute node+path (works for app bundle / source).
  assert.equal(out.clients.claudeDesktop.config.mcpServers.orca.command, '/usr/local/bin/node');
  // Global-install variant uses the PATH command with no absolute path — no Orca
  // source checkout needed.
  const g = out.globalInstall.claudeDesktop.config.mcpServers.orca;
  assert.equal(g.command, 'orca-mcp');
  assert.deepEqual(g.args, []);
  assert.equal(g.env.ORCA_ROLE, 'orchestrator');
  assert.match(out.globalInstall.codex.snippet, /command = "orca-mcp"/);
  assert.match(out.globalInstall.codex.snippet, /args = \[\]/);
  assert.ok(out.instructions.some((line) => /no Orca source checkout is required/i.test(line)));
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
  assert.match(claude, /^claude mcp add orca /);
  assert.match(claude, /-e ORCA_TOOL_LEASE_TOKEN=lease-xyz/);
  assert.match(claude, /-e ORCA_ROLE=orchestrator/);
  assert.match(claude, /-- \/usr\/local\/bin\/node /);
  const codex = out.clients.codexCli.command;
  assert.match(codex, /^codex mcp add orca /);
  assert.match(codex, /--env ORCA_AGENT_TOOLS_BASE_URL=http:\/\/127\.0\.0\.1:3000/);
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

test('registry mints an orchestrator lease whose token validates for orchestrator tools', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const result = registry.createOrchestratorMcpBootstrap({ actor: 'desktop-app' });
    assert.ok(result.leaseToken, 'returns the plaintext lease token once');
    assert.equal(result.lease.role, 'orchestrator');
    assert.ok(result.lease.allowedTools.length >= 30, 'grants the full orchestrator toolset');
    assert.equal(result.lease.projectId, null, 'unscoped lease works session/project-wide');

    // The minted token must validate for an orchestrator tool (e.g. lane.create).
    const validated = registry.validateToolLease(result.leaseToken, {
      toolId: 'lane.create',
      role: 'orchestrator',
    });
    assert.equal(validated.active, true);

    // It must NOT validate as an executor role.
    assert.throws(
      () => registry.validateToolLease(result.leaseToken, { role: 'executor' }),
      (err) => err.status === 403,
    );

    // Bootstrap config carries the same token and points at the real server.
    const env = result.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env;
    assert.equal(env.ORCA_TOOL_LEASE_TOKEN, result.leaseToken);
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

test('registry scopes the lease to a project/session when provided', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const project = registry.createProject({ name: 'Bootstrap Project' }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, { name: 'Bootstrap Session' }, { actor: 'test', approved: true });
    const result = registry.createOrchestratorMcpBootstrap({ projectId: project.id, sessionId: session.id });
    assert.equal(result.lease.projectId, project.id);
    assert.equal(result.lease.sessionId, session.id);
    const env = result.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env;
    assert.equal(env.ORCA_PROJECT_ID, project.id);
    assert.equal(env.ORCA_SESSION_ID, session.id);

    // A bad project id is rejected.
    assert.throws(
      () => registry.createOrchestratorMcpBootstrap({ projectId: 'nope' }),
      (err) => err.status === 404,
    );
  } finally {
    await cleanup();
  }
});

test('registry mints a supervisor MCP bootstrap with supervisor tool scope', async () => {
  const { registry, cleanup } = await withIsolatedRegistry();
  try {
    const result = registry.createOrchestratorMcpBootstrap({ role: 'supervisor', actor: 'desktop-app' });
    assert.ok(result.leaseToken, 'returns the plaintext supervisor lease token once');
    assert.equal(result.lease.role, 'supervisor');
    assert.ok(result.lease.allowedTools.includes('supervisor.overview'));
    assert.ok(result.lease.allowedTools.includes('session.supervisor_audit'));
    for (const id of [
      'lane.list',
      'lane.get',
      'approval.list',
      'evidence.list',
      'evidence.latest',
      'orchestrator.status',
    ]) {
      assert.equal(result.lease.allowedTools.includes(id), true, `supervisor lease includes ${id}`);
    }
    for (const id of [
      'session.plan.update',
      'session.create',
      'capacity.set_policy',
      'session.worktree_policy.update',
      'settings.update',
      'task.add',
      'task.bulk_add',
      'task.update',
      'task.delete',
      'lane.create',
      'orchestrator.enroll',
    ]) {
      assert.equal(result.lease.allowedTools.includes(id), false, `supervisor lease excludes ${id}`);
    }
    assert.equal(result.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env.ORCA_ROLE, 'supervisor');
    const validated = registry.validateToolLease(result.leaseToken, {
      role: 'supervisor',
      toolId: 'supervisor.overview',
    });
    assert.equal(validated.active, true);
    assert.throws(
      () => registry.validateToolLease(result.leaseToken, { role: 'orchestrator' }),
      (err) => err.status === 403,
    );
    assert.ok(registry.auditEvents.some((event) => event.type === 'supervisor_mcp_bootstrap_created'));
  } finally {
    await cleanup();
  }
});
