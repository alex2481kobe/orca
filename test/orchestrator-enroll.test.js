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

// v2 orchestrator-native helper: mint an orchestrator lease and register the
// orchestrator RECORD keyed by cwd (createProject is implicit). The orchestrator
// id (orc_...) IS the lane container id used everywhere a sessionId used to be.
async function makeOrchestrator(registry, { actor = 'test', title = 'Orch' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
}

// A bare orchestrator lease (no registration) for exercising ownership refusals.
function makeLease(registry, actor) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  return lease;
}

test('orchestrator: register claims ownership; status reflects the active owner', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator, lease } = await makeOrchestrator(registry, { actor: 'claude-cli', title: 'Orch Session' });
    const status = registry.orchestratorStatus(orchestrator.id);
    assert.equal(status.activeOrchestrator.active, true);
    assert.equal(status.activeOrchestrator.actor, 'claude-cli');
    assert.equal(status.activeOrchestrator.leaseId, lease.id);
    assert.equal(status.activeOrchestrator.stale, false);
    assert.ok(typeof status.tree === 'string' && status.tree.includes('Orch Session'));
  });
});

test('orchestrator: a non-owner is refused; a live holder cannot be taken over, but a resigned one can', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator, lease: ownerLease } = await makeOrchestrator(registry, { actor: 'chat-a' });
    const leaseB = makeLease(registry, 'chat-b');

    // A different orchestrator lease may not mutate the container it doesn't own.
    assert.throws(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.delete', sessionId: orchestrator.id, lease: leaseB }),
      (e) => e.status === 409 && /not the active orchestrator/.test(e.message),
    );

    // A live (non-stale) holder cannot be stolen via takeover.
    await assert.rejects(
      registry.registerOrchestrator(
        { cwd: process.cwd(), actor: 'chat-b', takeoverOrchestratorId: orchestrator.id },
        { leaseId: leaseB.id },
      ),
      (e) => e.status === 409 && /not eligible for takeover/.test(e.message),
    );

    // Once the holder resigns, the other lease may take over the SAME record.
    registry.resignOrchestrator(orchestrator.id, {}, { leaseId: ownerLease.id });
    const takenOver = await registry.registerOrchestrator(
      { cwd: process.cwd(), actor: 'chat-b', takeoverOrchestratorId: orchestrator.id },
      { leaseId: leaseB.id },
    );
    assert.equal(takenOver.id, orchestrator.id, 'takeover attaches to the existing record');
    assert.equal(takenOver.leaseId, leaseB.id, 'takeover rebinds the owning lease');

    // The new owner may now mutate.
    registry.assertOrchestratorOwnership({ toolId: 'lane.delete', sessionId: orchestrator.id, lease: leaseB });
  });
});

test('orchestrator: resign requires being the holder and is idempotent', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator, lease: ownerLease } = await makeOrchestrator(registry, { actor: 'chat-a' });
    const leaseB = makeLease(registry, 'chat-b');

    // A lease that does not own the orchestrator cannot resign it.
    assert.throws(
      () => registry.resignOrchestrator(orchestrator.id, {}, { leaseId: leaseB.id }),
      (e) => e.status === 403,
    );

    const resigned = registry.resignOrchestrator(orchestrator.id, {}, { leaseId: ownerLease.id });
    assert.ok(resigned.resignedAt, 'holder resign records resignedAt');
    assert.equal(registry.orchestratorStatus(orchestrator.id).activeOrchestrator.active, false);

    // Idempotent: resigning again with the owning lease does not throw.
    const resignedAgain = registry.resignOrchestrator(orchestrator.id, {}, { leaseId: ownerLease.id });
    assert.ok(resignedAgain.resignedAt);
    assert.equal(registry.orchestratorStatus(orchestrator.id).activeOrchestrator.active, false);
  });
});

