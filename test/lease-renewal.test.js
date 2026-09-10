// Stage 5 lease lifecycle: requirements 1-4, at the registry and at the routes.
//
//   R1  an active agent never loses its lease (it slides while in use);
//   R2  an agent back after its lease lapsed gets a new one from the credential
//       in its client config, and keeps its orchestrator;
//   R3  two sessions sharing one client config never knock each other off;
//   R4  the credential in the client config is narrow: it can only obtain a lease
//       for its own role, actor and scope, it is not itself a tool lease, and it
//       is revocable, taking every lease it minted with it.
//
// Every case runs on temp state in a temp working directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { OrcaRegistry } from '../src/registry.js';
import { availableToolIdsForRole } from '../src/agent-tools/roles.js';
import { ROOT } from './helpers/bridge-client.js';

async function withIsolatedRegistry(fn) {
  const previousCwd = process.cwd();
  const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-lease-renewal-')));
  process.chdir(tempDir);
  const registry = new OrcaRegistry();
  try {
    return await fn(registry, tempDir);
  } finally {
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 25 });
  }
}

const record = (registry, id) => registry.toolLeases.find((item) => item.id === id);
const lapse = (registry, id) => { record(registry, id).expiresAt = new Date(Date.now() - 1000).toISOString(); };
// Registry refusals are thrown as plain { status, message } objects, which
// assert.throws cannot match with a bare RegExp.
const refused = (pattern) => (error) => error?.status === 401 && pattern.test(String(error?.message));

// How a session obtains a lease from its client config, the way Orca tells it to.
// With a refresh credential in the config, that is the credential exchange. A
// config without one (every config main emits) has only the documented manual
// recovery: mint another bootstrap with the same actor.
function obtainLeaseLikeASession(registry, configEnv, actor) {
  if (configEnv.ORCA_REFRESH_TOKEN) return registry.exchangeRefreshCredential(configEnv.ORCA_REFRESH_TOKEN);
  return registry.createOrchestratorMcpBootstrap({ actor });
}

test('R1: a lease in use slides forward instead of expiring on a fixed clock', async () => {
  await withIsolatedRegistry(async (registry) => {
    const { lease, leaseToken } = registry.createToolLease({
      role: 'orchestrator', actor: 'r1', allowedTools: ['orchestrator.list'], ttlMs: 60_000,
    });
    // 10 s left of a 60 s window: past half-life, so this use must renew it.
    record(registry, lease.id).expiresAt = new Date(Date.now() + 10_000).toISOString();
    const validated = registry.validateToolLease(leaseToken, { toolId: 'orchestrator.list' });
    const remaining = Date.parse(validated.expiresAt) - Date.now();
    assert.ok(remaining > 50_000, `a lease used with 10 s left must be renewed to its full 60 s window; ${remaining} ms remain`);
    assert.equal(Date.parse(record(registry, lease.id).expiresAt), Date.parse(validated.expiresAt), 'the renewal is on the stored lease, not only the returned copy');
  });
});

test('R1 guard: renewal is bounded, and a lapsed lease is not revived by presenting it', async () => {
  await withIsolatedRegistry(async (registry) => {
    const { lease, leaseToken } = registry.createToolLease({
      role: 'orchestrator', actor: 'r1-guard', allowedTools: ['orchestrator.list'], ttlMs: 60_000,
    });
    const minted = record(registry, lease.id).expiresAt;
    registry.validateToolLease(leaseToken, { toolId: 'orchestrator.list' });
    assert.equal(record(registry, lease.id).expiresAt, minted, 'a lease in the first half of its window is not rewritten on every call');
    lapse(registry, lease.id);
    assert.throws(() => registry.validateToolLease(leaseToken, { toolId: 'orchestrator.list' }), refused(/Tool lease has expired\./));
  });
});

test('R2: an agent back after its lease lapsed gets a new lease from its config credential and keeps its orchestrator', async () => {
  await withIsolatedRegistry(async (registry, cwd) => {
    const boot = registry.createOrchestratorMcpBootstrap({ actor: 'r2', ttlMs: 60_000 });
    const configEnv = boot.bootstrap.env;
    assert.ok(configEnv.ORCA_REFRESH_TOKEN, 'the client config must carry a refresh credential');

    const first = registry.exchangeRefreshCredential(configEnv.ORCA_REFRESH_TOKEN);
    const firstLease = registry.validateToolLease(first.leaseToken, { toolId: 'orchestrator.register' });
    const orchestrator = await registry.registerOrchestrator({ cwd, actor: firstLease.actor }, { leaseId: firstLease.ownerId });

    lapse(registry, first.lease.id);
    assert.throws(() => registry.validateToolLease(first.leaseToken, {}), refused(/Tool lease has expired\./));

    const second = registry.exchangeRefreshCredential(configEnv.ORCA_REFRESH_TOKEN);
    const secondLease = registry.validateToolLease(second.leaseToken, { toolId: 'executor.spawn' });
    assert.notEqual(secondLease.id, firstLease.id);
    assert.doesNotThrow(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.shutdown', sessionId: orchestrator.id, lease: secondLease }),
      'the new lease must still own the orchestrator the lapsed one registered',
    );
    const status = registry.orchestratorStatus(orchestrator.id, { leaseId: secondLease.ownerId });
    assert.equal(status.activeOrchestrator.active, true);
  });
});

