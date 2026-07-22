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
      .filter((lease) => lease.role === 'orchestrator' && lease.actor === 'same-orchestrator-chat');
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
        toolId: 'session.next_action',
        projectId: project.id,
        sessionId: session.id,
      }),
      (error) => error.status === 401 && /revoked/i.test(error.message),
    );
    const effectiveScopeActive = registry.listToolLeases({ activeOnly: true })
      .filter((lease) => lease.role === 'orchestrator' && lease.actor === 'same-effective-scope-chat');
    assert.deepEqual(effectiveScopeActive.map((lease) => lease.id), [fullScopeReconnect.lease.id]);
    assert.equal(registry.auditEvents.some((event) =>
      event.type === 'agent_tool_lease_revoked'
      && event.evidence?.reason === 'replace_active_for_actor'), true);
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