test('orchestrator: exclusive ownership refuses a non-owner mutating call', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator, lease: owner } = await makeOrchestrator(registry, { actor: 'owner-chat' });
    const other = makeLease(registry, 'other-chat');

    // Owner may mutate; a non-owner is refused; reads + ownership-exempt tools
    // (register/resign/spawn) are always allowed regardless of ownership.
    registry.assertOrchestratorOwnership({ toolId: 'lane.delete', sessionId: orchestrator.id, lease: owner });
    assert.throws(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.delete', sessionId: orchestrator.id, lease: other }),
      (e) => e.status === 409 && /not the active orchestrator/.test(e.message),
    );
    registry.assertOrchestratorOwnership({ toolId: 'lane.list', sessionId: orchestrator.id, lease: other }); // read ok
    registry.assertOrchestratorOwnership({ toolId: 'orchestrator.register', sessionId: orchestrator.id, lease: other }); // exempt

    // After the owner resigns, the container has no active owner: the other lease
    // must register/take over before it can mutate.
    registry.resignOrchestrator(orchestrator.id, {}, { leaseId: owner.id });
    assert.throws(
      () => registry.assertOrchestratorOwnership({ toolId: 'lane.delete', sessionId: orchestrator.id, lease: other }),
      (e) => e.status === 409 && /No active orchestrator/.test(e.message),
    );
    const takenOver = await registry.registerOrchestrator(
      { cwd: process.cwd(), actor: 'other-chat', takeoverOrchestratorId: orchestrator.id },
      { leaseId: other.id },
    );
    assert.equal(takenOver.id, orchestrator.id);
    registry.assertOrchestratorOwnership({ toolId: 'lane.delete', sessionId: orchestrator.id, lease: other });
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
      { cwd: realTempDir, actor: 'chat-owner', title: 'Model-B orch', laneConcurrencyLimit: 4 }, withLease(ownerToken));
    assert.equal(register.status, 200, register.text);
    const orchestratorId = register.body.id;
    assert.ok(typeof orchestratorId === 'string' && orchestratorId.startsWith('orc_'), 'register returns an orc_ id');

    const raised = await req('POST', '/api/orchestrators',
      { cwd: realTempDir, actor: 'chat-owner', laneConcurrencyLimit: 8 }, withLease(ownerToken));
    assert.equal(raised.status, 200, raised.text);
    assert.equal(raised.body.id, orchestratorId, 're-registration updates the owned record, not a different container');
    assert.equal(raised.body.approvedCapacity, 8);
    assert.equal(raised.body.laneConcurrencyLimit, 8);

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
      { verdict: 'accepted', actor: 'chat-other', findings: ['reviewed'] }, withLease(otherToken));
    assert.equal(refused.status, 409, `non-owning lease audit.accept must be refused (was ${refused.status}: ${refused.text})`);

    // The OWNING lease may accept.
    const accepted = await req('POST', `/api/lanes/${laneId}/audit/accept`,
      { verdict: 'accepted', actor: 'chat-owner', findings: ['reviewed'] }, withLease(ownerToken));
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

test('orchestrator: an idle-stale holder is eligible for takeover without being the holder', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await makeOrchestrator(registry, { actor: 'chat-a' });
    const leaseB = makeLease(registry, 'chat-b');

    // Force idle staleness on the live orchestrator record (no live lane keeps it
    // pinned). orchestratorStatus surfaces stale=true.
    registry.orchestrators.find((o) => o.id === orchestrator.id).lastSeenAt =
      new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.equal(registry.orchestratorStatus(orchestrator.id).activeOrchestrator.stale, true);

    // A fresh lease may take over the stale holder's record (no takeover needed
    // beyond naming the stale orchestrator id).
    const takenOver = await registry.registerOrchestrator(
      { cwd: process.cwd(), actor: 'chat-b', takeoverOrchestratorId: orchestrator.id },
      { leaseId: leaseB.id },
    );
    assert.equal(takenOver.id, orchestrator.id);
    assert.equal(takenOver.leaseId, leaseB.id);
    assert.equal(registry.orchestratorStatus(orchestrator.id).activeOrchestrator.active, true);
  });
});

test('orchestrator: revoked or expired owning leases go stale and free the record for takeover', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator, lease: revoked } = await makeOrchestrator(registry, { actor: 'revoked-chat' });
    const replacement = makeLease(registry, 'replacement-chat');

    // A revoked owning lease makes the orchestrator stale.
    registry.revokeToolLease(revoked.id, { actor: 'test' });
    assert.equal(registry.orchestratorStatus(orchestrator.id).activeOrchestrator.stale, true);
    const afterRevoked = await registry.registerOrchestrator(
      { cwd: process.cwd(), actor: 'replacement-chat', takeoverOrchestratorId: orchestrator.id },
      { leaseId: replacement.id },
    );
    assert.equal(afterRevoked.leaseId, replacement.id);
    assert.equal(registry.orchestratorStatus(orchestrator.id).activeOrchestrator.stale, false);

    // An expired owning lease likewise frees the record for the next attach.
    const afterExpiryReplacement = makeLease(registry, 'after-expiry-chat');
    registry.toolLeases.find((lease) => lease.id === replacement.id).expiresAt =
      new Date(Date.now() - 1000).toISOString();
    assert.equal(registry.orchestratorStatus(orchestrator.id).activeOrchestrator.stale, true);
    const afterExpired = await registry.registerOrchestrator(
      { cwd: process.cwd(), actor: 'after-expiry-chat', takeoverOrchestratorId: orchestrator.id },
      { leaseId: afterExpiryReplacement.id },
    );
    assert.equal(afterExpired.leaseId, afterExpiryReplacement.id);
  });
});