test('R3: two sessions on one client config each get a lease, and re-minting never revokes the other', async () => {
  await withIsolatedRegistry(async (registry) => {
    const actor = 'shared-user-config';
    const configEnv = registry.createOrchestratorMcpBootstrap({ actor }).bootstrap.env;

    const sessionA = obtainLeaseLikeASession(registry, configEnv, actor);
    const sessionB = obtainLeaseLikeASession(registry, configEnv, actor);
    assert.equal(registry.validateToolLease(sessionA.leaseToken, { toolId: 'orchestrator.list' }).active, true,
      'session B obtaining its lease must not revoke session A');

    // B goes idle, lapses, and re-mints while A is still working.
    lapse(registry, sessionB.lease.id);
    const sessionB2 = obtainLeaseLikeASession(registry, configEnv, actor);
    assert.equal(registry.validateToolLease(sessionA.leaseToken, { toolId: 'orchestrator.list' }).active, true,
      'session B re-minting must not revoke session A');
    assert.equal(registry.validateToolLease(sessionB2.leaseToken, { toolId: 'orchestrator.list' }).active, true);
  });
});

test('R4: the credential stored in the client config is not itself a tool lease', async () => {
  await withIsolatedRegistry(async (registry) => {
    const { bootstrap } = registry.createOrchestratorMcpBootstrap({ actor: 'r4-config' });
    const stored = Object.entries(bootstrap.env).filter(([key]) => /TOKEN/.test(key));
    assert.ok(stored.length > 0, 'the config carries a credential');
    for (const [key, value] of stored) {
      assert.throws(
        () => registry.validateToolLease(value, { toolId: 'executor.spawn' }),
        (error) => error.status === 401,
        `${key} in the client config must not be usable as a tool lease`,
      );
    }
    assert.equal(bootstrap.env.ORCA_API_TOKEN, undefined, 'the config never carries the admin token');
  });
});

test('R4: a refresh credential obtains only its own role, actor, scope and tools', async () => {
  await withIsolatedRegistry(async (registry, cwd) => {
    const owner = await registry.registerOrchestrator({ cwd, actor: 'scope-owner' }, { leaseId: registry.createToolLease({ role: 'orchestrator', actor: 'scope-owner' }).lease.id });
    const boot = registry.createOrchestratorMcpBootstrap({ actor: 'r4-scope', projectId: owner.projectId, ttlMs: 60_000 });
    const minted = registry.exchangeRefreshCredential(boot.bootstrap.env.ORCA_REFRESH_TOKEN);
    assert.equal(minted.lease.role, 'orchestrator');
    assert.equal(minted.lease.actor, 'r4-scope');
    assert.equal(minted.lease.projectId, owner.projectId);
    assert.equal(minted.lease.parentId, boot.credential.id);
    assert.deepEqual([...minted.lease.allowedTools].sort(), [...availableToolIdsForRole('orchestrator')].sort());
    const window = Date.parse(minted.lease.expiresAt) - Date.parse(minted.lease.createdAt);
    assert.ok(Math.abs(window - 60_000) < 1000, `the lease gets the credential's window, not one the caller picks (${window} ms)`);
  });
});

test('R4: revoking the credential revokes every lease it minted and refuses new ones', async () => {
  await withIsolatedRegistry(async (registry) => {
    const boot = registry.createOrchestratorMcpBootstrap({ actor: 'r4-revoke' });
    const refreshToken = boot.bootstrap.env.ORCA_REFRESH_TOKEN;
    const a = registry.exchangeRefreshCredential(refreshToken);
    const b = registry.exchangeRefreshCredential(refreshToken);
    registry.revokeToolLease(boot.credential.id, { actor: 'test' });
    for (const minted of [a, b]) {
      assert.throws(() => registry.validateToolLease(minted.leaseToken, {}), refused(/Tool lease has been revoked\./));
    }
    assert.throws(() => registry.exchangeRefreshCredential(refreshToken), (error) => error.status === 401 && /revoked/.test(error.message));
  });
});

// ---- the same properties at the HTTP routes, on a daemon with an API token ----

