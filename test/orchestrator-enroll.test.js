import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orch-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  try {
    return await callback(registry);
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function makeSession(registry) {
  const project = registry.createProject({ name: 'Orch Project' }, { actor: 'test', approved: true });
  const session = registry.createSession(project.id, { name: 'Orch Session', leader: 'mock' }, { actor: 'test', approved: true });
  return { project, session };
}

function makeLease(registry, session, actor) {
  const { lease } = registry.createToolLease({
    role: 'orchestrator',
    projectId: session.projectId,
    sessionId: session.id,
    allowedTools: ['orchestrator.enroll', 'orchestrator.resign', 'orchestrator.status'],
    actor,
  });
  return lease;
}

test('orchestrator: enroll claims ownership; status reflects the active owner', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const lease = makeLease(registry, session, 'claude-cli');
    assert.equal(registry.getActiveOrchestrator(session.id).active, false);
    const res = registry.enrollOrchestrator(session.id, { leaseId: lease.id, actor: lease.actor, source: 'mcp' });
    assert.equal(res.enrolled, true);
    const active = registry.getActiveOrchestrator(session.id);
    assert.equal(active.active, true);
    assert.equal(active.actor, 'claude-cli');
    assert.equal(active.leaseId, lease.id);
    const status = registry.orchestratorStatus(session.id);
    assert.equal(status.activeOrchestrator.active, true);
    assert.ok(typeof status.tree === 'string' && status.tree.includes('Orch Session'));
  });
});

test('orchestrator: a second chat is refused without takeover, then takes over', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const leaseA = makeLease(registry, session, 'chat-a');
    const leaseB = makeLease(registry, session, 'chat-b');
    registry.enrollOrchestrator(session.id, { leaseId: leaseA.id, actor: 'chat-a' });
    assert.throws(
      () => registry.enrollOrchestrator(session.id, { leaseId: leaseB.id, actor: 'chat-b' }),
      (e) => e.status === 409 && e.current && e.current.actor === 'chat-a',
    );
    const res = registry.enrollOrchestrator(session.id, { leaseId: leaseB.id, actor: 'chat-b', takeover: true });
    assert.equal(res.activeOrchestrator.actor, 'chat-b');
  });
});

test('orchestrator: resign requires being the holder and is idempotent', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const leaseA = makeLease(registry, session, 'chat-a');
    const leaseB = makeLease(registry, session, 'chat-b');
    registry.enrollOrchestrator(session.id, { leaseId: leaseA.id, actor: 'chat-a' });
    assert.throws(
      () => registry.resignOrchestrator(session.id, { leaseId: leaseB.id }),
      (e) => e.status === 403,
    );
    assert.equal(registry.resignOrchestrator(session.id, { leaseId: leaseA.id }).released, true);
    assert.equal(registry.getActiveOrchestrator(session.id).active, false);
    // Idempotent: resigning when none is held returns released:false.
    assert.equal(registry.resignOrchestrator(session.id, { leaseId: leaseA.id }).released, false);
  });
});

test('orchestrator: exclusive ownership refuses a non-owner mutating call', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const owner = makeLease(registry, session, 'owner-chat');
    const other = makeLease(registry, session, 'other-chat');
    // Give both leases the mutating tool so the refusal is about OWNERSHIP, not scope.
    registry.toolLeases.find((l) => l.id === owner.id).allowedTools.push('lane.create', 'task.list');
    registry.toolLeases.find((l) => l.id === other.id).allowedTools.push('lane.create', 'task.list');

    // No owner yet -> the external orchestrator must register before mutating.
    assert.throws(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: other }),
      (e) => e.status === 409 && /No active orchestrator/.test(e.message),
    );

    registry.enrollOrchestrator(session.id, { leaseId: owner.id, actor: 'owner-chat' });
    // Owner may mutate; non-owner is refused; reads + exempt tools always allowed.
    registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: owner });
    assert.throws(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: other }),
      (e) => e.status === 409 && /not the active orchestrator/.test(e.message),
    );
    registry.assertOrchestratorOwnership({ toolId: 'task.list', sessionId: session.id, lease: other }); // read ok
    registry.assertOrchestratorOwnership({ toolId: 'orchestrator.enroll', sessionId: session.id, lease: other }); // exempt

    // After the owner resigns, the other lease still has to enroll before mutating.
    registry.resignOrchestrator(session.id, { leaseId: owner.id });
    assert.throws(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: other }),
      (e) => e.status === 409 && /No active orchestrator/.test(e.message),
    );
    registry.enrollOrchestrator(session.id, { leaseId: other.id, actor: 'other-chat' });
    registry.assertOrchestratorOwnership({ toolId: 'lane.create', sessionId: session.id, lease: other });
  });
});

// Regression for P0.1: a register-path (Model-B) orchestrator owns its ownership
// through this.orchestrators, not a session-thread marker. getSession() returns a
// synthetic _orchestratorContainer view, so the ownership gate used to reject the
// OWNING lease with a 409 ("No active orchestrator...") on every mutating audit.*
// call. This drives the real HTTP surface end to end (register -> spawn -> audit
// -> accept) to prove the shipping orchestrator model can audit its own executor.
//
// The assertions check OUTCOMES (owner gets 200, a non-owning lease gets 409), not
// the marker mechanism, so they survive a future orchestrator-native refactor.
test('orchestrator (Model-B register path): owning lease may audit + accept its executor lane; a different lease is refused', async () => {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orch-modelb-'));
  const realTempDir = await fs.realpath(tempDir);
  const token = 'orch-modelb-test-token';
  let server = null;
  let stopServer = null;
  let base = '';

  process.chdir(realTempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_AUTO_AUDIT = 'false';
  process.env.ORCA_AUTO_COMPLETE_MS = '80';
  process.env.ORCA_REPO_ROOTS = realTempDir;

  const req = async (method, route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    return { status: response.status, body: data, text };
  };
  const admin = { 'x-orca-token': token };
  const withLease = (leaseToken) => ({ 'x-orca-tool-lease': leaseToken });

  try {
    const serverModule = await import('../src/server.js');
    server = await serverModule.startServer(0, '127.0.0.1');
    stopServer = serverModule.stopServer;
    base = `http://127.0.0.1:${server.address().port}`;

    // Two unscoped orchestrator leases (admin-gated). Both grant the full
    // orchestrator toolset, so any refusal below is about OWNERSHIP, not scope.
    const ownerLease = await req('POST', '/api/agent-tools/leases',
      { role: 'orchestrator', actor: 'chat-owner', ttlMs: 60_000 }, admin);
    assert.equal(ownerLease.status, 201, ownerLease.text);
    const ownerToken = ownerLease.body.leaseToken;
    assert.ok(ownerToken, 'owner lease token minted');

    const otherLease = await req('POST', '/api/agent-tools/leases',
      { role: 'orchestrator', actor: 'chat-other', ttlMs: 60_000 }, admin);
    assert.equal(otherLease.status, 201, otherLease.text);
    const otherToken = otherLease.body.leaseToken;

    // Register a Model-B orchestrator (implicitly creates the project keyed by cwd).
    const register = await req('POST', '/api/orchestrators',
      { cwd: realTempDir, actor: 'chat-owner', title: 'Model-B orch' }, withLease(ownerToken));
    assert.equal(register.status, 200, register.text);
    const orchestratorId = register.body.id;
    assert.ok(typeof orchestratorId === 'string' && orchestratorId.startsWith('orc_'), 'register returns an orc_ id');

    // Spawn an executor lane under the orchestrator: mock + approved + autoComplete
    // so the scheduler drives it to a terminal, auditable state on its own.
    const spawn = await req('POST', `/api/orchestrators/${orchestratorId}/executors`, {
      actor: 'chat-owner',
      approved: true,
      title: 'Model-B executor lane',
      role: 'executor',
      executorType: 'mock',
      taskPrompt: 'Reach done so the orchestrator can audit it.',
    }, withLease(ownerToken));
    assert.equal(spawn.status, 201, spawn.text);
    const laneId = spawn.body.id;

    // Wait for the lane to reach an auditable state (done / ready_for_audit).
    const deadline = Date.now() + 15_000;
    let laneState = null;
    while (Date.now() < deadline) {
      const laneGet = await req('GET', `/api/lanes/${laneId}`, undefined, admin);
      laneState = laneGet.body?.state;
      if (['done', 'ready_for_audit', 'failed', 'stopped'].includes(laneState)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(['done', 'ready_for_audit'].includes(laneState), `lane reached an auditable state (got ${laneState})`);

    // BUG REPRO GUARD: the OWNING register lease must be able to queue an audit.
    // Pre-fix this returned 409 "No active orchestrator is registered...".
    const queued = await req('POST', `/api/lanes/${laneId}/audit`,
      { actor: 'chat-owner' }, withLease(ownerToken));
    assert.equal(queued.status, 201, `owner audit.queue_one must succeed (was ${queued.status}: ${queued.text})`);

    // A DIFFERENT orchestrator lease that does NOT own the orchestrator is refused.
    // The lane is still 'done' here (queue_one doesn't change lane.state), so the
    // audit.accept state-gate passes and the 409 can ONLY be the ownership refusal.
    const refused = await req('POST', `/api/lanes/${laneId}/audit/accept`,
      { verdict: 'accepted', actor: 'chat-other' }, withLease(otherToken));
    assert.equal(refused.status, 409, `non-owning lease audit.accept must be refused (was ${refused.status}: ${refused.text})`);

    // The OWNING lease may accept.
    const accepted = await req('POST', `/api/lanes/${laneId}/audit/accept`,
      { verdict: 'accepted', actor: 'chat-owner' }, withLease(ownerToken));
    assert.equal(accepted.status, 200, `owner audit.accept must succeed (was ${accepted.status}: ${accepted.text})`);
  } finally {
    if (stopServer) await stopServer();
    if (server) await new Promise((resolve) => server.close(resolve));
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
  }
});

test('orchestrator: a stale active orchestrator does not block a fresh enroll', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const leaseA = makeLease(registry, session, 'chat-a');
    const leaseB = makeLease(registry, session, 'chat-b');
    registry.enrollOrchestrator(session.id, { leaseId: leaseA.id, actor: 'chat-a' });
    // Force staleness on the LIVE session record (createSession returns a clone).
    registry.getSession(session.id).orchestratorThread.activeOrchestrator.lastSeenAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.equal(registry.getActiveOrchestrator(session.id).stale, true);
    // Fresh enroll succeeds WITHOUT takeover because the holder is stale.
    const res = registry.enrollOrchestrator(session.id, { leaseId: leaseB.id, actor: 'chat-b' });
    assert.equal(res.activeOrchestrator.actor, 'chat-b');
  });
});