let importCounter = 0;
async function withTokenServer(fn) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-lease-routes-')));
  process.chdir(tempDir);
  Object.assign(process.env, {
    ORCA_API_TOKEN: 'lease-routes-admin',
    ORCA_AUTO_AUDIT: 'false',
    ORCA_RATE_LIMIT_DISABLED: 'true',
    ORCA_REPO_ROOTS: tempDir,
    PORT: '0',
    ORCA_HOST: '127.0.0.1',
  });
  const moduleUrl = `${pathToFileURL(path.join(ROOT, 'src', 'server.js')).href}?lease-routes=${Date.now()}-${++importCounter}`;
  const { startServer, stopServer } = await import(moduleUrl);
  const server = await startServer(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', admin = false, headers = {}, body } = {}) => {
    const init = { method, headers: { accept: 'application/json', ...headers } };
    if (admin) init.headers['x-orca-token'] = process.env.ORCA_API_TOKEN;
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${route}`, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json, text };
  };
  try {
    await fn({ request, cwd: tempDir });
  } finally {
    await stopServer();
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('R4 (routes): a refresh credential opens only the refresh route; it never works as a lease or as admin', async () => {
  await withTokenServer(async ({ request }) => {
    const boot = await request('/api/mcp/orchestrator-bootstrap', { method: 'POST', admin: true, body: { actor: 'r4-routes', ttlMs: 60_000 } });
    assert.equal(boot.status, 201, boot.text);
    const refreshToken = boot.body.bootstrap.env.ORCA_REFRESH_TOKEN;
    assert.ok(refreshToken, 'bootstrap must issue a refresh credential');
    const asRefresh = { 'x-orca-refresh-token': refreshToken };

    const asLease = await request('/api/orchestrators', { headers: { 'x-orca-tool-lease': refreshToken } });
    assert.equal(asLease.status, 401, `refresh credential as a tool lease: ${asLease.text}`);
    for (const [method, route, body] of [
      ['POST', '/api/mcp/orchestrator-bootstrap', { actor: 'escalate' }],
      ['GET', '/api/agent-tools/leases', undefined],
      ['POST', '/api/agent-tools/leases', { role: 'dashboard' }],
      ['GET', '/api/orchestrators', undefined],
    ]) {
      const res = await request(route, { method, headers: asRefresh, body });
      assert.ok([401, 403].includes(res.status), `${method} ${route} with only a refresh credential answered ${res.status}`);
    }

    const none = await request('/api/agent-tools/leases/refresh', { method: 'POST', body: {} });
    assert.equal(none.status, 401);
    const wrong = await request('/api/agent-tools/leases/refresh', { method: 'POST', headers: { 'x-orca-refresh-token': 'not-a-credential' }, body: {} });
    assert.equal(wrong.status, 401);

    const minted = await request('/api/agent-tools/leases/refresh', {
      method: 'POST',
      headers: asRefresh,
      body: { role: 'dashboard', actor: 'someone-else', ttlMs: 86_400_000, allowedTools: ['fleet.emergency_stop'] },
    });
    assert.equal(minted.status, 201, minted.text);
    assert.equal(minted.body.lease.role, 'orchestrator');
    assert.equal(minted.body.lease.actor, 'r4-routes');
    assert.equal(minted.text.includes(refreshToken), false, 'the refresh response never echoes the credential');
    const listed = await request('/api/orchestrators', { headers: { 'x-orca-tool-lease': minted.body.leaseToken } });
    assert.equal(listed.status, 200, listed.text);

    const leases = await request('/api/agent-tools/leases?activeOnly=false', { admin: true });
    assert.equal(leases.text.includes(refreshToken), false, 'listing never shows the credential');
    assert.equal(/tokenHash/.test(leases.text), false);

    const revoked = await request(`/api/agent-tools/leases/${boot.body.credential.id}`, { method: 'DELETE', admin: true });
    assert.equal(revoked.status, 200, revoked.text);
    const afterLease = await request('/api/orchestrators', { headers: { 'x-orca-tool-lease': minted.body.leaseToken } });
    assert.equal(afterLease.status, 401);
    const afterRefresh = await request('/api/agent-tools/leases/refresh', { method: 'POST', headers: asRefresh, body: {} });
    assert.equal(afterRefresh.status, 401);
    assert.match(afterRefresh.body.error, /revoked/);
  });
});

test('the 500-lease cap never evicts a live refresh credential', async () => {
  await withIsolatedRegistry(async (registry) => {
    const { credential, refreshToken } = registry._issueRefreshCredential({ role: 'orchestrator', actor: 'cap-client' });
    const allowedTools = availableToolIdsForRole('orchestrator');
    for (let i = 0; i < 501; i += 1) {
      registry.createToolLease({ role: 'orchestrator', actor: `bulk-${i}`, allowedTools, ttlMs: 60 * 60 * 1000 });
    }
    assert.ok(record(registry, credential.id), 'lease volume evicted a live refresh credential');
    assert.equal(registry.exchangeRefreshCredential(refreshToken).lease.role, 'orchestrator');
    assert.ok(registry.toolLeases.filter((item) => item.kind !== 'refresh').length <= 500, 'the cap no longer bounds leases');
  });
});