test('orchestrator: revoked or expired chat leases become stale and do not block fresh attach', async () => {
  await withRegistry(async (registry) => {
    const { session } = makeSession(registry);
    const revoked = makeLease(registry, session, 'revoked-chat');
    const replacement = makeLease(registry, session, 'replacement-chat');
    registry.enrollOrchestrator(session.id, { leaseId: revoked.id, actor: 'revoked-chat' });
    registry.revokeToolLease(revoked.id, { actor: 'test' });
    assert.equal(registry.getActiveOrchestrator(session.id).stale, true);
    const afterRevoked = registry.enrollOrchestrator(session.id, { leaseId: replacement.id, actor: 'replacement-chat' });
    assert.equal(afterRevoked.activeOrchestrator.actor, 'replacement-chat');

    const expiring = makeLease(registry, session, 'expired-chat');
    const afterExpiryReplacement = makeLease(registry, session, 'after-expiry-chat');
    registry.enrollOrchestrator(session.id, { leaseId: expiring.id, actor: 'expired-chat', takeover: true });
    const storedExpiring = registry.toolLeases.find((lease) => lease.id === expiring.id);
    storedExpiring.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(registry.getActiveOrchestrator(session.id).stale, true);
    const afterExpired = registry.enrollOrchestrator(session.id, {
      leaseId: afterExpiryReplacement.id,
      actor: 'after-expiry-chat',
    });
    assert.equal(afterExpired.activeOrchestrator.actor, 'after-expiry-chat');
  });
});
